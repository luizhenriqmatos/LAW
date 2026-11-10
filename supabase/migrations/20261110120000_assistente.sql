-- =====================================================================
-- Prompt 11: assistente de IA interno ("Lia").
--
-- Regra central: a IA NUNCA grava. Ela só lê (ferramentas de leitura) e prepara RASCUNHOS DE AÇÃO.
-- Só o clique em "Confirmar" do usuário grava, por assistente_rascunho_confirmar(), que chama as MESMAS funções das
-- telas (lancamento_criar, tarefa_criar, criar_prazo) e por isso passa pelas mesmas permissões e validações.
--
--  - Módulo novo 'assistente': o dono decide quem usa a Lia.
--  - Ferramentas de leitura = funções deste arquivo, chamadas com o login do usuário (RLS). Quem não vê um módulo
--    recebe 'sem_permissao' (e não uma lista vazia, para a resposta não virar "não encontrei").
--  - Processo em segredo de justiça vai à IA (provedor externo) sem partes e sem texto de publicação.
--  - assistente_mensagem é só-acréscimo (ninguém edita nem apaga). Conversa, mensagem, rascunho, modelo e minuta
--    gravam em audit_log.
--  - Minuta gerada pela Lia nasce 'nao_revisado'.
-- =====================================================================

create or replace function public.modulos_validos()
returns text[]
language sql immutable
set search_path = ''
as $$
  select array['agenda','processos','prazos','tarefas','financeiro','calculos','documentos','portal_cliente','assinaturas','assistente','configuracoes']::text[]
$$;

-- Nº CNJ com máscara (NNNNNNN-DD.AAAA.J.TR.OOOO).
create or replace function public.cnj_formatado(p text)
returns text
language sql immutable
set search_path = ''
as $$
  select case when p ~ '^\d{20}$'
    then substr(p,1,7)||'-'||substr(p,8,2)||'.'||substr(p,10,4)||'.'||substr(p,14,1)||'.'||substr(p,15,2)||'.'||substr(p,17,4)
    else p end
$$;

