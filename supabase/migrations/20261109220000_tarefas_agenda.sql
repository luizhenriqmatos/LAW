-- =====================================================================
-- Prompt 5: quadro de tarefas (kanban), agenda interna e sincronização com o Google Agenda.
--
--  - quadro_coluna / tarefa / tarefa_comentario: kanban. Ordem persistida em `posicao`.
--  - compromisso: audiência, reunião etc. (a agenda também mostra prazos e tarefas com data).
--  - agenda_itens(): junta prazos + tarefas com data + compromissos, respeitando permissão por tela.
--    Tarefa com data JÁ É item da agenda (mesma linha): mudar a data em um lugar muda no outro.
--  - google_conexao: uma por (usuário, escritório). Tokens SEMPRE cifrados pelo app; nenhuma
--    policy para `authenticated` => token nunca chega ao navegador.
--  - google_evento: mapa item -> id do evento no Google (evita duplicar).
--  - agenda_sync_fila: "caixa de saída". Gatilhos enfileiram; o servidor processa (mão única LAW -> Google).
--  Segredo de justiça: item ligado a processo em segredo vai ao Google SEM título/descrição reais.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Validadores
-- ---------------------------------------------------------------------
create or replace function public.etiquetas_validas(p text[])
returns boolean
language sql immutable
as $$
  select p is not null
    and cardinality(p) <= 15
    and not exists (select 1 from unnest(p) e where e is null or length(btrim(e)) not between 1 and 30)
$$;

create or replace function public.checklist_valido(p jsonb)
returns boolean
language sql immutable
as $$
  select jsonb_typeof(p) = 'array'
    and jsonb_array_length(p) <= 50
    and not exists (
      select 1 from jsonb_array_elements(p) e
      where jsonb_typeof(e) <> 'object'
         or jsonb_typeof(e->'id') is distinct from 'string'
         or jsonb_typeof(e->'texto') is distinct from 'string'
         or length(btrim(e->>'texto')) not between 1 and 200
         or jsonb_typeof(e->'feito') is distinct from 'boolean'
    )
$$;

-- ---------------------------------------------------------------------
-- Tabelas do kanban
-- ---------------------------------------------------------------------
create table public.quadro_coluna (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  nome text not null check (length(btrim(nome)) between 1 and 40),
  posicao int not null,
  concluida boolean not null default false,
  criado_em timestamptz not null default now()
);
create index quadro_coluna_idx on public.quadro_coluna (escritorio_id, posicao);

create table public.tarefa (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  coluna_id uuid not null references public.quadro_coluna(id),
  titulo text not null check (length(btrim(titulo)) between 1 and 160),
  descricao text not null default '' check (length(descricao) <= 4000),
  responsavel_id uuid null references public.membro(id) on delete set null,
  data date null,
  processo_id uuid null references public.processo(id),
  cliente_id uuid null references public.cliente(id),
  posicao int not null default 0,
  etiquetas text[] not null default '{}' check (public.etiquetas_validas(etiquetas)),
  checklist jsonb not null default '[]'::jsonb check (public.checklist_valido(checklist)),
  concluida_em timestamptz null,
  criado_por uuid null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index tarefa_quadro_idx on public.tarefa (escritorio_id, coluna_id, posicao);
create index tarefa_data_idx on public.tarefa (escritorio_id, data) where data is not null;
create index tarefa_responsavel_idx on public.tarefa (responsavel_id);
create index tarefa_processo_idx on public.tarefa (processo_id);

create table public.tarefa_comentario (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  tarefa_id uuid not null references public.tarefa(id) on delete cascade,
  autor_id uuid null references public.membro(id) on delete set null,
  texto text not null check (length(btrim(texto)) between 1 and 2000),
  criado_em timestamptz not null default now()
);
create index tarefa_comentario_idx on public.tarefa_comentario (tarefa_id, criado_em);

create table public.compromisso (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  titulo text not null check (length(btrim(titulo)) between 1 and 160),
  tipo text not null default 'outro' check (tipo in ('audiencia','reuniao','outro')),
  inicio timestamptz not null,
  fim timestamptz not null,
  local text not null default '' check (length(local) <= 200),
  descricao text not null default '' check (length(descricao) <= 4000),
  processo_id uuid null references public.processo(id),
  responsavel_id uuid null references public.membro(id) on delete set null,
  criado_por uuid null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  check (fim >= inicio)
);
create index compromisso_idx on public.compromisso (escritorio_id, inicio);

-- ---------------------------------------------------------------------
-- Colunas padrão em todo escritório (novo e já existentes)
-- ---------------------------------------------------------------------
create or replace function public.criar_colunas_padrao()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.quadro_coluna (escritorio_id, nome, posicao, concluida) values
    (new.id, 'A fazer', 1, false),
    (new.id, 'Fazendo', 2, false),
    (new.id, 'Revisão', 3, false),
    (new.id, 'Feito', 4, true);
  return new;
end;
$$;
create trigger escritorio_colunas_padrao after insert on public.escritorio
  for each row execute function public.criar_colunas_padrao();

insert into public.quadro_coluna (escritorio_id, nome, posicao, concluida)
select e.id, c.nome, c.pos, c.concl
from public.escritorio e
cross join (values ('A fazer', 1, false), ('Fazendo', 2, false), ('Revisão', 3, false), ('Feito', 4, true)) as c(nome, pos, concl)
where not exists (select 1 from public.quadro_coluna q where q.escritorio_id = e.id);

-- ---------------------------------------------------------------------
-- Validação de vínculos (tudo do mesmo escritório; processo/cliente CONFIRMADOS)
-- ---------------------------------------------------------------------
create or replace function public.validar_tarefa()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.quadro_coluna c where c.id = new.coluna_id and c.escritorio_id = new.escritorio_id) then
    raise exception 'coluna_invalida' using errcode = '22023';
  end if;
  if new.responsavel_id is not null and not exists (
    select 1 from public.membro m where m.id = new.responsavel_id and m.escritorio_id = new.escritorio_id) then
    raise exception 'responsavel_invalido' using errcode = '22023';
  end if;
  if new.processo_id is not null and not exists (
    select 1 from public.processo p where p.id = new.processo_id and p.escritorio_id = new.escritorio_id and p.status = 'confirmado') then
    raise exception 'processo_nao_confirmado' using errcode = '22023';
  end if;
  if new.cliente_id is not null and not exists (
    select 1 from public.cliente c where c.id = new.cliente_id and c.escritorio_id = new.escritorio_id and c.status = 'confirmado') then
    raise exception 'cliente_nao_confirmado' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger tarefa_valida before insert or update on public.tarefa
  for each row execute function public.validar_tarefa();

