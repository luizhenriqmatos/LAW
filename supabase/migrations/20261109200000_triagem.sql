-- =====================================================================
-- Prompt 3 — Triagem: transforma publicações capturadas em processos e clientes, com revisão humana.
--
-- Regras:
--  - Publicação com nº CNJ que o escritório ainda não tem → PROCESSO PROVISÓRIO + CLIENTES PROVISÓRIOS (das partes).
--  - Publicação de processo confirmado → ligada sozinha (entra na linha do tempo).
--  - Publicação sem nº CNJ → fila "Publicações sem processo" (ligar manualmente ou descartar).
--  - Provisório não entra em relatório, financeiro nem portal: use as views *_confirmado e o gatilho do lançamento.
--  - Descartar não apaga: marca a data e pode ser restaurado por 30 dias.
--  - O app nunca grava direto nessas tabelas: tudo passa por funções que conferem a permissão "processos".
-- =====================================================================

-- ---------------------------------------------------------------------
-- Funções de apoio (puras)
-- ---------------------------------------------------------------------

-- Nome para comparação: sem acento, minúsculo, só letras/números separados por um espaço.
create or replace function public.normalizar_nome(p_nome text)
returns text
language sql immutable
set search_path = ''
as $$
  select btrim(regexp_replace(
    lower(translate(coalesce(p_nome, ''),
      'ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñÝýÿ',
      'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNnYyy')),
    '[^a-z0-9]+', ' ', 'g'))
$$;

-- CPF com dígitos verificadores (só números). Mesma regra de cpfValido() no app.
create or replace function public.cpf_valido(cpf text)
returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  soma int; resto int; d1 int; d2 int; i int;
begin
  if cpf is null or cpf !~ '^\d{11}$' or cpf ~ '^(\d)\1{10}$' then
    return false;
  end if;
  soma := 0;
  for i in 1..9 loop soma := soma + substr(cpf, i, 1)::int * (11 - i); end loop;
  resto := (soma * 10) % 11; d1 := case when resto = 10 then 0 else resto end;
  soma := 0;
  for i in 1..10 loop soma := soma + substr(cpf, i, 1)::int * (12 - i); end loop;
  resto := (soma * 10) % 11; d2 := case when resto = 10 then 0 else resto end;
  return d1 = substr(cpf, 10, 1)::int and d2 = substr(cpf, 11, 1)::int;
end;
$$;

-- CPF (11) ou CNPJ (14). Nulo é aceito (documento é opcional).
create or replace function public.documento_valido(doc text)
returns boolean
language sql immutable
set search_path = ''
as $$
  select doc is null
    or (length(doc) = 11 and public.cpf_valido(doc))
    or (length(doc) = 14 and public.cnpj_valido(doc))
$$;

-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------

create table public.cliente (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  nome text not null check (length(btrim(nome)) between 2 and 200),
  nome_normalizado text generated always as (public.normalizar_nome(nome)) stored,
  tipo_pessoa text null check (tipo_pessoa in ('fisica','juridica')),
  documento text null check (public.documento_valido(documento)),
  email text null check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  telefone text null check (telefone is null or telefone ~ '^\d{10,13}$'),
  status text not null default 'provisorio' check (status in ('provisorio','confirmado','mesclado','descartado')),
  origem text not null default 'captura' check (origem in ('captura','manual')),
  mesclado_em uuid null references public.cliente(id),
  confirmado_em timestamptz null,
  confirmado_por uuid null,
  descartado_em timestamptz null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  check ((status = 'descartado') = (descartado_em is not null)),
  check ((status = 'mesclado') = (mesclado_em is not null))
);
create index cliente_fila_idx on public.cliente (escritorio_id, status, criado_em desc);
create index cliente_nome_idx on public.cliente (escritorio_id, nome_normalizado);
-- Um CPF/CNPJ só pode pertencer a um cliente confirmado por escritório.
create unique index cliente_documento_unico on public.cliente (escritorio_id, documento)
  where status = 'confirmado' and documento is not null;