-- =====================================================================
-- Tabelas
-- =====================================================================
create table public.assistente_conversa (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  usuario_id uuid not null references auth.users(id) on delete cascade,
  titulo text not null default 'Nova conversa' check (length(titulo) between 1 and 120),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index assistente_conversa_usuario_idx on public.assistente_conversa (escritorio_id, usuario_id, atualizado_em desc);

create table public.assistente_mensagem (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  conversa_id uuid not null references public.assistente_conversa(id) on delete cascade,
  usuario_id uuid not null,
  papel text not null check (papel in ('usuario','assistente')),
  texto text not null check (length(texto) between 1 and 20000),
  -- Fontes que as ferramentas devolveram nesta resposta: [{ref, rotulo, link}]
  fontes jsonb not null default '[]'::jsonb check (jsonb_typeof(fontes) = 'array'),
  -- Registro das ferramentas chamadas: [{nome, entrada, ok, erro?, itens?}]
  ferramentas jsonb not null default '[]'::jsonb check (jsonb_typeof(ferramentas) = 'array'),
  -- Módulos que alguma ferramenta recusou por falta de permissão (a tela mostra aviso fixo).
  sem_permissao text[] not null default '{}',
  modelo text null check (modelo is null or length(modelo) <= 80),
  criado_em timestamptz not null default now()
);
create index assistente_mensagem_conversa_idx on public.assistente_mensagem (conversa_id, criado_em);
create index assistente_mensagem_limite_idx on public.assistente_mensagem (usuario_id, criado_em) where papel = 'usuario';

create table public.assistente_rascunho (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  conversa_id uuid not null references public.assistente_conversa(id) on delete cascade,
  mensagem_id uuid null references public.assistente_mensagem(id) on delete set null,
  usuario_id uuid not null,
  tipo text not null check (tipo in ('lancamento','tarefa','prazo','minuta')),
  dados jsonb not null check (jsonb_typeof(dados) = 'object'),
  resumo text not null check (length(resumo) between 1 and 500),
  avisos jsonb not null default '[]'::jsonb check (jsonb_typeof(avisos) = 'array'),
  status text not null default 'pendente' check (status in ('pendente','confirmado','descartado')),
  dados_confirmados jsonb null,
  resultado_id uuid null,
  decidido_em timestamptz null,
  criado_em timestamptz not null default now(),
  check ((status = 'pendente') = (decidido_em is null)),
  check ((status = 'confirmado') = (resultado_id is not null and dados_confirmados is not null))
);
create index assistente_rascunho_conversa_idx on public.assistente_rascunho (conversa_id, criado_em);

create table public.modelo_contrato (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  nome text not null check (length(btrim(nome)) between 2 and 120),
  descricao text not null default '' check (length(descricao) <= 500),
  texto text not null check (length(texto) between 20 and 50000),
  ativo boolean not null default true,
  criado_por uuid null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (escritorio_id, nome)
);

create table public.minuta (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  modelo_id uuid null references public.modelo_contrato(id) on delete set null,
  cliente_id uuid null references public.cliente(id),
  processo_id uuid null references public.processo(id),
  titulo text not null check (length(btrim(titulo)) between 2 and 200),
  texto text not null check (length(texto) between 1 and 60000),
  status text not null default 'nao_revisado' check (status in ('nao_revisado','revisado')),
  origem text not null default 'assistente' check (origem in ('assistente','manual')),
  criado_por uuid null,
  revisado_por uuid null,
  revisado_em timestamptz null,
  criado_em timestamptz not null default now(),
  check ((status = 'revisado') = (revisado_em is not null))
);
create index minuta_escritorio_idx on public.minuta (escritorio_id, criado_em desc);

-- Mensagem é só-acréscimo; rascunho só muda de pendente para decidido; modelo/minuta não trocam de escritório.
create or replace function public.assistente_bloquear_alteracao()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'campo_imutavel' using errcode = '42501';
end;
$$;
create trigger assistente_mensagem_imutavel before update or delete on public.assistente_mensagem
  for each row execute function public.assistente_bloquear_alteracao();

create or replace function public.assistente_rascunho_protege()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'pendente' and (new.status is distinct from old.status or new.dados_confirmados is distinct from old.dados_confirmados
     or new.resultado_id is distinct from old.resultado_id) then
    raise exception 'rascunho_encerrado' using errcode = '22023';
  end if;
  if new.escritorio_id <> old.escritorio_id or new.conversa_id <> old.conversa_id or new.usuario_id <> old.usuario_id
     or new.tipo <> old.tipo or new.dados <> old.dados or new.criado_em <> old.criado_em then
    raise exception 'campo_imutavel' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger assistente_rascunho_protecao before update on public.assistente_rascunho
  for each row execute function public.assistente_rascunho_protege();

create or replace function public.assistente_escritorio_fixo()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.escritorio_id <> old.escritorio_id then raise exception 'campo_imutavel' using errcode = '42501'; end if;
  return new;
end;
$$;
create trigger modelo_contrato_escritorio before update on public.modelo_contrato
  for each row execute function public.assistente_escritorio_fixo();
create trigger minuta_escritorio before update on public.minuta
  for each row execute function public.assistente_escritorio_fixo();

-- Vínculos da minuta: cliente/processo do mesmo escritório e CONFIRMADOS (gatilho do Prompt 3).
create trigger minuta_vinculo_confirmado before insert on public.minuta
  for each row execute function public.exigir_vinculo_confirmado();

-- Auditoria
create trigger auditoria_assistente_conversa after insert or update or delete on public.assistente_conversa
  for each row execute function public.registrar_auditoria();
create trigger auditoria_assistente_mensagem after insert on public.assistente_mensagem
  for each row execute function public.registrar_auditoria();
create trigger auditoria_assistente_rascunho after insert or update or delete on public.assistente_rascunho
  for each row execute function public.registrar_auditoria();
create trigger auditoria_modelo_contrato after insert or update or delete on public.modelo_contrato
  for each row execute function public.registrar_auditoria();
create trigger auditoria_minuta after insert or update or delete on public.minuta
  for each row execute function public.registrar_auditoria();

-- =====================================================================
-- RLS: conversas, mensagens e rascunhos são de quem conversou (nem o dono lê pela tabela; ele vê no audit_log).
-- =====================================================================
alter table public.assistente_conversa enable row level security;
alter table public.assistente_mensagem enable row level security;
alter table public.assistente_rascunho enable row level security;
alter table public.modelo_contrato enable row level security;
alter table public.minuta enable row level security;

create policy assistente_conversa_select on public.assistente_conversa for select to authenticated
  using (usuario_id = auth.uid() and public.pode_ver(escritorio_id, 'assistente'));
create policy assistente_mensagem_select on public.assistente_mensagem for select to authenticated
  using (usuario_id = auth.uid() and public.pode_ver(escritorio_id, 'assistente'));
create policy assistente_rascunho_select on public.assistente_rascunho for select to authenticated
  using (usuario_id = auth.uid() and public.pode_ver(escritorio_id, 'assistente'));
create policy modelo_contrato_select on public.modelo_contrato for select to authenticated
  using (public.pode_ver(escritorio_id, 'documentos'));
create policy minuta_select on public.minuta for select to authenticated
  using (public.pode_ver(escritorio_id, 'documentos'));

revoke all on public.assistente_conversa, public.assistente_mensagem, public.assistente_rascunho,
  public.modelo_contrato, public.minuta from public, anon, authenticated;
grant select on public.assistente_conversa, public.assistente_mensagem, public.assistente_rascunho,
  public.modelo_contrato, public.minuta to authenticated;

-- =====================================================================
-- Permissões
-- =====================================================================
create or replace function public._exigir_assistente(p_escritorio uuid)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '42501'; end if;
  if not public.pode_ver(p_escritorio, 'assistente') then raise exception 'sem_permissao' using errcode = '42501'; end if;
end;
$$;

-- Ferramenta de leitura: exige a Lia E pelo menos um dos módulos da lista.
create or replace function public._assistente_exigir_leitura(p_escritorio uuid, p_modulos text[])
returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform public._exigir_assistente(p_escritorio);
  if not exists (select 1 from unnest(p_modulos) m where public.pode_ver(p_escritorio, m)) then
    raise exception 'sem_permissao' using errcode = '42501', detail = array_to_string(p_modulos, ',');
  end if;
end;
$$;

create or replace function public._assistente_limite(p int, p_padrao int default 10)
returns int
language sql immutable
set search_path = ''
as $$ select least(greatest(coalesce(p, p_padrao), 1), 20) $$;

-- =====================================================================
-- Ferramentas de LEITURA (security invoker: a RLS do usuário vale integralmente)
-- Todas devolvem {"itens": [...], "mais": bool}. Cada item traz ref, rotulo e link (a tela citada).
-- =====================================================================
create or replace function public.assistente_buscar_processos(p_escritorio uuid, p_termo text default null, p_limite int default 10)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_t text := public.normalizar_nome(p_termo);
  v_dig text := regexp_replace(coalesce(p_termo, ''), '\D', '', 'g');
  v_lim int := public._assistente_limite(p_limite);
  v_itens jsonb;
begin
  perform public._assistente_exigir_leitura(p_escritorio, array['processos','prazos']);
  select coalesce(jsonb_agg(item order by ord), '[]'::jsonb) into v_itens from (
    select p.ord,
      case when p.segredo_justica then jsonb_build_object(
        'ref', 'processo:' || p.id, 'rotulo', 'Processo ' || public.cnj_formatado(p.numero_cnj), 'link', '/app/processos/' || p.id,
        'id', p.id, 'numero_cnj', public.cnj_formatado(p.numero_cnj), 'status', p.status, 'tribunal', p.tribunal,
        'restrito', true, 'aviso', 'Processo em segredo de justiça: partes e detalhes só na tela do LAW.')
      else jsonb_build_object(
        'ref', 'processo:' || p.id, 'rotulo', 'Processo ' || public.cnj_formatado(p.numero_cnj), 'link', '/app/processos/' || p.id,
        'id', p.id, 'numero_cnj', public.cnj_formatado(p.numero_cnj), 'status', p.status, 'titulo', p.titulo,
        'tribunal', p.tribunal, 'classe', p.classe, 'orgao_julgador', p.orgao_julgador, 'area', p.area,
        'data_ajuizamento', p.data_ajuizamento, 'restrito', false,
        'partes', coalesce((select jsonb_agg(jsonb_build_object('nome', pp.nome, 'polo', pp.polo, 'cliente_id', pp.cliente_id) order by pp.polo, pp.nome)
                            from public.processo_parte pp where pp.processo_id = p.id), '[]'::jsonb))
      end as item
    from (
      select p.*, row_number() over (order by (p.status = 'confirmado') desc, p.atualizado_em desc, p.id) as ord
      from public.processo p
      where p.escritorio_id = p_escritorio and p.status <> 'descartado'
        and (v_t = ''
          or p.id::text = btrim(p_termo)
          or (length(v_dig) >= 4 and p.numero_cnj like '%' || v_dig || '%')
          or (not p.segredo_justica and public.normalizar_nome(concat_ws(' ', p.titulo, p.classe, p.area, p.orgao_julgador)) like '%' || v_t || '%')
          or (not p.segredo_justica and exists (select 1 from public.processo_parte pp where pp.processo_id = p.id and pp.nome_normalizado like '%' || v_t || '%')))
      order by ord
      limit v_lim + 1
    ) p
  ) s;
  return jsonb_build_object('itens', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_itens) with ordinality t(e, n) where n <= v_lim) x),
                            'mais', jsonb_array_length(v_itens) > v_lim);