create or replace function public.validar_compromisso()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.responsavel_id is not null and not exists (
    select 1 from public.membro m where m.id = new.responsavel_id and m.escritorio_id = new.escritorio_id) then
    raise exception 'responsavel_invalido' using errcode = '22023';
  end if;
  if new.processo_id is not null and not exists (
    select 1 from public.processo p where p.id = new.processo_id and p.escritorio_id = new.escritorio_id and p.status = 'confirmado') then
    raise exception 'processo_nao_confirmado' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger compromisso_valida before insert or update on public.compromisso
  for each row execute function public.validar_compromisso();

create trigger auditoria_compromisso after insert or update or delete on public.compromisso
  for each row execute function public.registrar_auditoria();

create or replace function public.carimbar_atualizacao()
returns trigger
language plpgsql
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;
create trigger tarefa_carimbo before update on public.tarefa for each row execute function public.carimbar_atualizacao();
create trigger compromisso_carimbo before update on public.compromisso for each row execute function public.carimbar_atualizacao();

-- ---------------------------------------------------------------------
-- Permissão
-- ---------------------------------------------------------------------
create or replace function public._exigir_tarefas(p_escritorio uuid)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '28000'; end if;
  if not public.pode_ver(p_escritorio, 'tarefas') then raise exception 'sem_permissao' using errcode = '42501'; end if;
end;
$$;

create or replace function public._exigir_agenda(p_escritorio uuid)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '28000'; end if;
  if not public.pode_ver(p_escritorio, 'agenda') then raise exception 'sem_permissao' using errcode = '42501'; end if;
end;
$$;

create or replace function public._meu_membro(p_escritorio uuid)
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select m.id from public.membro m where m.escritorio_id = p_escritorio and m.usuario_id = auth.uid()
$$;

-- Quem pode ser responsável por tarefa/compromisso: dono ou quem tem a tela Tarefas ou Agenda.
create or replace function public.responsaveis_tarefa(p_escritorio uuid)
returns table (id uuid, nome text, email text)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '28000'; end if;
  if not (public.pode_ver(p_escritorio, 'tarefas') or public.pode_ver(p_escritorio, 'agenda')) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  return query
    select m.id, m.nome, m.email from public.membro m
    where m.escritorio_id = p_escritorio
      and (m.papel = 'dono' or exists (
        select 1 from public.permissao_tela t where t.membro_id = m.id and t.modulo in ('tarefas','agenda')))
    order by m.nome, m.email;
end;
$$;

-- ---------------------------------------------------------------------
-- Colunas (só o dono cria, renomeia, reordena, remove)
-- ---------------------------------------------------------------------
create or replace function public._exigir_dono_coluna(p_coluna uuid)
returns uuid
language plpgsql stable security definer
set search_path = ''
as $$
declare v_esc uuid;
begin
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '28000'; end if;
  select escritorio_id into v_esc from public.quadro_coluna where id = p_coluna;
  if v_esc is null then raise exception 'coluna_invalida' using errcode = '22023'; end if;
  if not public.eh_dono(v_esc) then raise exception 'sem_permissao' using errcode = '42501'; end if;
  return v_esc;
end;
$$;

create or replace function public._renumerar_colunas(p_escritorio uuid)
returns void
language sql security definer
set search_path = ''
as $$
  update public.quadro_coluna c set posicao = o.n
  from (select id, row_number() over (order by posicao, criado_em, id) as n
        from public.quadro_coluna where escritorio_id = p_escritorio) o
  where c.id = o.id and c.posicao <> o.n
$$;