create table public.processo (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  numero_cnj text not null check (numero_cnj ~ '^\d{20}$'),
  titulo text null check (titulo is null or length(titulo) <= 160),
  tribunal text null,
  classe text null,
  orgao_julgador text null,
  assuntos text[] not null default '{}',
  area text null check (area is null or length(area) <= 60),
  data_ajuizamento date null,
  segredo_justica boolean not null default false,
  status text not null default 'provisorio' check (status in ('provisorio','confirmado','descartado')),
  origem text not null default 'captura' check (origem in ('captura','manual')),
  confirmado_em timestamptz null,
  confirmado_por uuid null,
  descartado_em timestamptz null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (escritorio_id, numero_cnj),
  check ((status = 'descartado') = (descartado_em is not null))
);
create index processo_fila_idx on public.processo (escritorio_id, status, criado_em desc);

create table public.processo_parte (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  processo_id uuid not null references public.processo(id) on delete cascade,
  nome text not null check (length(btrim(nome)) between 2 and 200),
  nome_normalizado text generated always as (public.normalizar_nome(nome)) stored,
  polo text not null check (polo in ('ativo','passivo','terceiro','outro')),
  cliente_id uuid null references public.cliente(id),
  criado_em timestamptz not null default now()
);
create unique index processo_parte_unica on public.processo_parte (processo_id, nome_normalizado);
create index processo_parte_cliente_idx on public.processo_parte (cliente_id);
create index processo_parte_nome_idx on public.processo_parte (escritorio_id, nome_normalizado);

-- Publicação: ligação com o processo e lixeira de 30 dias.
alter table public.publicacao drop constraint publicacao_status_triagem_check;
alter table public.publicacao
  add column processo_id uuid null references public.processo(id) on delete set null,
  add column descartada_em timestamptz null,
  add column status_antes_descarte text null;
-- pendente: acabou de chegar | aguardando: ligada a processo provisório | vinculada: ligada a processo confirmado
alter table public.publicacao add constraint publicacao_status_triagem_check
  check (status_triagem in ('pendente','aguardando','vinculada','sem_processo','descartada'));
alter table public.publicacao add constraint publicacao_vinculo_coerente check (
  (status_triagem in ('aguardando','vinculada') and processo_id is not null)
  or (status_triagem in ('pendente','sem_processo') and processo_id is null)
  or (status_triagem = 'descartada' and descartada_em is not null)
);
create index publicacao_processo_idx on public.publicacao (processo_id, data_disponibilizacao desc);

-- Financeiro: lançamento pode apontar para processo/cliente, mas nunca provisório.
alter table public.lancamento
  add column processo_id uuid null references public.processo(id),
  add column cliente_id uuid null references public.cliente(id);

create or replace function public.exigir_vinculo_confirmado()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.processo_id is not null and not exists (
    select 1 from public.processo p where p.id = new.processo_id and p.escritorio_id = new.escritorio_id and p.status = 'confirmado'
  ) then
    raise exception 'vinculo_provisorio' using errcode = '22023';
  end if;
  if new.cliente_id is not null and not exists (
    select 1 from public.cliente c where c.id = new.cliente_id and c.escritorio_id = new.escritorio_id and c.status = 'confirmado'
  ) then
    raise exception 'vinculo_provisorio' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger lancamento_so_confirmado before insert or update on public.lancamento
  for each row execute function public.exigir_vinculo_confirmado();

-- Só confirmados: base para relatórios, financeiro e portal do cliente (Prompts 7 e 9).
-- security_invoker: a view respeita a RLS de quem consulta.
create view public.processo_confirmado with (security_invoker = true) as
  select * from public.processo where status = 'confirmado';
create view public.cliente_confirmado with (security_invoker = true) as
  select * from public.cliente where status = 'confirmado';

-- Auditoria (cliente e processo são obrigatórios pelo CLAUDE.md).
create trigger auditoria_cliente after insert or update or delete on public.cliente
  for each row execute function public.registrar_auditoria();