end;
$$;

create or replace function public.assistente_buscar_clientes(p_escritorio uuid, p_termo text default null, p_limite int default 10)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_t text := public.normalizar_nome(p_termo);
  v_lim int := public._assistente_limite(p_limite);
  v_itens jsonb;
begin
  perform public._assistente_exigir_leitura(p_escritorio, array['processos']);
  select coalesce(jsonb_agg(jsonb_build_object(
      'ref', 'cliente:' || c.id, 'rotulo', 'Cliente ' || c.nome, 'link', '/app/processos/clientes/' || c.id,
      'id', c.id, 'nome', c.nome, 'tipo_pessoa', c.tipo_pessoa, 'status', c.status,
      'processos', coalesce((select jsonb_agg(public.cnj_formatado(p.numero_cnj))
                             from public.processo p
                             where p.status = 'confirmado' and not p.segredo_justica
                               and exists (select 1 from public.processo_parte pp where pp.processo_id = p.id and pp.cliente_id = c.id)), '[]'::jsonb)
    ) order by c.ord), '[]'::jsonb) into v_itens
  from (
    select c.*, row_number() over (order by (c.nome_normalizado = v_t) desc, (c.status = 'confirmado') desc, c.nome) as ord
    from public.cliente c
    where c.escritorio_id = p_escritorio and c.status in ('confirmado','provisorio')
      and (v_t = '' or c.id::text = btrim(p_termo) or c.nome_normalizado like '%' || v_t || '%')
    order by ord
    limit v_lim + 1
  ) c;
  return jsonb_build_object('itens', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_itens) with ordinality t(e, n) where n <= v_lim) x),
                            'mais', jsonb_array_length(v_itens) > v_lim);
end;
$$;

create or replace function public.assistente_buscar_prazos(
  p_escritorio uuid, p_termo text default null, p_de date default null, p_ate date default null,
  p_status text default 'aberto', p_limite int default 10
) returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_t text := public.normalizar_nome(p_termo);
  v_dig text := regexp_replace(coalesce(p_termo, ''), '\D', '', 'g');
  v_lim int := public._assistente_limite(p_limite);
  v_hoje date := public.hoje_brasilia();
  v_itens jsonb;