create or replace function public.coluna_criar(p_escritorio uuid, p_nome text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare v_id uuid; v_qtd int;
begin
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '28000'; end if;
  if not public.eh_dono(p_escritorio) then raise exception 'sem_permissao' using errcode = '42501'; end if;
  select count(*) into v_qtd from public.quadro_coluna where escritorio_id = p_escritorio;
  if v_qtd >= 12 then raise exception 'limite_colunas' using errcode = '22023'; end if;
  insert into public.quadro_coluna (escritorio_id, nome, posicao)
  values (p_escritorio, btrim(p_nome), v_qtd + 1) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.coluna_renomear(p_coluna uuid, p_nome text)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  perform public._exigir_dono_coluna(p_coluna);
  update public.quadro_coluna set nome = btrim(p_nome) where id = p_coluna;
end;
$$;

-- p_direcao: -1 sobe (esquerda), +1 desce (direita)
create or replace function public.coluna_mover(p_coluna uuid, p_direcao int)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare v_esc uuid; v_ids uuid[]; v_i int; v_j int; v_tmp uuid;
begin
  v_esc := public._exigir_dono_coluna(p_coluna);
  select array_agg(id order by posicao, criado_em, id) into v_ids from public.quadro_coluna where escritorio_id = v_esc;
  v_i := array_position(v_ids, p_coluna);
  v_j := v_i + case when p_direcao < 0 then -1 else 1 end;
  if v_j < 1 or v_j > array_length(v_ids, 1) then return; end if;
  v_tmp := v_ids[v_i]; v_ids[v_i] := v_ids[v_j]; v_ids[v_j] := v_tmp;
  update public.quadro_coluna c set posicao = o.n
  from unnest(v_ids) with ordinality as o(id, n)
  where c.id = o.id;
end;
$$;

-- Só remove coluna vazia, e nunca a última. Nada de tarefa some em silêncio.
create or replace function public.coluna_remover(p_coluna uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare v_esc uuid;
begin
  v_esc := public._exigir_dono_coluna(p_coluna);
  if exists (select 1 from public.tarefa where coluna_id = p_coluna) then
    raise exception 'coluna_com_tarefas' using errcode = '22023';
  end if;
  if (select count(*) from public.quadro_coluna where escritorio_id = v_esc) <= 1 then
    raise exception 'ultima_coluna' using errcode = '22023';
  end if;
  delete from public.quadro_coluna where id = p_coluna;
  perform public._renumerar_colunas(v_esc);
end;
$$;

-- ---------------------------------------------------------------------
-- Tarefas
-- ---------------------------------------------------------------------
create or replace function public._normalizar_etiquetas(p text[])
returns text[]
language sql immutable
as $$
  select coalesce(array_agg(t order by ord), '{}')
  from (
    select distinct on (lower(btrim(e))) btrim(e) as t, ord
    from unnest(coalesce(p, '{}')) with ordinality as x(e, ord)
    where e is not null and btrim(e) <> ''
    order by lower(btrim(e)), ord
  ) s
$$;

create or replace function public.tarefa_criar(
  p_escritorio uuid, p_coluna uuid, p_titulo text, p_descricao text, p_responsavel uuid,
  p_data date, p_processo uuid, p_cliente uuid, p_etiquetas text[]
) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare v_coluna uuid := p_coluna; v_id uuid; v_pos int; v_concl boolean;
begin
  perform public._exigir_tarefas(p_escritorio);
  if v_coluna is null then
    select id into v_coluna from public.quadro_coluna where escritorio_id = p_escritorio order by posicao limit 1;
  end if;
  select concluida into v_concl from public.quadro_coluna where id = v_coluna and escritorio_id = p_escritorio;
  if v_concl is null then raise exception 'coluna_invalida' using errcode = '22023'; end if;
  select coalesce(max(posicao), 0) + 1 into v_pos from public.tarefa where coluna_id = v_coluna;
  insert into public.tarefa (escritorio_id, coluna_id, titulo, descricao, responsavel_id, data, processo_id, cliente_id,
                             posicao, etiquetas, concluida_em, criado_por)
  values (p_escritorio, v_coluna, btrim(p_titulo), coalesce(p_descricao, ''), p_responsavel, p_data, p_processo, p_cliente,
          v_pos, public._normalizar_etiquetas(p_etiquetas), case when v_concl then now() end, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- p_dados: só as chaves enviadas mudam. Chaves: titulo, descricao, responsavel_id, data, processo_id,
-- cliente_id, etiquetas (lista de texto), checklist (lista de {id,texto,feito}).
create or replace function public.tarefa_atualizar(p_tarefa uuid, p_dados jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  t public.tarefa%rowtype;
  d jsonb := coalesce(p_dados, '{}'::jsonb);
begin
  select * into t from public.tarefa where id = p_tarefa for update;
  if not found then raise exception 'tarefa_invalida' using errcode = '22023'; end if;
  perform public._exigir_tarefas(t.escritorio_id);
  update public.tarefa set
    titulo = case when d ? 'titulo' then btrim(d->>'titulo') else titulo end,
    descricao = case when d ? 'descricao' then coalesce(d->>'descricao', '') else descricao end,
    responsavel_id = case when d ? 'responsavel_id' then nullif(d->>'responsavel_id', '')::uuid else responsavel_id end,
    data = case when d ? 'data' then nullif(d->>'data', '')::date else data end,
    processo_id = case when d ? 'processo_id' then nullif(d->>'processo_id', '')::uuid else processo_id end,
    cliente_id = case when d ? 'cliente_id' then nullif(d->>'cliente_id', '')::uuid else cliente_id end,
    etiquetas = case when d ? 'etiquetas'
      then public._normalizar_etiquetas(array(select jsonb_array_elements_text(d->'etiquetas'))) else etiquetas end,
    checklist = case when d ? 'checklist' then d->'checklist' else checklist end
  where id = p_tarefa;
end;
$$;

-- Move para a coluna p_coluna na posição p_indice (0 = topo). Reordena a coluna inteira (1..n).
create or replace function public.mover_tarefa(p_tarefa uuid, p_coluna uuid, p_indice int)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  t public.tarefa%rowtype;
  v_concl boolean;
  v_ids uuid[];
  v_idx int;
begin
  select * into t from public.tarefa where id = p_tarefa for update;
  if not found then raise exception 'tarefa_invalida' using errcode = '22023'; end if;
  perform public._exigir_tarefas(t.escritorio_id);
  select concluida into v_concl from public.quadro_coluna where id = p_coluna and escritorio_id = t.escritorio_id;
  if v_concl is null then raise exception 'coluna_invalida' using errcode = '22023'; end if;

  select coalesce(array_agg(id order by posicao, criado_em, id), '{}') into v_ids
  from public.tarefa where coluna_id = p_coluna and id <> p_tarefa;
  v_idx := greatest(0, least(coalesce(p_indice, 0), cardinality(v_ids)));
  v_ids := v_ids[1:v_idx] || p_tarefa || v_ids[v_idx + 1:cardinality(v_ids)];

  update public.tarefa set
    coluna_id = p_coluna,
    concluida_em = case when v_concl then coalesce(concluida_em, now()) else null end
  where id = p_tarefa;

  update public.tarefa x set posicao = o.n
  from unnest(v_ids) with ordinality as o(id, n)
  where x.id = o.id and x.posicao <> o.n;

  if t.coluna_id <> p_coluna then
    update public.tarefa x set posicao = o.n
    from (select id, row_number() over (order by posicao, criado_em, id) as n
          from public.tarefa where coluna_id = t.coluna_id) o
    where x.id = o.id and x.posicao <> o.n;
  end if;
end;
$$;

create or replace function public.apagar_tarefa(p_tarefa uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare t public.tarefa%rowtype;
begin
  select * into t from public.tarefa where id = p_tarefa for update;
  if not found then raise exception 'tarefa_invalida' using errcode = '22023'; end if;
  perform public._exigir_tarefas(t.escritorio_id);
  delete from public.tarefa where id = p_tarefa;
  update public.tarefa x set posicao = o.n
  from (select id, row_number() over (order by posicao, criado_em, id) as n
        from public.tarefa where coluna_id = t.coluna_id) o
  where x.id = o.id and x.posicao <> o.n;
end;
$$;

create or replace function public.comentar_tarefa(p_tarefa uuid, p_texto text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare t public.tarefa%rowtype; v_id uuid;
begin
  select * into t from public.tarefa where id = p_tarefa;
  if not found then raise exception 'tarefa_invalida' using errcode = '22023'; end if;
  perform public._exigir_tarefas(t.escritorio_id);
  insert into public.tarefa_comentario (escritorio_id, tarefa_id, autor_id, texto)
  values (t.escritorio_id, p_tarefa, public._meu_membro(t.escritorio_id), btrim(p_texto))
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Compromissos
-- ---------------------------------------------------------------------
create or replace function public.compromisso_criar(
  p_escritorio uuid, p_titulo text, p_tipo text, p_inicio timestamptz, p_fim timestamptz,
  p_local text, p_descricao text, p_processo uuid, p_responsavel uuid
) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  perform public._exigir_agenda(p_escritorio);
  insert into public.compromisso (escritorio_id, titulo, tipo, inicio, fim, local, descricao, processo_id, responsavel_id, criado_por)
  values (p_escritorio, btrim(p_titulo), p_tipo, p_inicio, coalesce(p_fim, p_inicio), coalesce(p_local, ''), coalesce(p_descricao, ''),
          p_processo, p_responsavel, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.compromisso_atualizar(p_compromisso uuid, p_dados jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare c public.compromisso%rowtype; d jsonb := coalesce(p_dados, '{}'::jsonb);
begin
  select * into c from public.compromisso where id = p_compromisso for update;
  if not found then raise exception 'compromisso_invalido' using errcode = '22023'; end if;
  perform public._exigir_agenda(c.escritorio_id);
  update public.compromisso set
    titulo = case when d ? 'titulo' then btrim(d->>'titulo') else titulo end,
    tipo = case when d ? 'tipo' then d->>'tipo' else tipo end,
    inicio = case when d ? 'inicio' then (d->>'inicio')::timestamptz else inicio end,
    fim = case when d ? 'fim' then (d->>'fim')::timestamptz else fim end,
    local = case when d ? 'local' then coalesce(d->>'local', '') else local end,
    descricao = case when d ? 'descricao' then coalesce(d->>'descricao', '') else descricao end,
    processo_id = case when d ? 'processo_id' then nullif(d->>'processo_id', '')::uuid else processo_id end,
    responsavel_id = case when d ? 'responsavel_id' then nullif(d->>'responsavel_id', '')::uuid else responsavel_id end
  where id = p_compromisso;
end;
$$;

create or replace function public.compromisso_apagar(p_compromisso uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare c public.compromisso%rowtype;
begin
  select * into c from public.compromisso where id = p_compromisso for update;
  if not found then raise exception 'compromisso_invalido' using errcode = '22023'; end if;
  perform public._exigir_agenda(c.escritorio_id);
  delete from public.compromisso where id = p_compromisso;
end;
$$;

-- ---------------------------------------------------------------------
-- Agenda interna: cada bloco só aparece se o usuário tem a tela correspondente.
-- Dia = dia de Brasília. Cancelados não aparecem.
-- ---------------------------------------------------------------------
create or replace function public.agenda_itens(p_escritorio uuid, p_de date, p_ate date)
returns table (
  tipo text, id uuid, titulo text, dia date, inicio timestamptz, fim timestamptz,
  responsavel_id uuid, processo_id uuid, numero_cnj text, status text, detalhe text
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '28000'; end if;
  if not public.eh_membro(p_escritorio) then raise exception 'sem_permissao' using errcode = '42501'; end if;
  if p_de is null or p_ate is null or p_ate < p_de or p_ate - p_de > 100 then
    raise exception 'periodo_invalido' using errcode = '22023';
  end if;

  if public.pode_ver(p_escritorio, 'tarefas') then
    return query
      select 'tarefa'::text, t.id, t.titulo, t.data, null::timestamptz, null::timestamptz,
             t.responsavel_id, t.processo_id, p.numero_cnj,
             case when t.concluida_em is not null then 'feita' else 'aberta' end,
             c.nome
      from public.tarefa t
      join public.quadro_coluna c on c.id = t.coluna_id
      left join public.processo p on p.id = t.processo_id
      where t.escritorio_id = p_escritorio and t.data between p_de and p_ate;
  end if;

  if public.pode_ver(p_escritorio, 'prazos') then
    return query
      select 'prazo'::text, z.id, z.descricao, z.data_final, null::timestamptz, null::timestamptz,
             z.responsavel_id, z.processo_id, p.numero_cnj, z.status, null::text
      from public.prazo z
      join public.processo p on p.id = z.processo_id
      where z.escritorio_id = p_escritorio and z.status <> 'cancelado' and z.data_final between p_de and p_ate;
  end if;

  if public.pode_ver(p_escritorio, 'agenda') then
    return query
      select 'compromisso'::text, k.id, k.titulo, (k.inicio at time zone 'America/Sao_Paulo')::date, k.inicio, k.fim,
             k.responsavel_id, k.processo_id, p.numero_cnj, k.tipo, k.local
      from public.compromisso k
      left join public.processo p on p.id = k.processo_id
      where k.escritorio_id = p_escritorio
        and (k.inicio at time zone 'America/Sao_Paulo')::date between p_de and p_ate;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Google: conexão por usuário, mapa de eventos e fila (caixa de saída)
-- ---------------------------------------------------------------------
create table public.google_conexao (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  usuario_id uuid not null references auth.users(id) on delete cascade,
  calendario_id text not null,
  calendario_nome text not null,
  refresh_token_cifrado text not null,
  access_token_cifrado text null,
  access_expira_em timestamptz null,
  status text not null default 'ativa' check (status in ('ativa','revogada','erro')),
  erro text null,
  ultimo_sync_em timestamptz null,
  criado_em timestamptz not null default now(),
  unique (usuario_id, escritorio_id)
);

create table public.google_evento (
  id uuid primary key default gen_random_uuid(),
  conexao_id uuid not null references public.google_conexao(id) on delete cascade,
  origem text not null check (origem in ('tarefa','prazo','compromisso')),
  origem_id uuid not null,
  google_event_id text not null,
  hash_conteudo text not null,
  atualizado_em timestamptz not null default now(),
  unique (conexao_id, origem, origem_id)
);

create table public.agenda_sync_fila (
  id bigint generated always as identity primary key,
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  origem text not null check (origem in ('tarefa','prazo','compromisso')),
  origem_id uuid not null,
  versao int not null default 1,
  tentativas int not null default 0,
  erro text null,
  proxima_tentativa timestamptz not null default now(),
  reservado_ate timestamptz null,
  processado_em timestamptz null,
  criado_em timestamptz not null default now()
);
create index agenda_sync_fila_pendente_idx on public.agenda_sync_fila (proxima_tentativa) where processado_em is null;
create unique index agenda_sync_fila_dedup_idx on public.agenda_sync_fila (origem, origem_id) where processado_em is null;

-- Aviso de "Google desconectado" usa a tabela de notificações.
alter table public.notificacao drop constraint notificacao_tipo_check;
alter table public.notificacao add constraint notificacao_tipo_check
  check (tipo in ('prazo_antes_3','prazo_dia','prazo_vencido','google'));

-- Enfileira só se existe alguma conexão ativa no escritório (sem custo para quem não usa Google).
create or replace function public._enfileirar_sync(p_escritorio uuid, p_origem text, p_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.google_conexao g where g.escritorio_id = p_escritorio and g.status = 'ativa') then
    insert into public.agenda_sync_fila (escritorio_id, origem, origem_id)
    values (p_escritorio, p_origem, p_id)
    on conflict (origem, origem_id) where processado_em is null
    do update set versao = public.agenda_sync_fila.versao + 1,
                  proxima_tentativa = least(public.agenda_sync_fila.proxima_tentativa, now());
  end if;
end;
$$;

create or replace function public.agenda_enfileirar()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_origem text := tg_table_name;
  v_ign text[] := array['posicao','atualizado_em','checklist','etiquetas','raciocinio','coluna_id','criado_em'];
  v_reg jsonb;
begin
  if tg_op = 'UPDATE' and (to_jsonb(new) - v_ign) is not distinct from (to_jsonb(old) - v_ign) then
    return new;
  end if;
  v_reg := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  perform public._enfileirar_sync((v_reg->>'escritorio_id')::uuid, v_origem, (v_reg->>'id')::uuid);
  return coalesce(new, old);
end;
$$;
create trigger tarefa_sync after insert or update or delete on public.tarefa
  for each row execute function public.agenda_enfileirar();
create trigger prazo_sync after insert or update or delete on public.prazo
  for each row execute function public.agenda_enfileirar();
create trigger compromisso_sync after insert or update or delete on public.compromisso
  for each row execute function public.agenda_enfileirar();

-- Processo virou (ou deixou de ser) segredo de justiça: reenvia os itens ligados a ele.
create or replace function public.agenda_processo_sigilo()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare r record;
begin
  if new.segredo_justica is distinct from old.segredo_justica then
    for r in select id from public.tarefa where processo_id = new.id loop
      perform public._enfileirar_sync(new.escritorio_id, 'tarefa', r.id);
    end loop;
    for r in select id from public.prazo where processo_id = new.id loop
      perform public._enfileirar_sync(new.escritorio_id, 'prazo', r.id);
    end loop;
    for r in select id from public.compromisso where processo_id = new.id loop
      perform public._enfileirar_sync(new.escritorio_id, 'compromisso', r.id);
    end loop;
  end if;
  return new;
end;
$$;
create trigger processo_sigilo_sync after update on public.processo
  for each row execute function public.agenda_processo_sigilo();

-- Saiu da equipe: a conexão com o Google dele sai junto (o LAW para de enviar e esquece os tokens).
create or replace function public.google_membro_removido()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  delete from public.google_conexao where usuario_id = old.usuario_id and escritorio_id = old.escritorio_id;
  return old;
end;
$$;
create trigger membro_google_removido after delete on public.membro
  for each row execute function public.google_membro_removido();

-- Estado da conexão do PRÓPRIO usuário (sem tokens).
create or replace function public.google_status(p_escritorio uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare g public.google_conexao%rowtype;
begin
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '28000'; end if;
  if not public.eh_membro(p_escritorio) then raise exception 'sem_permissao' using errcode = '42501'; end if;
  select * into g from public.google_conexao where escritorio_id = p_escritorio and usuario_id = auth.uid();
  if not found then return jsonb_build_object('conectado', false); end if;
  return jsonb_build_object('conectado', true, 'status', g.status, 'calendario', g.calendario_nome,
                            'erro', g.erro, 'ultimo_sync_em', g.ultimo_sync_em);
end;
$$;

-- ---------------------------------------------------------------------
-- Funções de serviço (só service_role): usadas pelo callback OAuth e pelo processador da fila.
-- ---------------------------------------------------------------------
create or replace function public.google_conexao_salvar(
  p_escritorio uuid, p_usuario uuid, p_calendario_id text, p_calendario_nome text,
  p_refresh_cifrado text, p_access_cifrado text, p_expira timestamptz
) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare v_id uuid; v_antigo text; r record;
begin
  if not exists (select 1 from public.membro m where m.escritorio_id = p_escritorio and m.usuario_id = p_usuario) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  select calendario_id into v_antigo from public.google_conexao where usuario_id = p_usuario and escritorio_id = p_escritorio;
  insert into public.google_conexao (escritorio_id, usuario_id, calendario_id, calendario_nome, refresh_token_cifrado,
                                     access_token_cifrado, access_expira_em, status, erro)
  values (p_escritorio, p_usuario, p_calendario_id, p_calendario_nome, p_refresh_cifrado, p_access_cifrado, p_expira, 'ativa', null)
  on conflict (usuario_id, escritorio_id) do update set
    calendario_id = excluded.calendario_id, calendario_nome = excluded.calendario_nome,
    refresh_token_cifrado = excluded.refresh_token_cifrado, access_token_cifrado = excluded.access_token_cifrado,
    access_expira_em = excluded.access_expira_em, status = 'ativa', erro = null
  returning id into v_id;
  -- Calendário novo = mapa de eventos antigo não vale mais.
  if v_antigo is not null and v_antigo <> p_calendario_id then
    delete from public.google_evento where conexao_id = v_id;
  end if;
  -- Primeira carga: enfileira o que já existe (o processador decide o que é "meu").
  for r in select id from public.tarefa where escritorio_id = p_escritorio and data is not null loop
    perform public._enfileirar_sync(p_escritorio, 'tarefa', r.id);
  end loop;
  for r in select id from public.prazo where escritorio_id = p_escritorio and status = 'aberto' loop
    perform public._enfileirar_sync(p_escritorio, 'prazo', r.id);
  end loop;
  for r in select id from public.compromisso where escritorio_id = p_escritorio and fim >= now() - interval '30 days' loop
    perform public._enfileirar_sync(p_escritorio, 'compromisso', r.id);
  end loop;
  return v_id;
end;
$$;

create or replace function public.google_conexao_obter(p_usuario uuid, p_escritorio uuid)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select to_jsonb(g) from public.google_conexao g where g.usuario_id = p_usuario and g.escritorio_id = p_escritorio
$$;

create or replace function public.google_conexao_remover(p_usuario uuid, p_escritorio uuid)
returns void
language sql security definer
set search_path = ''
as $$
  delete from public.google_conexao where usuario_id = p_usuario and escritorio_id = p_escritorio
$$;

create or replace function public.sync_pegar_fila(p_limite int)
returns table (id bigint, escritorio_id uuid, origem text, origem_id uuid, versao int)
language plpgsql security definer
set search_path = ''
as $$
begin
  return query
    with c as (
      select f.id from public.agenda_sync_fila f
      where f.processado_em is null and f.proxima_tentativa <= now()
        and (f.reservado_ate is null or f.reservado_ate < now())
      order by f.id
      limit greatest(1, least(p_limite, 200))
      for update skip locked
    )
    update public.agenda_sync_fila f set reservado_ate = now() + interval '5 minutes'
    from c where f.id = c.id
    returning f.id, f.escritorio_id, f.origem, f.origem_id, f.versao;
end;
$$;

create or replace function public.sync_concluir(p_fila bigint, p_versao int, p_erro text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare f public.agenda_sync_fila%rowtype;
begin
  select * into f from public.agenda_sync_fila where id = p_fila for update;
  if not found then return; end if;
  if p_erro is null then
    if f.versao <> p_versao then
      -- Mudou de novo enquanto processava: não encerra, roda outra vez já.
      update public.agenda_sync_fila set reservado_ate = null, proxima_tentativa = now() where id = p_fila;
    else
      update public.agenda_sync_fila set processado_em = now(), erro = null, reservado_ate = null where id = p_fila;
    end if;
  elsif f.tentativas + 1 >= 8 then
    update public.agenda_sync_fila set processado_em = now(), tentativas = f.tentativas + 1,
      erro = left(p_erro, 300), reservado_ate = null where id = p_fila;
  else
    update public.agenda_sync_fila set tentativas = f.tentativas + 1, erro = left(p_erro, 300), reservado_ate = null,
      proxima_tentativa = now() + make_interval(mins => least(power(2, f.tentativas + 1)::int, 240))
    where id = p_fila;
  end if;
end;
$$;

create or replace function public.sync_conexoes(p_escritorio uuid)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', g.id, 'usuario_id', g.usuario_id, 'calendario_id', g.calendario_id,
    'refresh_token_cifrado', g.refresh_token_cifrado, 'access_token_cifrado', g.access_token_cifrado,
    'access_expira_em', g.access_expira_em) order by g.criado_em), '[]'::jsonb)
  from public.google_conexao g
  where g.escritorio_id = p_escritorio and g.status = 'ativa'
$$;

create or replace function public.sync_conexao_tokens(p_conexao uuid, p_access_cifrado text, p_expira timestamptz)
returns void
language sql security definer
set search_path = ''
as $$
  update public.google_conexao set access_token_cifrado = p_access_cifrado, access_expira_em = p_expira where id = p_conexao
$$;

create or replace function public.sync_conexao_ok(p_conexao uuid)
returns void
language sql security definer
set search_path = ''
as $$
  update public.google_conexao set ultimo_sync_em = now(), erro = null where id = p_conexao and status = 'ativa'
$$;

-- Token revogado/expirado: para só ESTA conexão e avisa o usuário uma vez. O resto do sistema segue.
create or replace function public.sync_conexao_falhou(p_conexao uuid, p_status text, p_erro text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare g public.google_conexao%rowtype;
begin
  if p_status not in ('revogada','erro') then raise exception 'status_invalido' using errcode = '22023'; end if;
  select * into g from public.google_conexao where id = p_conexao for update;
  if not found or g.status <> 'ativa' then return; end if;
  update public.google_conexao set status = p_status, erro = left(p_erro, 300) where id = p_conexao;
  insert into public.notificacao (escritorio_id, usuario_id, tipo, titulo, corpo, link)
  values (g.escritorio_id, g.usuario_id, 'google',
          'Google Agenda desconectado',
          case when p_status = 'revogada'
            then 'O acesso ao seu Google Agenda foi revogado ou expirou. A sincronização parou. Reconecte na Agenda para voltar a enviar seus itens.'
            else 'A sincronização com o Google Agenda parou por um erro. Reconecte na Agenda para tentar de novo.' end,
          '/app/agenda');
end;
$$;

create or replace function public.sync_evento_obter(p_conexao uuid, p_origem text, p_origem_id uuid)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object('google_event_id', e.google_event_id, 'hash', e.hash_conteudo)
  from public.google_evento e where e.conexao_id = p_conexao and e.origem = p_origem and e.origem_id = p_origem_id
$$;

create or replace function public.sync_evento_salvar(p_conexao uuid, p_origem text, p_origem_id uuid, p_event_id text, p_hash text)
returns void
language sql security definer
set search_path = ''
as $$
  insert into public.google_evento (conexao_id, origem, origem_id, google_event_id, hash_conteudo)
  values (p_conexao, p_origem, p_origem_id, p_event_id, p_hash)
  on conflict (conexao_id, origem, origem_id)
  do update set google_event_id = excluded.google_event_id, hash_conteudo = excluded.hash_conteudo, atualizado_em = now()
$$;

create or replace function public.sync_evento_remover(p_conexao uuid, p_origem text, p_origem_id uuid)
returns void
language sql security definer
set search_path = ''
as $$
  delete from public.google_evento where conexao_id = p_conexao and origem = p_origem and origem_id = p_origem_id
$$;

-- Estado atual do item, já no formato que vai ao Google. NULL = item não existe mais.
-- `ativo` = deve existir no Google. `usuarios` = quem recebe (responsável; sem responsável, quem criou).
-- `restrito` = ligado a processo em segredo de justiça: título/descrição reais NÃO saem do LAW.
create or replace function public.sync_item(p_origem text, p_origem_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_t public.tarefa%rowtype; v_z public.prazo%rowtype; v_k public.compromisso%rowtype;
  v_proc public.processo%rowtype;
  v_resp_usuario uuid; v_criador uuid; v_feita boolean;
begin
  if p_origem = 'tarefa' then
    select * into v_t from public.tarefa where id = p_origem_id;
    if not found then return null; end if;
    select * into v_proc from public.processo where id = v_t.processo_id;
    select usuario_id into v_resp_usuario from public.membro where id = v_t.responsavel_id;
    select exists (select 1 from public.quadro_coluna c where c.id = v_t.coluna_id and c.concluida) into v_feita;
    return jsonb_build_object(
      'origem', 'tarefa', 'escritorio_id', v_t.escritorio_id,
      'ativo', v_t.data is not null,
      'usuarios', to_jsonb(array_remove(array[coalesce(v_resp_usuario, v_t.criado_por)], null)),
      'titulo', v_t.titulo, 'descricao', v_t.descricao, 'feita', v_feita,
      'dia_inteiro', true, 'data', v_t.data,
      'numero_cnj', v_proc.numero_cnj, 'restrito', coalesce(v_proc.segredo_justica, false));
  elsif p_origem = 'prazo' then
    select * into v_z from public.prazo where id = p_origem_id;
    if not found then return null; end if;
    select * into v_proc from public.processo where id = v_z.processo_id;
    select usuario_id into v_resp_usuario from public.membro where id = v_z.responsavel_id;
    return jsonb_build_object(
      'origem', 'prazo', 'escritorio_id', v_z.escritorio_id,
      'ativo', v_z.status = 'aberto',
      'usuarios', to_jsonb(array_remove(array[v_resp_usuario], null)),
      'titulo', v_z.descricao, 'descricao', 'Prazo sugerido. Confira no sistema oficial do tribunal.', 'feita', false,
      'dia_inteiro', true, 'data', v_z.data_final,
      'numero_cnj', v_proc.numero_cnj, 'restrito', coalesce(v_proc.segredo_justica, false));
  elsif p_origem = 'compromisso' then
    select * into v_k from public.compromisso where id = p_origem_id;
    if not found then return null; end if;
    select * into v_proc from public.processo where id = v_k.processo_id;
    select usuario_id into v_resp_usuario from public.membro where id = v_k.responsavel_id;
    return jsonb_build_object(
      'origem', 'compromisso', 'escritorio_id', v_k.escritorio_id, 'ativo', true,
      'usuarios', to_jsonb(array_remove(array[coalesce(v_resp_usuario, v_k.criado_por)], null)),
      'titulo', v_k.titulo, 'descricao', v_k.descricao, 'feita', false, 'tipo', v_k.tipo, 'local', v_k.local,
      'dia_inteiro', false, 'inicio', v_k.inicio, 'fim', v_k.fim,
      'numero_cnj', v_proc.numero_cnj, 'restrito', coalesce(v_proc.segredo_justica, false));
  end if;
  raise exception 'origem_invalida' using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------------
-- RLS e privilégios
-- ---------------------------------------------------------------------
alter table public.quadro_coluna enable row level security;
alter table public.tarefa enable row level security;
alter table public.tarefa_comentario enable row level security;
alter table public.compromisso enable row level security;
alter table public.google_conexao enable row level security;
alter table public.google_evento enable row level security;
alter table public.agenda_sync_fila enable row level security;

create policy coluna_select on public.quadro_coluna for select to authenticated
  using (public.pode_ver(escritorio_id, 'tarefas'));
create policy tarefa_select on public.tarefa for select to authenticated
  using (public.pode_ver(escritorio_id, 'tarefas'));
create policy tarefa_comentario_select on public.tarefa_comentario for select to authenticated
  using (public.pode_ver(escritorio_id, 'tarefas'));
create policy compromisso_select on public.compromisso for select to authenticated
  using (public.pode_ver(escritorio_id, 'agenda'));
-- google_conexao, google_evento, agenda_sync_fila: SEM policy para authenticated (só service_role/RPC).

revoke all on public.google_conexao, public.google_evento, public.agenda_sync_fila from anon, authenticated;
revoke all on public.quadro_coluna, public.tarefa, public.tarefa_comentario, public.compromisso from anon;
revoke insert, update, delete, truncate on public.quadro_coluna, public.tarefa, public.tarefa_comentario, public.compromisso from authenticated;

-- Funções internas / gatilhos: ninguém chama direto.
revoke execute on function public.etiquetas_validas(text[]) from public, anon;
revoke execute on function public.checklist_valido(jsonb) from public, anon;
revoke execute on function public.criar_colunas_padrao() from public, anon, authenticated;
revoke execute on function public.validar_tarefa() from public, anon, authenticated;
revoke execute on function public.validar_compromisso() from public, anon, authenticated;
revoke execute on function public.carimbar_atualizacao() from public, anon, authenticated;
revoke execute on function public._exigir_tarefas(uuid) from public, anon, authenticated;
revoke execute on function public._exigir_agenda(uuid) from public, anon, authenticated;
revoke execute on function public._meu_membro(uuid) from public, anon, authenticated;
revoke execute on function public._exigir_dono_coluna(uuid) from public, anon, authenticated;
revoke execute on function public._renumerar_colunas(uuid) from public, anon, authenticated;
revoke execute on function public._normalizar_etiquetas(text[]) from public, anon, authenticated;
revoke execute on function public._enfileirar_sync(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.agenda_enfileirar() from public, anon, authenticated;
revoke execute on function public.agenda_processo_sigilo() from public, anon, authenticated;
revoke execute on function public.google_membro_removido() from public, anon, authenticated;

-- RPCs do usuário logado.
revoke execute on function public.responsaveis_tarefa(uuid) from public, anon;
revoke execute on function public.coluna_criar(uuid, text) from public, anon;
revoke execute on function public.coluna_renomear(uuid, text) from public, anon;
revoke execute on function public.coluna_mover(uuid, int) from public, anon;
revoke execute on function public.coluna_remover(uuid) from public, anon;
revoke execute on function public.tarefa_criar(uuid, uuid, text, text, uuid, date, uuid, uuid, text[]) from public, anon;
revoke execute on function public.tarefa_atualizar(uuid, jsonb) from public, anon;
revoke execute on function public.mover_tarefa(uuid, uuid, int) from public, anon;
revoke execute on function public.apagar_tarefa(uuid) from public, anon;
revoke execute on function public.comentar_tarefa(uuid, text) from public, anon;
revoke execute on function public.compromisso_criar(uuid, text, text, timestamptz, timestamptz, text, text, uuid, uuid) from public, anon;
revoke execute on function public.compromisso_atualizar(uuid, jsonb) from public, anon;
revoke execute on function public.compromisso_apagar(uuid) from public, anon;
revoke execute on function public.agenda_itens(uuid, date, date) from public, anon;
revoke execute on function public.google_status(uuid) from public, anon;

-- Funções de serviço: só service_role.
revoke execute on function public.google_conexao_salvar(uuid, uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.google_conexao_obter(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.google_conexao_remover(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.sync_pegar_fila(int) from public, anon, authenticated;
revoke execute on function public.sync_concluir(bigint, int, text) from public, anon, authenticated;
revoke execute on function public.sync_conexoes(uuid) from public, anon, authenticated;
revoke execute on function public.sync_conexao_tokens(uuid, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.sync_conexao_ok(uuid) from public, anon, authenticated;
revoke execute on function public.sync_conexao_falhou(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.sync_evento_obter(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.sync_evento_salvar(uuid, text, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.sync_evento_remover(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.sync_item(text, uuid) from public, anon, authenticated;

grant execute on function public.responsaveis_tarefa(uuid), public.coluna_criar(uuid, text), public.coluna_renomear(uuid, text),
  public.coluna_mover(uuid, int), public.coluna_remover(uuid),
  public.tarefa_criar(uuid, uuid, text, text, uuid, date, uuid, uuid, text[]), public.tarefa_atualizar(uuid, jsonb),
  public.mover_tarefa(uuid, uuid, int), public.apagar_tarefa(uuid), public.comentar_tarefa(uuid, text),
  public.compromisso_criar(uuid, text, text, timestamptz, timestamptz, text, text, uuid, uuid),
  public.compromisso_atualizar(uuid, jsonb), public.compromisso_apagar(uuid),
  public.agenda_itens(uuid, date, date), public.google_status(uuid) to authenticated;

grant execute on function public.google_conexao_salvar(uuid, uuid, text, text, text, text, timestamptz),
  public.google_conexao_obter(uuid, uuid), public.google_conexao_remover(uuid, uuid), public.sync_pegar_fila(int),
  public.sync_concluir(bigint, int, text), public.sync_conexoes(uuid), public.sync_conexao_tokens(uuid, text, timestamptz),
  public.sync_conexao_ok(uuid), public.sync_conexao_falhou(uuid, text, text), public.sync_evento_obter(uuid, text, uuid),
  public.sync_evento_salvar(uuid, text, uuid, text, text), public.sync_evento_remover(uuid, text, uuid),
  public.sync_item(text, uuid) to service_role;