create trigger auditoria_processo after insert or update or delete on public.processo
  for each row execute function public.registrar_auditoria();
create trigger auditoria_processo_parte after insert or update or delete on public.processo_parte
  for each row execute function public.registrar_auditoria();

-- ---------------------------------------------------------------------
-- Triagem automática (chamada pelo job de captura, papel service_role)
-- ---------------------------------------------------------------------

-- Grava as partes de uma publicação no processo. Em processo provisório, cria (ou reaproveita) cliente provisório.
create or replace function public._registrar_partes(p_escritorio uuid, p_processo uuid, p_destinatarios jsonb, p_criar_clientes boolean)
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_d record;
  v_nome text;
  v_norm text;
  v_polo text;
  v_cliente uuid;
  v_criados int := 0;
begin
  for v_d in
    select x.nome, x.polo from jsonb_to_recordset(
      case when jsonb_typeof(p_destinatarios) = 'array' then p_destinatarios else '[]'::jsonb end
    ) as x(nome text, polo text)
  loop
    v_nome := left(btrim(regexp_replace(coalesce(v_d.nome, ''), '\s+', ' ', 'g')), 200);
    v_norm := public.normalizar_nome(v_nome);
    continue when length(v_nome) < 2 or v_norm = '';
    continue when exists (select 1 from public.processo_parte pp where pp.processo_id = p_processo and pp.nome_normalizado = v_norm);

    v_polo := case upper(coalesce(v_d.polo, '')) when 'A' then 'ativo' when 'P' then 'passivo' when 'T' then 'terceiro' else 'outro' end;
    v_cliente := null;
    if p_criar_clientes then
      -- Reaproveita cliente provisório com o mesmo nome (mesma pessoa em dois processos novos).
      select c.id into v_cliente from public.cliente c
      where c.escritorio_id = p_escritorio and c.status = 'provisorio' and c.nome_normalizado = v_norm
      order by c.criado_em limit 1;
      if v_cliente is null then
        insert into public.cliente (escritorio_id, nome) values (p_escritorio, v_nome) returning id into v_cliente;
        v_criados := v_criados + 1;
      end if;
    end if;
    insert into public.processo_parte (escritorio_id, processo_id, nome, polo, cliente_id)
    values (p_escritorio, p_processo, v_nome, v_polo, v_cliente);
  end loop;
  return v_criados;
end;
$$;