begin
  perform public._assistente_exigir_leitura(p_escritorio, array['prazos']);
  if coalesce(p_status, 'aberto') not in ('aberto','cumprido','cancelado','todos') then raise exception 'status_invalido' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'ref', 'prazo:' || z.id, 'rotulo', 'Prazo "' || z.descricao || '"', 'link', '/app/processos/' || z.processo_id,
      'id', z.id, 'descricao', z.descricao, 'data_final', z.data_final, 'dias', z.dias, 'tipo_contagem', z.tipo_contagem,
      'status', z.status, 'vencido', (z.status = 'aberto' and z.data_final < v_hoje),
      'processo', public.cnj_formatado(z.numero_cnj), 'processo_id', z.processo_id, 'responsavel', z.responsavel,
      'aviso', 'Prazo sugerido. Confira no sistema oficial do tribunal.'
    ) order by z.data_final, z.id), '[]'::jsonb) into v_itens
  from (
    select pz.*, p.numero_cnj, m.nome as responsavel
    from public.prazo pz
    join public.processo p on p.id = pz.processo_id
    left join public.membro m on m.id = pz.responsavel_id
    where pz.escritorio_id = p_escritorio
      and (coalesce(p_status, 'aberto') = 'todos' or pz.status = coalesce(p_status, 'aberto'))
      and (p_de is null or pz.data_final >= p_de) and (p_ate is null or pz.data_final <= p_ate)
      and (v_t = '' or public.normalizar_nome(pz.descricao) like '%' || v_t || '%' or (length(v_dig) >= 4 and p.numero_cnj like '%' || v_dig || '%'))
    order by pz.data_final, pz.id
    limit v_lim + 1
  ) z;
  return jsonb_build_object('itens', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_itens) with ordinality t(e, n) where n <= v_lim) x),
                            'mais', jsonb_array_length(v_itens) > v_lim, 'hoje', v_hoje);
end;
$$;

create or replace function public.assistente_buscar_tarefas(
  p_escritorio uuid, p_termo text default null, p_de date default null, p_ate date default null,
  p_incluir_concluidas boolean default false, p_limite int default 10
) returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_t text := public.normalizar_nome(p_termo);
  v_lim int := public._assistente_limite(p_limite);
  v_itens jsonb;
begin
  perform public._assistente_exigir_leitura(p_escritorio, array['tarefas']);
  select coalesce(jsonb_agg(jsonb_build_object(
      'ref', 'tarefa:' || t.id, 'rotulo', 'Tarefa "' || t.titulo || '"', 'link', '/app/tarefas/' || t.id,
      'id', t.id, 'titulo', t.titulo, 'descricao', left(t.descricao, 300), 'coluna', t.coluna, 'data', t.data,
      'concluida', t.concluida_em is not null, 'responsavel', t.responsavel, 'etiquetas', to_jsonb(t.etiquetas),
      'processo', public.cnj_formatado(t.numero_cnj)
    ) order by t.data nulls last, t.criado_em desc), '[]'::jsonb) into v_itens
  from (
    select ta.*, qc.nome as coluna, m.nome as responsavel, p.numero_cnj
    from public.tarefa ta
    join public.quadro_coluna qc on qc.id = ta.coluna_id
    left join public.membro m on m.id = ta.responsavel_id
    left join public.processo p on p.id = ta.processo_id
    where ta.escritorio_id = p_escritorio
      and (coalesce(p_incluir_concluidas, false) or ta.concluida_em is null)
      and (p_de is null or ta.data >= p_de) and (p_ate is null or ta.data <= p_ate)
      and (v_t = '' or public.normalizar_nome(ta.titulo || ' ' || ta.descricao) like '%' || v_t || '%')
    order by ta.data nulls last, ta.criado_em desc
    limit v_lim + 1
  ) t;
  return jsonb_build_object('itens', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_itens) with ordinality t(e, n) where n <= v_lim) x),
                            'mais', jsonb_array_length(v_itens) > v_lim);
end;
$$;

-- Lançamentos: security definer (como financeiro_lancamentos) para mostrar o NOME do cliente a quem tem o Financeiro
-- mas não Processos. A permissão é a mesma da RLS: pode_ver(escritorio, 'financeiro').
create or replace function public.assistente_buscar_lancamentos(
  p_escritorio uuid, p_termo text default null, p_cliente uuid default null, p_situacao text default 'todos', p_limite int default 10
) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_t text := public.normalizar_nome(p_termo);
  v_lim int := public._assistente_limite(p_limite);
  v_hoje date := public.hoje_brasilia();
  v_itens jsonb;
begin
  perform public._assistente_exigir_leitura(p_escritorio, array['financeiro']);
  if coalesce(p_situacao, 'todos') not in ('todos','em_aberto','atrasado','pago','cancelado') then raise exception 'status_invalido' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'ref', 'lancamento:' || x.id, 'rotulo', 'Lançamento "' || x.descricao || '"', 'link', '/app/financeiro/lancamentos/' || x.id,
      'id', x.id, 'tipo', x.tipo, 'categoria', x.categoria, 'descricao', x.descricao, 'valor_total_centavos', x.valor_centavos,
      'data_competencia', x.data_competencia, 'cancelado', x.cancelado_em is not null, 'cliente', x.cliente_nome,
      'processo', public.cnj_formatado(x.numero_cnj),
      'parcelas', x.n, 'parcelas_pagas', x.pagas, 'em_aberto_centavos', x.aberto, 'atrasado_centavos', x.atrasado,
      'proximo_vencimento', x.proximo
    ) order by x.data_competencia desc, x.id), '[]'::jsonb) into v_itens
  from (
    select l.*, c.nome as cliente_nome, p.numero_cnj,
      s.n, s.pagas, s.aberto, s.atrasado, s.proximo
    from public.lancamento l
    left join public.cliente c on c.id = l.cliente_id
    left join public.processo p on p.id = l.processo_id
    cross join lateral (
      select count(*)::int as n,
        count(*) filter (where pa.status = 'paga')::int as pagas,
        coalesce(sum(pa.valor_centavos - pa.valor_pago_centavos) filter (where pa.status in ('aberta','atrasada','parcial')), 0)::bigint as aberto,
        coalesce(sum(pa.valor_centavos - pa.valor_pago_centavos) filter (where pa.status in ('aberta','atrasada','parcial') and pa.vencimento < v_hoje), 0)::bigint as atrasado,
        min(pa.vencimento) filter (where pa.status in ('aberta','atrasada','parcial')) as proximo
      from public.parcela pa where pa.lancamento_id = l.id
    ) s
    where l.escritorio_id = p_escritorio
      and (p_cliente is null or l.cliente_id = p_cliente)
      and (v_t = '' or public.normalizar_nome(l.descricao || ' ' || coalesce(c.nome, '')) like '%' || v_t || '%')
      and case coalesce(p_situacao, 'todos')
            when 'todos' then true
            when 'cancelado' then l.cancelado_em is not null
            when 'em_aberto' then l.cancelado_em is null and s.aberto > 0
            when 'atrasado' then l.cancelado_em is null and s.atrasado > 0
            when 'pago' then l.cancelado_em is null and s.aberto = 0
          end
    order by l.data_competencia desc, l.id
    limit v_lim + 1
  ) x;
  return jsonb_build_object('itens', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_itens) with ordinality t(e, n) where n <= v_lim) x),
                            'mais', jsonb_array_length(v_itens) > v_lim, 'hoje', v_hoje);
end;
$$;

create or replace function public.assistente_buscar_publicacoes(
  p_escritorio uuid, p_termo text default null, p_de date default null, p_ate date default null, p_limite int default 10
) returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_t text := public.normalizar_nome(p_termo);
  v_dig text := regexp_replace(coalesce(p_termo, ''), '\D', '', 'g');
  v_lim int := public._assistente_limite(p_limite);
  v_itens jsonb;
begin
  perform public._assistente_exigir_leitura(p_escritorio, array['processos','prazos']);
  select coalesce(jsonb_agg(jsonb_build_object(
      'ref', 'publicacao:' || u.id,
      'rotulo', 'Publicação de ' || to_char(u.data_disponibilizacao, 'DD/MM/YYYY') || ' (' || u.tribunal || ')',
      'link', case when u.processo_id is not null then '/app/processos/' || u.processo_id else '/app/processos/triagem' end,
      'id', u.id, 'data_disponibilizacao', u.data_disponibilizacao, 'tribunal', u.tribunal, 'orgao', u.orgao,
      'tipo_comunicacao', u.tipo_comunicacao, 'processo', public.cnj_formatado(u.numero_cnj), 'processo_id', u.processo_id,
      'situacao_triagem', u.status_triagem, 'restrito', u.restrito,
      'trecho', case when u.restrito then null else left(u.texto, 800) end
    ) order by u.data_disponibilizacao desc, u.id), '[]'::jsonb) into v_itens
  from (
    select pu.*, coalesce(pr.segredo_justica, false) as restrito
    from public.publicacao pu
    left join public.processo pr on pr.escritorio_id = pu.escritorio_id
      and (pr.id = pu.processo_id or (pu.processo_id is null and pr.numero_cnj = pu.numero_cnj))
    where pu.escritorio_id = p_escritorio and pu.status_triagem <> 'descartada'
      and (p_de is null or pu.data_disponibilizacao >= p_de) and (p_ate is null or pu.data_disponibilizacao <= p_ate)
      and (v_t = ''
        or (length(v_dig) >= 4 and pu.numero_cnj like '%' || v_dig || '%')
        or (not coalesce(pr.segredo_justica, false) and public.normalizar_nome(pu.texto) like '%' || v_t || '%'))
    order by pu.data_disponibilizacao desc, pu.id
    limit v_lim + 1
  ) u;
  return jsonb_build_object('itens', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_itens) with ordinality t(e, n) where n <= v_lim) x),
                            'mais', jsonb_array_length(v_itens) > v_lim);
end;
$$;

-- Contexto da conversa: hoje, módulos do usuário, equipe (para escolher responsável), colunas e modelos de contrato.
create or replace function public.assistente_contexto(p_escritorio uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_membro public.membro;
begin
  perform public._exigir_assistente(p_escritorio);
  select * into v_membro from public.membro where escritorio_id = p_escritorio and usuario_id = auth.uid();
  return jsonb_build_object(
    'hoje', public.hoje_brasilia(),
    'escritorio', (select nome from public.escritorio where id = p_escritorio),
    'meu_membro_id', v_membro.id,
    'meu_nome', v_membro.nome,
    'modulos', to_jsonb(public.meus_modulos(p_escritorio)),
    'equipe', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', m.id, 'nome', coalesce(nullif(m.nome, ''), split_part(m.email, '@', 1)),
        'prazos', m.papel = 'dono' or exists (select 1 from public.permissao_tela t where t.membro_id = m.id and t.modulo = 'prazos'),
        'tarefas', m.papel = 'dono' or exists (select 1 from public.permissao_tela t where t.membro_id = m.id and t.modulo = 'tarefas')
      ) order by m.nome), '[]'::jsonb) from public.membro m where m.escritorio_id = p_escritorio),
    'colunas', case when public.pode_ver(p_escritorio, 'tarefas') then
      (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'nome', q.nome, 'concluida', q.concluida) order by q.posicao), '[]'::jsonb)
       from public.quadro_coluna q where q.escritorio_id = p_escritorio) else '[]'::jsonb end,
    'modelos', case when public.pode_ver(p_escritorio, 'documentos') then
      (select coalesce(jsonb_agg(jsonb_build_object('id', mc.id, 'nome', mc.nome, 'descricao', mc.descricao, 'texto', mc.texto) order by mc.nome), '[]'::jsonb)
       from public.modelo_contrato mc where mc.escritorio_id = p_escritorio and mc.ativo) else '[]'::jsonb end
  );