create or replace function public.triar_publicacoes(p_escritorio uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_pub record;
  v_proc public.processo;
  v_meta jsonb;
  v_novos int := 0;
  v_reabertos int := 0;
  v_clientes int := 0;
  v_ligadas int := 0;
  v_aguardando int := 0;
  v_sem int := 0;
begin
  for v_pub in
    select p.id, p.numero_cnj, p.tribunal, p.classe, p.orgao, p.destinatarios
    from public.publicacao p
    where p.escritorio_id = p_escritorio and p.status_triagem = 'pendente'
    order by p.data_disponibilizacao, p.capturada_em
    for update
  loop
    if v_pub.numero_cnj is null then
      update public.publicacao set status_triagem = 'sem_processo' where id = v_pub.id;
      v_sem := v_sem + 1;
      continue;
    end if;

    v_meta := (select m.dados from public.processo_metadados m where m.escritorio_id = p_escritorio and m.numero_cnj = v_pub.numero_cnj);
    v_proc := null;
    select * into v_proc from public.processo where escritorio_id = p_escritorio and numero_cnj = v_pub.numero_cnj for update;

    if v_proc.id is null then
      insert into public.processo (escritorio_id, numero_cnj, tribunal, classe, orgao_julgador, assuntos, data_ajuizamento, segredo_justica)
      values (
        p_escritorio, v_pub.numero_cnj,
        coalesce(v_meta->>'tribunal', v_pub.tribunal),
        coalesce(v_meta->'classe'->>'nome', v_pub.classe),
        coalesce(v_meta->>'orgaoJulgador', v_pub.orgao),
        coalesce((select array_agg(a->>'nome') from jsonb_array_elements(case when jsonb_typeof(v_meta->'assuntos') = 'array' then v_meta->'assuntos' else '[]'::jsonb end) a where a->>'nome' is not null), '{}'),
        case when v_meta->>'dataAjuizamento' ~ '^\d{4}-\d{2}-\d{2}' then left(v_meta->>'dataAjuizamento', 10)::date end,
        coalesce((v_meta->>'nivelSigilo') ~ '^[1-9]', false)
      )
      returning * into v_proc;
      v_novos := v_novos + 1;
    elsif v_proc.status = 'descartado' then
      -- Publicação nova de processo descartado volta para a fila: nunca escondemos publicação nova.
      -- Os clientes que saíram junto com ele (mesmo carimbo de descarte) voltam também.
      update public.cliente c set status = 'provisorio', descartado_em = null, atualizado_em = now()
        where c.status = 'descartado' and c.descartado_em = v_proc.descartado_em
          and exists (select 1 from public.processo_parte pp where pp.cliente_id = c.id and pp.processo_id = v_proc.id);
      update public.processo set status = 'provisorio', descartado_em = null, atualizado_em = now()
      where id = v_proc.id returning * into v_proc;
      v_reabertos := v_reabertos + 1;
    elsif v_proc.status = 'provisorio' then
      -- Completa o que estava vazio (o DataJud pode ter respondido só agora).
      update public.processo set
        tribunal = coalesce(tribunal, v_meta->>'tribunal', v_pub.tribunal),
        classe = coalesce(classe, v_meta->'classe'->>'nome', v_pub.classe),
        orgao_julgador = coalesce(orgao_julgador, v_meta->>'orgaoJulgador', v_pub.orgao),
        segredo_justica = segredo_justica or coalesce((v_meta->>'nivelSigilo') ~ '^[1-9]', false)
      where id = v_proc.id returning * into v_proc;
    end if;

    v_clientes := v_clientes + public._registrar_partes(p_escritorio, v_proc.id, v_pub.destinatarios, v_proc.status = 'provisorio');

    update public.publicacao
      set processo_id = v_proc.id,
          status_triagem = case when v_proc.status = 'confirmado' then 'vinculada' else 'aguardando' end
      where id = v_pub.id;
    if v_proc.status = 'confirmado' then v_ligadas := v_ligadas + 1; else v_aguardando := v_aguardando + 1; end if;
  end loop;

  return jsonb_build_object(
    'processos_novos', v_novos, 'processos_reabertos', v_reabertos, 'clientes_novos', v_clientes,
    'ligadas', v_ligadas, 'aguardando', v_aguardando, 'sem_processo', v_sem
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Ações do usuário (sempre conferem a permissão "processos")
-- ---------------------------------------------------------------------

create or replace function public._exigir_processos(p_escritorio uuid)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'nao_autenticado' using errcode = '28000';
  end if;
  if not public.pode_ver(p_escritorio, 'processos') then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
end;
$$;

-- Aplica edições vindas do formulário "editar e confirmar". Só mexe nos campos enviados.
create or replace function public._aplicar_dados_processo(p_processo uuid, p_dados jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  d jsonb := coalesce(p_dados, '{}'::jsonb);
begin
  update public.processo set
    titulo = case when d ? 'titulo' then nullif(btrim(d->>'titulo'), '') else titulo end,
    area = case when d ? 'area' then nullif(btrim(d->>'area'), '') else area end,
    classe = case when d ? 'classe' then nullif(btrim(d->>'classe'), '') else classe end,
    orgao_julgador = case when d ? 'orgao_julgador' then nullif(btrim(d->>'orgao_julgador'), '') else orgao_julgador end,
    segredo_justica = case when d ? 'segredo_justica' then coalesce((d->>'segredo_justica')::boolean, false) else segredo_justica end,
    atualizado_em = now()
  where id = p_processo;
end;
$$;

create or replace function public.confirmar_processo(p_processo uuid, p_dados jsonb default '{}'::jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.processo;
begin
  select * into v from public.processo where id = p_processo for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_processos(v.escritorio_id);
  if v.status <> 'provisorio' then raise exception 'nao_provisorio' using errcode = '22023'; end if;
  perform public._aplicar_dados_processo(p_processo, p_dados);
  update public.processo set status = 'confirmado', confirmado_em = now(), confirmado_por = auth.uid(), atualizado_em = now()
  where id = p_processo;
  update public.publicacao set status_triagem = 'vinculada' where processo_id = p_processo and status_triagem = 'aguardando';
end;
$$;

-- Ação em lote. Tudo ou nada: se um falhar (ex.: sem permissão), nenhum é confirmado.
create or replace function public.confirmar_processos(p_ids uuid[])
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_n int := 0;
begin
  foreach v_id in array coalesce(p_ids, '{}') loop
    perform public.confirmar_processo(v_id, '{}'::jsonb);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

create or replace function public.descartar_processo(p_processo uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.processo;
begin
  select * into v from public.processo where id = p_processo for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_processos(v.escritorio_id);
  if v.status <> 'provisorio' then raise exception 'nao_provisorio' using errcode = '22023'; end if;

  update public.processo set status = 'descartado', descartado_em = now(), atualizado_em = now() where id = p_processo;
  -- As publicações dele saem da fila junto (mesmo carimbo de data, para restaurar junto).
  update public.publicacao
    set status_antes_descarte = status_triagem, status_triagem = 'descartada', descartada_em = now()
    where processo_id = p_processo and status_triagem <> 'descartada';
  -- Clientes provisórios que só existiam por causa deste processo também saem.
  update public.cliente c set status = 'descartado', descartado_em = now(), atualizado_em = now()
    where c.status = 'provisorio'
      and exists (select 1 from public.processo_parte pp where pp.cliente_id = c.id and pp.processo_id = p_processo)
      and not exists (
        select 1 from public.processo_parte pp join public.processo pr on pr.id = pp.processo_id
        where pp.cliente_id = c.id and pr.id <> p_processo and pr.status <> 'descartado'
      );
end;
$$;

create or replace function public.restaurar_processo(p_processo uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.processo;
begin
  select * into v from public.processo where id = p_processo for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_processos(v.escritorio_id);
  if v.status <> 'descartado' then raise exception 'nao_descartado' using errcode = '22023'; end if;
  if v.descartado_em < now() - interval '30 days' then raise exception 'prazo_restauracao_vencido' using errcode = '22023'; end if;

  update public.processo set status = 'provisorio', descartado_em = null, atualizado_em = now() where id = p_processo;
  update public.publicacao
    set status_triagem = 'aguardando', -- o processo voltou a ser provisório
        status_antes_descarte = null, descartada_em = null
    where processo_id = p_processo and status_triagem = 'descartada' and descartada_em = v.descartado_em;
  update public.cliente c set status = 'provisorio', descartado_em = null, atualizado_em = now()
    where c.status = 'descartado' and c.descartado_em = v.descartado_em
      and exists (select 1 from public.processo_parte pp where pp.cliente_id = c.id and pp.processo_id = p_processo);
end;
$$;

-- Clientes ------------------------------------------------------------

create or replace function public._aplicar_dados_cliente(p_cliente uuid, p_dados jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  d jsonb := coalesce(p_dados, '{}'::jsonb);
  v_doc text;
begin
  if d ? 'nome' and length(btrim(coalesce(d->>'nome', ''))) < 2 then
    raise exception 'nome_invalido' using errcode = '22023';
  end if;
  if d ? 'documento' then
    v_doc := nullif(regexp_replace(coalesce(d->>'documento', ''), '\D', '', 'g'), '');
    if not public.documento_valido(v_doc) then raise exception 'documento_invalido' using errcode = '22023'; end if;
  end if;
  update public.cliente set
    nome = case when d ? 'nome' then left(btrim(regexp_replace(d->>'nome', '\s+', ' ', 'g')), 200) else nome end,
    documento = case when d ? 'documento' then v_doc else documento end,
    tipo_pessoa = case
      when d ? 'documento' and v_doc is not null then case when length(v_doc) = 11 then 'fisica' else 'juridica' end
      when d ? 'tipo_pessoa' then nullif(d->>'tipo_pessoa', '')
      else tipo_pessoa end,
    email = case when d ? 'email' then nullif(lower(btrim(d->>'email')), '') else email end,
    telefone = case when d ? 'telefone' then nullif(regexp_replace(coalesce(d->>'telefone', ''), '\D', '', 'g'), '') else telefone end,
    atualizado_em = now()
  where id = p_cliente;
end;
$$;

create or replace function public.confirmar_cliente(p_cliente uuid, p_dados jsonb default '{}'::jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.cliente;
begin
  select * into v from public.cliente where id = p_cliente for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_processos(v.escritorio_id);
  if v.status <> 'provisorio' then raise exception 'nao_provisorio' using errcode = '22023'; end if;
  perform public._aplicar_dados_cliente(p_cliente, p_dados);
  select * into v from public.cliente where id = p_cliente;
  if v.documento is not null and exists (
    select 1 from public.cliente c where c.escritorio_id = v.escritorio_id and c.status = 'confirmado' and c.documento = v.documento and c.id <> v.id
  ) then
    raise exception 'documento_duplicado' using errcode = '23505';
  end if;
  update public.cliente set status = 'confirmado', confirmado_em = now(), confirmado_por = auth.uid(), atualizado_em = now()
  where id = p_cliente;
end;
$$;

create or replace function public.confirmar_clientes(p_ids uuid[])
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_n int := 0;
begin
  foreach v_id in array coalesce(p_ids, '{}') loop
    perform public.confirmar_cliente(v_id, '{}'::jsonb);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Junta um cliente provisório a um cliente confirmado: as partes passam a apontar para o confirmado.
create or replace function public.mesclar_cliente(p_cliente uuid, p_destino uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.cliente;
  v_dest public.cliente;
begin
  select * into v from public.cliente where id = p_cliente for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_processos(v.escritorio_id);
  if v.status <> 'provisorio' then raise exception 'nao_provisorio' using errcode = '22023'; end if;
  select * into v_dest from public.cliente where id = p_destino for update;
  if not found or v_dest.escritorio_id <> v.escritorio_id or v_dest.status <> 'confirmado' or v_dest.id = v.id then
    raise exception 'destino_invalido' using errcode = '22023';
  end if;

  update public.processo_parte set cliente_id = v_dest.id where cliente_id = v.id;
  -- Completa o confirmado com o que ele não tinha (nunca sobrescreve).
  update public.cliente set
    documento = coalesce(documento, case when v.documento is not null and not exists (
      select 1 from public.cliente c where c.escritorio_id = v.escritorio_id and c.status = 'confirmado' and c.documento = v.documento
    ) then v.documento end),
    tipo_pessoa = coalesce(tipo_pessoa, v.tipo_pessoa),
    email = coalesce(email, v.email),
    telefone = coalesce(telefone, v.telefone),
    atualizado_em = now()
  where id = v_dest.id;
  update public.cliente set status = 'mesclado', mesclado_em = v_dest.id, atualizado_em = now() where id = v.id;
end;
$$;

create or replace function public.descartar_cliente(p_cliente uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.cliente;
begin
  select * into v from public.cliente where id = p_cliente for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_processos(v.escritorio_id);
  if v.status <> 'provisorio' then raise exception 'nao_provisorio' using errcode = '22023'; end if;
  update public.cliente set status = 'descartado', descartado_em = now(), atualizado_em = now() where id = p_cliente;
end;
$$;

create or replace function public.restaurar_cliente(p_cliente uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.cliente;
begin
  select * into v from public.cliente where id = p_cliente for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_processos(v.escritorio_id);
  if v.status <> 'descartado' then raise exception 'nao_descartado' using errcode = '22023'; end if;
  if v.descartado_em < now() - interval '30 days' then raise exception 'prazo_restauracao_vencido' using errcode = '22023'; end if;
  update public.cliente set status = 'provisorio', descartado_em = null, atualizado_em = now() where id = p_cliente;
end;
$$;

-- Publicações ---------------------------------------------------------

create or replace function public.vincular_publicacao(p_publicacao uuid, p_processo uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_pub public.publicacao;
  v_proc public.processo;
begin
  select * into v_pub from public.publicacao where id = p_publicacao for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_processos(v_pub.escritorio_id);
  if v_pub.status_triagem <> 'sem_processo' then raise exception 'publicacao_ja_tratada' using errcode = '22023'; end if;
  select * into v_proc from public.processo where id = p_processo;
  if not found or v_proc.escritorio_id <> v_pub.escritorio_id then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  if v_proc.status = 'descartado' then raise exception 'processo_descartado' using errcode = '22023'; end if;
  update public.publicacao
    set processo_id = v_proc.id,
        status_triagem = case when v_proc.status = 'confirmado' then 'vinculada' else 'aguardando' end
    where id = p_publicacao;
end;
$$;

create or replace function public.descartar_publicacao(p_publicacao uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.publicacao;
begin
  select * into v from public.publicacao where id = p_publicacao for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_processos(v.escritorio_id);
  if v.status_triagem = 'descartada' then raise exception 'publicacao_ja_tratada' using errcode = '22023'; end if;
  update public.publicacao
    set status_antes_descarte = status_triagem, status_triagem = 'descartada', descartada_em = now()
    where id = p_publicacao;
end;
$$;

create or replace function public.restaurar_publicacao(p_publicacao uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.publicacao;
  v_status_proc text;
begin
  select * into v from public.publicacao where id = p_publicacao for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_processos(v.escritorio_id);
  if v.status_triagem <> 'descartada' then raise exception 'nao_descartado' using errcode = '22023'; end if;
  if v.descartada_em < now() - interval '30 days' then raise exception 'prazo_restauracao_vencido' using errcode = '22023'; end if;
  v_status_proc := (select p.status from public.processo p where p.id = v.processo_id);
  if v_status_proc = 'descartado' then raise exception 'processo_descartado' using errcode = '22023'; end if;
  update public.publicacao set
    status_triagem = case
      when v.processo_id is null then case when v.status_antes_descarte = 'pendente' then 'pendente' else 'sem_processo' end
      when v_status_proc = 'confirmado' then 'vinculada'
      else 'aguardando' end,
    status_antes_descarte = null,
    descartada_em = null
  where id = p_publicacao;
end;
$$;

-- Busca para ligar publicação: por nº do processo, nome de parte, nome do cliente ou título.
-- security invoker: a RLS de quem busca vale.
create or replace function public.buscar_processos(p_escritorio uuid, p_termo text)
returns table (id uuid, numero_cnj text, status text, tribunal text, classe text, titulo text, partes text)
language sql stable security invoker
set search_path = ''
as $$
  with t as (
    select regexp_replace(coalesce(p_termo, ''), '\D', '', 'g') as dig, public.normalizar_nome(p_termo) as norm
  )
  select pr.id, pr.numero_cnj, pr.status, pr.tribunal, pr.classe, pr.titulo,
    (select string_agg(pp.nome, '; ' order by pp.nome) from public.processo_parte pp where pp.processo_id = pr.id) as partes
  from public.processo pr, t
  where pr.escritorio_id = p_escritorio
    and pr.status <> 'descartado'
    and length(t.norm) >= 3
    and (
      (length(t.dig) >= 4 and pr.numero_cnj like '%' || t.dig || '%')
      or public.normalizar_nome(pr.titulo) like '%' || t.norm || '%'
      or exists (
        select 1 from public.processo_parte pp
        left join public.cliente c on c.id = pp.cliente_id
        where pp.processo_id = pr.id
          and (pp.nome_normalizado like '%' || t.norm || '%' or c.nome_normalizado like '%' || t.norm || '%')
      )
    )
  order by (pr.status = 'confirmado') desc, pr.criado_em desc
  limit 20
$$;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.cliente enable row level security;
alter table public.processo enable row level security;
alter table public.processo_parte enable row level security;

-- Processo e partes: quem vê Processos ou Prazos (prazos dependem do processo).
create policy processo_select on public.processo for select to authenticated
  using (public.pode_ver(escritorio_id, 'processos') or public.pode_ver(escritorio_id, 'prazos'));
create policy processo_parte_select on public.processo_parte for select to authenticated
  using (public.pode_ver(escritorio_id, 'processos') or public.pode_ver(escritorio_id, 'prazos'));
-- Cadastro de clientes (CPF, e-mail, telefone): só quem tem Processos.
create policy cliente_select on public.cliente for select to authenticated
  using (public.pode_ver(escritorio_id, 'processos'));

-- Publicação: a triagem agora só muda pelas funções acima (mantém processo e status coerentes).
drop policy publicacao_update on public.publicacao;

-- ---------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------
revoke all on public.cliente, public.processo, public.processo_parte from anon;
revoke insert, update, delete, truncate on public.cliente, public.processo, public.processo_parte from authenticated;
revoke all on public.processo_confirmado, public.cliente_confirmado from anon;
revoke insert, update, delete, truncate on public.processo_confirmado, public.cliente_confirmado from authenticated;
grant select on public.processo_confirmado, public.cliente_confirmado to authenticated;
revoke update (status_triagem) on public.publicacao from authenticated;
revoke update on public.publicacao from authenticated;

-- Internas: ninguém chama direto.
revoke execute on function public._registrar_partes(uuid, uuid, jsonb, boolean) from public, anon, authenticated;
revoke execute on function public._exigir_processos(uuid) from public, anon, authenticated;
revoke execute on function public._aplicar_dados_processo(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public._aplicar_dados_cliente(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.exigir_vinculo_confirmado() from public, anon, authenticated;

-- Do job (service_role).
revoke execute on function public.triar_publicacoes(uuid) from public, anon, authenticated;
grant execute on function public.triar_publicacoes(uuid) to service_role;

-- Do app (usuário logado; cada função confere a permissão).
revoke execute on function public.confirmar_processo(uuid, jsonb) from public, anon;
revoke execute on function public.confirmar_processos(uuid[]) from public, anon;
revoke execute on function public.descartar_processo(uuid) from public, anon;
revoke execute on function public.restaurar_processo(uuid) from public, anon;
revoke execute on function public.confirmar_cliente(uuid, jsonb) from public, anon;
revoke execute on function public.confirmar_clientes(uuid[]) from public, anon;
revoke execute on function public.mesclar_cliente(uuid, uuid) from public, anon;
revoke execute on function public.descartar_cliente(uuid) from public, anon;
revoke execute on function public.restaurar_cliente(uuid) from public, anon;
revoke execute on function public.vincular_publicacao(uuid, uuid) from public, anon;
revoke execute on function public.descartar_publicacao(uuid) from public, anon;
revoke execute on function public.restaurar_publicacao(uuid) from public, anon;
revoke execute on function public.buscar_processos(uuid, text) from public, anon;
grant execute on function public.confirmar_processo(uuid, jsonb) to authenticated;
grant execute on function public.confirmar_processos(uuid[]) to authenticated;
grant execute on function public.descartar_processo(uuid) to authenticated;
grant execute on function public.restaurar_processo(uuid) to authenticated;
grant execute on function public.confirmar_cliente(uuid, jsonb) to authenticated;
grant execute on function public.confirmar_clientes(uuid[]) to authenticated;
grant execute on function public.mesclar_cliente(uuid, uuid) to authenticated;
grant execute on function public.descartar_cliente(uuid) to authenticated;
grant execute on function public.restaurar_cliente(uuid) to authenticated;
grant execute on function public.vincular_publicacao(uuid, uuid) to authenticated;
grant execute on function public.descartar_publicacao(uuid) to authenticated;
grant execute on function public.restaurar_publicacao(uuid) to authenticated;
grant execute on function public.buscar_processos(uuid, text) to authenticated;