end;
$$;

-- Dados do cliente/processo que entram na minuta. Só no servidor do LAW: o CPF/CNPJ NÃO vai para a IA.
create or replace function public.assistente_dados_minuta(p_escritorio uuid, p_cliente uuid, p_processo uuid)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare c public.cliente; p public.processo;
begin
  perform public._exigir_assistente(p_escritorio);
  if not public.pode_ver(p_escritorio, 'documentos') then raise exception 'sem_permissao' using errcode = '42501', detail = 'documentos'; end if;
  if p_cliente is not null then
    if not public.pode_ver(p_escritorio, 'processos') then raise exception 'sem_permissao' using errcode = '42501', detail = 'processos'; end if;
    select * into c from public.cliente where id = p_cliente and escritorio_id = p_escritorio and status = 'confirmado';
    if not found then raise exception 'cliente_nao_confirmado' using errcode = '22023'; end if;
  end if;
  if p_processo is not null then
    select * into p from public.processo where id = p_processo and escritorio_id = p_escritorio and status = 'confirmado';
    if not found then raise exception 'processo_nao_confirmado' using errcode = '22023'; end if;
  end if;
  return jsonb_build_object(
    'escritorio_nome', (select nome from public.escritorio where id = p_escritorio),
    'cliente_nome', c.nome, 'cliente_documento', c.documento, 'cliente_email', c.email, 'cliente_telefone', c.telefone,
    'processo_numero', public.cnj_formatado(p.numero_cnj), 'processo_tribunal', p.tribunal, 'processo_classe', p.classe,
    'processo_vara', p.orgao_julgador
  );
end;
$$;

-- =====================================================================
-- Conversa, mensagens e rascunhos (escrita só por estas funções)
-- =====================================================================
create or replace function public._assistente_minha_conversa(p_conversa uuid)
returns uuid
language plpgsql stable security definer
set search_path = ''
as $$
declare v_esc uuid;
begin
  select escritorio_id into v_esc from public.assistente_conversa where id = p_conversa and usuario_id = auth.uid();
  if v_esc is null then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_assistente(v_esc);
  return v_esc;
end;
$$;

create or replace function public.assistente_conversa_criar(p_escritorio uuid, p_titulo text default null)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare v_id uuid; v_titulo text := left(btrim(regexp_replace(coalesce(p_titulo, ''), '\s+', ' ', 'g')), 120);
begin
  perform public._exigir_assistente(p_escritorio);
  insert into public.assistente_conversa (escritorio_id, usuario_id, titulo)
  values (p_escritorio, auth.uid(), coalesce(nullif(v_titulo, ''), 'Nova conversa'))
  returning id into v_id;
  return v_id;
end;
$$;

-- Limite de perguntas por usuário por dia (custo da IA e abuso). PENDENCIA P-068.
create or replace function public.assistente_limite_diario()
returns int
language sql immutable
set search_path = ''
as $$ select 200 $$;

create or replace function public.assistente_mensagem_registrar(
  p_conversa uuid, p_papel text, p_texto text, p_fontes jsonb default '[]', p_ferramentas jsonb default '[]',
  p_sem_permissao text[] default '{}', p_modelo text default null, p_rascunhos uuid[] default '{}'
) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_esc uuid := public._assistente_minha_conversa(p_conversa);
  v_id uuid;
begin
  if p_papel not in ('usuario','assistente') then raise exception 'dados_invalidos' using errcode = '22023'; end if;
  if p_papel = 'usuario' and (
    select count(*) from public.assistente_mensagem
    where usuario_id = auth.uid() and papel = 'usuario' and criado_em >= (public.hoje_brasilia()::timestamp at time zone 'America/Sao_Paulo')
  ) >= public.assistente_limite_diario() then
    raise exception 'limite_assistente' using errcode = '22023';
  end if;
  -- Trava a conversa: perguntas da mesma conversa entram em ordem.
  perform 1 from public.assistente_conversa where id = p_conversa for update;
  insert into public.assistente_mensagem (escritorio_id, conversa_id, usuario_id, papel, texto, fontes, ferramentas, sem_permissao, modelo)
  values (v_esc, p_conversa, auth.uid(), p_papel, p_texto, coalesce(p_fontes, '[]'), coalesce(p_ferramentas, '[]'),
          coalesce(p_sem_permissao, '{}'), p_modelo)
  returning id into v_id;
  update public.assistente_conversa set
    atualizado_em = now(),
    titulo = case when titulo = 'Nova conversa' and p_papel = 'usuario'
                  then coalesce(nullif(left(btrim(regexp_replace(p_texto, '\s+', ' ', 'g')), 120), ''), titulo) else titulo end
  where id = p_conversa;
  if p_papel = 'assistente' and coalesce(array_length(p_rascunhos, 1), 0) > 0 then
    update public.assistente_rascunho set mensagem_id = v_id
    where id = any(p_rascunhos) and conversa_id = p_conversa and usuario_id = auth.uid() and mensagem_id is null;
  end if;
  return v_id;
end;
$$;

-- Módulo que o tipo de rascunho exige (o mesmo que a tela daquele cadastro exige).
create or replace function public.assistente_modulo_do_tipo(p_tipo text)
returns text
language sql immutable
set search_path = ''
as $$
  select case p_tipo when 'lancamento' then 'financeiro' when 'tarefa' then 'tarefas' when 'prazo' then 'prazos' when 'minuta' then 'documentos' end
$$;

create or replace function public.assistente_rascunho_criar(p_conversa uuid, p_tipo text, p_dados jsonb, p_resumo text, p_avisos jsonb default '[]')
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_esc uuid := public._assistente_minha_conversa(p_conversa);
  v_mod text := public.assistente_modulo_do_tipo(p_tipo);
  v_id uuid;
begin
  if v_mod is null then raise exception 'dados_invalidos' using errcode = '22023'; end if;
  if not public.pode_ver(v_esc, v_mod) then raise exception 'sem_permissao' using errcode = '42501', detail = v_mod; end if;
  if (select count(*) from public.assistente_rascunho where usuario_id = auth.uid() and status = 'pendente'
        and criado_em > now() - interval '1 day') >= 30 then
    raise exception 'rascunhos_demais' using errcode = '22023';
  end if;
  insert into public.assistente_rascunho (escritorio_id, conversa_id, usuario_id, tipo, dados, resumo, avisos)
  values (v_esc, p_conversa, auth.uid(), p_tipo, p_dados, left(btrim(p_resumo), 500), coalesce(p_avisos, '[]'))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.assistente_rascunho_descartar(p_rascunho uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare r public.assistente_rascunho;
begin
  select * into r from public.assistente_rascunho where id = p_rascunho and usuario_id = auth.uid() for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_assistente(r.escritorio_id);
  if r.status <> 'pendente' then raise exception 'rascunho_encerrado' using errcode = '22023'; end if;
  update public.assistente_rascunho set status = 'descartado', decidido_em = now() where id = p_rascunho;
end;
$$;

-- Validade do rascunho: depois disso, peça de novo (os dados podem ter mudado).
create or replace function public.assistente_validade_rascunho()
returns interval
language sql immutable
set search_path = ''
as $$ select interval '24 hours' $$;

-- O ÚNICO caminho de gravação da Lia. Roda com o login do usuário e chama as funções das telas, que conferem de novo
-- a permissão do módulo e validam os dados. Tudo numa transação: ou grava e marca o rascunho, ou nada.
-- p_dados = o que o usuário viu (e talvez editou) no cartão, já validado e completado pelo servidor do LAW
-- (para prazo, a data recalculada pelo módulo de contagem; para minuta, o texto montado a partir do modelo).
create or replace function public.assistente_rascunho_confirmar(p_rascunho uuid, p_dados jsonb)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  r public.assistente_rascunho;
  d jsonb := coalesce(p_dados, '{}'::jsonb);
  v_id uuid;
  v_link text;
  v_mod text;
begin
  select * into r from public.assistente_rascunho where id = p_rascunho and usuario_id = auth.uid() for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_assistente(r.escritorio_id);
  if r.status <> 'pendente' then raise exception 'rascunho_encerrado' using errcode = '22023'; end if;
  if r.criado_em < now() - public.assistente_validade_rascunho() then raise exception 'rascunho_vencido' using errcode = '22023'; end if;
  v_mod := public.assistente_modulo_do_tipo(r.tipo);
  if not public.pode_ver(r.escritorio_id, v_mod) then raise exception 'sem_permissao' using errcode = '42501', detail = v_mod; end if;
  if jsonb_typeof(d) <> 'object' then raise exception 'dados_invalidos' using errcode = '22023'; end if;

  if r.tipo = 'lancamento' then
    v_id := public.lancamento_criar(r.escritorio_id, d);
    v_link := '/app/financeiro/lancamentos/' || v_id;
  elsif r.tipo = 'tarefa' then
    v_id := public.tarefa_criar(
      r.escritorio_id, nullif(d->>'coluna_id', '')::uuid, d->>'titulo', d->>'descricao', nullif(d->>'responsavel_id', '')::uuid,
      nullif(d->>'data', '')::date, nullif(d->>'processo_id', '')::uuid, nullif(d->>'cliente_id', '')::uuid,
      array(select jsonb_array_elements_text(coalesce(d->'etiquetas', '[]'::jsonb))));
    v_link := '/app/tarefas/' || v_id;
  elsif r.tipo = 'prazo' then
    if (select escritorio_id from public.processo where id = nullif(d->>'processo_id', '')::uuid) is distinct from r.escritorio_id then
      raise exception 'nao_encontrado' using errcode = 'P0002';
    end if;
    v_id := public.criar_prazo(
      (d->>'processo_id')::uuid, nullif(d->>'publicacao_id', '')::uuid, d->>'descricao', (d->>'dias')::int, d->>'tipo_contagem',
      (d->>'responsavel_id')::uuid, (d->>'data_disponibilizacao')::date, (d->>'data_publicacao')::date,
      (d->>'inicio_contagem')::date, (d->>'data_final')::date, d->'raciocinio');
    v_link := '/app/processos/' || (d->>'processo_id');
  elsif r.tipo = 'minuta' then
    insert into public.minuta (escritorio_id, modelo_id, cliente_id, processo_id, titulo, texto, status, origem, criado_por)
    values (r.escritorio_id,
            (select id from public.modelo_contrato where id = nullif(d->>'modelo_id', '')::uuid and escritorio_id = r.escritorio_id),
            nullif(d->>'cliente_id', '')::uuid, nullif(d->>'processo_id', '')::uuid,
            btrim(d->>'titulo'), d->>'texto', 'nao_revisado', 'assistente', auth.uid())
    returning id into v_id;
    v_link := '/app/assistente/minutas/' || v_id;
  end if;

  update public.assistente_rascunho
  set status = 'confirmado', dados_confirmados = d, resultado_id = v_id, decidido_em = now()
  where id = p_rascunho;
  return jsonb_build_object('tipo', r.tipo, 'id', v_id, 'link', v_link);
end;
$$;

-- =====================================================================
-- Modelos de contrato e minutas (quem tem a tela Documentos)
-- =====================================================================
create or replace function public.modelo_contrato_salvar(p_escritorio uuid, p_id uuid, p_nome text, p_descricao text, p_texto text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if not public.pode_ver(p_escritorio, 'documentos') then raise exception 'sem_permissao' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_nome, ''))) not between 2 and 120 then raise exception 'nome_modelo_invalido' using errcode = '22023'; end if;
  if length(coalesce(p_texto, '')) not between 20 and 50000 then raise exception 'texto_modelo_invalido' using errcode = '22023'; end if;
  if p_id is null then
    insert into public.modelo_contrato (escritorio_id, nome, descricao, texto, criado_por)
    values (p_escritorio, btrim(p_nome), coalesce(btrim(p_descricao), ''), p_texto, auth.uid()) returning id into v_id;
  else
    update public.modelo_contrato set nome = btrim(p_nome), descricao = coalesce(btrim(p_descricao), ''), texto = p_texto, atualizado_em = now()
    where id = p_id and escritorio_id = p_escritorio returning id into v_id;
    if v_id is null then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  end if;
  return v_id;
exception when unique_violation then
  raise exception 'modelo_duplicado' using errcode = '23505';
end;
$$;

create or replace function public.modelo_contrato_ativar(p_id uuid, p_ativo boolean)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare v_esc uuid;
begin
  select escritorio_id into v_esc from public.modelo_contrato where id = p_id;
  if v_esc is null or not public.pode_ver(v_esc, 'documentos') then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  update public.modelo_contrato set ativo = coalesce(p_ativo, false), atualizado_em = now() where id = p_id;
end;
$$;

create or replace function public.minuta_marcar_revisada(p_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare v public.minuta;
begin
  select * into v from public.minuta where id = p_id for update;
  if not found or not public.pode_ver(v.escritorio_id, 'documentos') then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  if v.status = 'revisado' then return; end if;
  update public.minuta set status = 'revisado', revisado_por = auth.uid(), revisado_em = now() where id = p_id;
end;
$$;

-- =====================================================================
-- Privilégios de função
-- =====================================================================
revoke execute on function public._exigir_assistente(uuid), public._assistente_exigir_leitura(uuid, text[]),
  public._assistente_minha_conversa(uuid) from public, anon;
grant execute on function public._exigir_assistente(uuid), public._assistente_exigir_leitura(uuid, text[]),
  public._assistente_minha_conversa(uuid) to authenticated;

revoke execute on function
  public.assistente_buscar_processos(uuid, text, int), public.assistente_buscar_clientes(uuid, text, int),
  public.assistente_buscar_prazos(uuid, text, date, date, text, int), public.assistente_buscar_tarefas(uuid, text, date, date, boolean, int),
  public.assistente_buscar_lancamentos(uuid, text, uuid, text, int), public.assistente_buscar_publicacoes(uuid, text, date, date, int),
  public.assistente_contexto(uuid), public.assistente_dados_minuta(uuid, uuid, uuid),
  public.assistente_conversa_criar(uuid, text),
  public.assistente_mensagem_registrar(uuid, text, text, jsonb, jsonb, text[], text, uuid[]),
  public.assistente_rascunho_criar(uuid, text, jsonb, text, jsonb), public.assistente_rascunho_descartar(uuid),
  public.assistente_rascunho_confirmar(uuid, jsonb),
  public.modelo_contrato_salvar(uuid, uuid, text, text, text), public.modelo_contrato_ativar(uuid, boolean),
  public.minuta_marcar_revisada(uuid)
from public, anon;
grant execute on function
  public.assistente_buscar_processos(uuid, text, int), public.assistente_buscar_clientes(uuid, text, int),
  public.assistente_buscar_prazos(uuid, text, date, date, text, int), public.assistente_buscar_tarefas(uuid, text, date, date, boolean, int),
  public.assistente_buscar_lancamentos(uuid, text, uuid, text, int), public.assistente_buscar_publicacoes(uuid, text, date, date, int),
  public.assistente_contexto(uuid), public.assistente_dados_minuta(uuid, uuid, uuid),
  public.assistente_conversa_criar(uuid, text),
  public.assistente_mensagem_registrar(uuid, text, text, jsonb, jsonb, text[], text, uuid[]),
  public.assistente_rascunho_criar(uuid, text, jsonb, text, jsonb), public.assistente_rascunho_descartar(uuid),
  public.assistente_rascunho_confirmar(uuid, jsonb),
  public.modelo_contrato_salvar(uuid, uuid, text, text, text), public.modelo_contrato_ativar(uuid, boolean),
  public.minuta_marcar_revisada(uuid)
to authenticated;
