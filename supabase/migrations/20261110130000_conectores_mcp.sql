-- =====================================================================
-- Prompt 12: conectores (Claude, ChatGPT) por MCP remoto + OAuth 2.1.
--
--  - O LAW é o servidor de autorização (OAuth 2.1 com PKCE obrigatório, registro dinâmico de cliente) e o servidor
--    MCP (/api/mcp). Tokens são aleatórios e opacos; o banco guarda só o hash SHA-256.
--  - Cada requisição MCP roda as MESMAS funções da Lia (Prompt 11) com um JWT de curta duração do próprio usuário
--    (claim "law_canal": "mcp"). A RLS vale integralmente: o conector vê exatamente o que o usuário vê.
--  - Canal externo + escritório sem permissão do dono => processos em segredo de justiça SOMEM de todas as buscas
--    (nem número). Com a permissão, aparecem como na Lia (sem partes, título ou texto).
--  - Escopos: law.read (leitura) e law.write (escrita). O teto de escopos é por cliente OAuth (perfil detectado pelo
--    endereço de retorno: Claude = leitura+escrita; ChatGPT e outros = só leitura) e pode ser mudado por cliente.
--  - Concessão = (cliente, usuário, escritório). Revogar a concessão invalida todos os tokens NA HORA: cada chamada
--    MCP confere o token no banco. Remover o membro apaga a concessão (cascata).
--  - Limite por token (por minuto) e por concessão (por dia). Toda chamada de ferramenta fica em mcp_chamada;
--    escrita passa pelo rascunho (origem 'mcp') e grava em audit_log.
-- =====================================================================

alter table public.escritorio
  add column conectores_ativos boolean not null default true,
  add column conectores_expor_sigilo boolean not null default false;

-- Canal externo = requisição feita pelo servidor MCP (JWT emitido pelo LAW com law_canal = mcp).
create or replace function public._canal_externo()
returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'law_canal', '') = 'mcp'
$$;

create or replace function public._sigilo_oculto(p_escritorio uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select public._canal_externo()
     and not coalesce((select conectores_expor_sigilo from public.escritorio where id = p_escritorio), false)
$$;

create or replace function public._processo_sigiloso(p_processo uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$ select coalesce((select segredo_justica from public.processo where id = p_processo), false) $$;

-- A Lia (e os conectores) exigem o módulo 'assistente'; no canal externo, também os conectores ligados pelo dono.
create or replace function public._exigir_assistente(p_escritorio uuid)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '42501'; end if;
  if not public.pode_ver(p_escritorio, 'assistente') then raise exception 'sem_permissao' using errcode = '42501'; end if;
  if public._canal_externo() and not coalesce((select conectores_ativos from public.escritorio where id = p_escritorio), false) then
    raise exception 'conectores_desligados' using errcode = '42501';
  end if;
end;
$$;

alter table public.assistente_rascunho
  add column origem text not null default 'lia' check (origem in ('lia','mcp'));

-- Ferramentas de leitura redefinidas: mesmo corpo do Prompt 11 + filtro de segredo de justiça no canal externo.
create or replace function public.assistente_buscar_processos(p_escritorio uuid, p_termo text default null, p_limite int default 10)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_t text := public.normalizar_nome(p_termo);
  v_dig text := regexp_replace(coalesce(p_termo, ''), '\D', '', 'g');
  v_lim int := public._assistente_limite(p_limite);
  v_oculto boolean := public._sigilo_oculto(p_escritorio);
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
        and not (p.segredo_justica and v_oculto)
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
  v_oculto boolean := public._sigilo_oculto(p_escritorio);
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
      and not (v_oculto and public._processo_sigiloso(pz.processo_id))
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
  v_oculto boolean := public._sigilo_oculto(p_escritorio);
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
      and not (v_oculto and ta.processo_id is not null and public._processo_sigiloso(ta.processo_id))
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
  v_oculto boolean := public._sigilo_oculto(p_escritorio);
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
      and not (v_oculto and l.processo_id is not null and public._processo_sigiloso(l.processo_id))
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
  v_oculto boolean := public._sigilo_oculto(p_escritorio);
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
      and not (v_oculto and coalesce(pr.segredo_justica, false))
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
  insert into public.assistente_rascunho (escritorio_id, conversa_id, usuario_id, tipo, dados, resumo, avisos, origem)
  values (v_esc, p_conversa, auth.uid(), p_tipo, p_dados, left(btrim(p_resumo), 500), coalesce(p_avisos, '[]'),
          case when public._canal_externo() then 'mcp' else 'lia' end)
  returning id into v_id;
  return v_id;
end;
$$;

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
    if p.segredo_justica and public._sigilo_oculto(p_escritorio) then raise exception 'sem_permissao' using errcode = '42501', detail = 'sigilo'; end if;
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
-- OAuth 2.1
-- =====================================================================
-- Perfis de cliente: teto de escopos pelo host do endereço de retorno. "outro" = qualquer cliente não reconhecido.
create table public.oauth_perfil (
  perfil text primary key check (perfil ~ '^[a-z]{2,20}$'),
  nome text not null,
  hosts text[] not null default '{}',
  escopos_max text[] not null check (escopos_max <@ array['law.read','law.write']::text[])
);
insert into public.oauth_perfil (perfil, nome, hosts, escopos_max) values
  ('claude', 'Claude', array['claude.ai','claude.com'], array['law.read','law.write']),
  ('chatgpt', 'ChatGPT', array['chatgpt.com','chat.openai.com'], array['law.read']),
  ('outro', 'Outro aplicativo', '{}', array['law.read']);

create table public.oauth_cliente (
  id text primary key default ('law_' || replace(gen_random_uuid()::text, '-', '')),
  nome text not null check (length(btrim(nome)) between 1 and 100),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
  perfil text not null references public.oauth_perfil(perfil),
  -- Teto de escopos DESTE cliente (configurável por cliente; nasce do perfil).
  escopos_permitidos text[] not null check (escopos_permitidos <@ array['law.read','law.write']::text[] and cardinality(escopos_permitidos) >= 1),
  metodo_auth text not null default 'none' check (metodo_auth in ('none','client_secret_post','client_secret_basic')),
  segredo_hash text null check (segredo_hash is null or segredo_hash ~ '^[0-9a-f]{64}$'),
  criado_em timestamptz not null default now(),
  desativado_em timestamptz null,
  check ((metodo_auth = 'none') = (segredo_hash is null))
);

create table public.oauth_concessao (
  id uuid primary key default gen_random_uuid(),
  cliente_id text not null references public.oauth_cliente(id) on delete cascade,
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  membro_id uuid not null references public.membro(id) on delete cascade,
  usuario_id uuid not null references auth.users(id) on delete cascade,
  escopos text[] not null check (escopos <@ array['law.read','law.write']::text[] and cardinality(escopos) >= 1),
  conversa_id uuid null references public.assistente_conversa(id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  ultimo_uso_em timestamptz null,
  revogada_em timestamptz null,
  revogada_por uuid null,
  motivo_revogacao text null
);
create unique index oauth_concessao_ativa on public.oauth_concessao (cliente_id, usuario_id, escritorio_id) where revogada_em is null;
create index oauth_concessao_escritorio_idx on public.oauth_concessao (escritorio_id, criado_em desc);

create table public.oauth_codigo (
  hash text primary key check (hash ~ '^[0-9a-f]{64}$'),
  concessao_id uuid not null references public.oauth_concessao(id) on delete cascade,
  cliente_id text not null,
  redirect_uri text not null,
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  escopos text[] not null,
  recurso text not null,
  expira_em timestamptz not null,
  usado_em timestamptz null
);

create table public.oauth_token (
  id uuid primary key default gen_random_uuid(),
  concessao_id uuid not null references public.oauth_concessao(id) on delete cascade,
  tipo text not null check (tipo in ('acesso','refresh')),
  hash text not null unique check (hash ~ '^[0-9a-f]{64}$'),
  escopos text[] not null,
  codigo_hash text null,
  expira_em timestamptz not null,
  revogado_em timestamptz null,
  substituido_em timestamptz null,
  janela_inicio timestamptz null,
  janela_contagem int not null default 0,
  criado_em timestamptz not null default now()
);
create index oauth_token_concessao_idx on public.oauth_token (concessao_id);

-- Registro de cada chamada de ferramenta pelo conector (só-acréscimo).
create table public.mcp_chamada (
  id bigint generated always as identity primary key,
  concessao_id uuid not null references public.oauth_concessao(id) on delete cascade,
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  usuario_id uuid not null,
  ferramenta text not null check (length(ferramenta) <= 60),
  escrita boolean not null default false,
  ok boolean not null,
  codigo text null check (codigo is null or length(codigo) <= 60),
  criado_em timestamptz not null default now()
);
create index mcp_chamada_concessao_idx on public.mcp_chamada (concessao_id, criado_em desc);
create trigger mcp_chamada_imutavel before update or delete on public.mcp_chamada
  for each row execute function public.assistente_bloquear_alteracao();

create trigger auditoria_oauth_concessao after insert or update or delete on public.oauth_concessao
  for each row execute function public.registrar_auditoria();

alter table public.oauth_perfil enable row level security;
alter table public.oauth_cliente enable row level security;
alter table public.oauth_concessao enable row level security;
alter table public.oauth_codigo enable row level security;
alter table public.oauth_token enable row level security;
alter table public.mcp_chamada enable row level security;

-- Concessões e chamadas: cada um vê as suas; o dono vê as do escritório. Clientes, códigos e tokens: ninguém pela API.
create policy oauth_concessao_select on public.oauth_concessao for select to authenticated
  using (usuario_id = auth.uid() or public.eh_dono(escritorio_id));
create policy mcp_chamada_select on public.mcp_chamada for select to authenticated
  using (usuario_id = auth.uid() or public.eh_dono(escritorio_id));

revoke all on public.oauth_perfil, public.oauth_cliente, public.oauth_concessao, public.oauth_codigo, public.oauth_token, public.mcp_chamada
  from public, anon, authenticated;
grant select on public.oauth_concessao, public.mcp_chamada to authenticated;

-- ---------------------------------------------------------------------
-- Registro dinâmico de cliente (RFC 7591) — servidor do LAW (service_role)
-- ---------------------------------------------------------------------
create or replace function public._oauth_uri_valida(p text)
returns boolean
language sql immutable
set search_path = ''
as $$
  select p ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[^\s#]*)?$'
      or p ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/[^\s#]*)?$'
$$;

create or replace function public.oauth_cliente_registrar(p_nome text, p_redirect_uris text[], p_metodo text, p_segredo_hash text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_perfil text := 'outro';
  v_hosts text[];
  v_c public.oauth_cliente;
begin
  if coalesce(cardinality(p_redirect_uris), 0) not between 1 and 10
     or exists (select 1 from unnest(p_redirect_uris) u where not public._oauth_uri_valida(u) or length(u) > 500) then
    raise exception 'redirect_uri_invalida' using errcode = '22023';
  end if;
  v_hosts := array(select lower(substring(u from '^https?://([^/:]+)')) from unnest(p_redirect_uris) u);
  -- Perfil só é reconhecido se TODOS os endereços de retorno forem do mesmo produto.
  select pf.perfil into v_perfil from public.oauth_perfil pf
  where pf.perfil <> 'outro' and v_hosts <@ pf.hosts limit 1;
  v_perfil := coalesce(v_perfil, 'outro');
  insert into public.oauth_cliente (nome, redirect_uris, perfil, escopos_permitidos, metodo_auth, segredo_hash)
  values (coalesce(nullif(left(btrim(coalesce(p_nome, '')), 100), ''), 'Aplicativo sem nome'), p_redirect_uris, v_perfil,
          (select escopos_max from public.oauth_perfil where perfil = v_perfil), coalesce(p_metodo, 'none'), p_segredo_hash)
  returning * into v_c;
  return jsonb_build_object('client_id', v_c.id, 'perfil', v_c.perfil, 'escopos', to_jsonb(v_c.escopos_permitidos),
    'nome', v_c.nome, 'redirect_uris', to_jsonb(v_c.redirect_uris), 'metodo_auth', v_c.metodo_auth,
    'criado_em', extract(epoch from v_c.criado_em)::bigint);
end;
$$;

-- Dados públicos do cliente para a tela de consentimento (usuário logado).
create or replace function public.oauth_cliente_publico(p_cliente text)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object('id', c.id, 'nome', c.nome, 'perfil', c.perfil, 'perfil_nome', pf.nome,
    'redirect_uris', to_jsonb(c.redirect_uris), 'escopos_permitidos', to_jsonb(c.escopos_permitidos))
  from public.oauth_cliente c join public.oauth_perfil pf on pf.perfil = c.perfil
  where c.id = p_cliente and c.desativado_em is null
$$;

-- ---------------------------------------------------------------------
-- Consentimento (usuário logado): cria/atualiza a concessão e um código de uso único (10 min)
-- ---------------------------------------------------------------------
create or replace function public.oauth_autorizar(
  p_cliente text, p_escritorio uuid, p_escopos text[], p_redirect_uri text, p_code_challenge text, p_code_hash text, p_recurso text
) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  c public.oauth_cliente;
  v_membro public.membro;
  v_escopos text[];
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '42501'; end if;
  select * into c from public.oauth_cliente where id = p_cliente and desativado_em is null;
  if not found then raise exception 'cliente_invalido' using errcode = '22023'; end if;
  if not (p_redirect_uri = any(c.redirect_uris)) then raise exception 'redirect_uri_invalida' using errcode = '22023'; end if;
  if p_code_challenge is null or p_code_challenge !~ '^[A-Za-z0-9_-]{43}$' then raise exception 'pkce_invalido' using errcode = '22023'; end if;
  select * into v_membro from public.membro where escritorio_id = p_escritorio and usuario_id = auth.uid();
  if not found or not public.pode_ver(p_escritorio, 'assistente') then raise exception 'sem_permissao' using errcode = '42501'; end if;
  if not (select conectores_ativos from public.escritorio where id = p_escritorio) then raise exception 'conectores_desligados' using errcode = '42501'; end if;
  v_escopos := array(select e from unnest(coalesce(p_escopos, '{}')) e where e = any(c.escopos_permitidos) group by e order by e);
  if cardinality(v_escopos) = 0 then raise exception 'escopo_invalido' using errcode = '22023'; end if;

  select id into v_id from public.oauth_concessao
  where cliente_id = c.id and usuario_id = auth.uid() and escritorio_id = p_escritorio and revogada_em is null for update;
  if v_id is null then
    insert into public.oauth_concessao (cliente_id, escritorio_id, membro_id, usuario_id, escopos)
    values (c.id, p_escritorio, v_membro.id, auth.uid(), v_escopos) returning id into v_id;
  else
    update public.oauth_concessao set escopos = v_escopos, atualizado_em = now() where id = v_id;
  end if;
  insert into public.oauth_codigo (hash, concessao_id, cliente_id, redirect_uri, code_challenge, escopos, recurso, expira_em)
  values (p_code_hash, v_id, c.id, p_redirect_uri, p_code_challenge, v_escopos, p_recurso, now() + interval '10 minutes');
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Endpoint de token (service_role). Os hashes dos tokens novos vêm do servidor do LAW.
-- ---------------------------------------------------------------------
create or replace function public._oauth_cliente_autenticado(p_cliente text, p_segredo_hash text)
returns public.oauth_cliente
language plpgsql stable security definer
set search_path = ''
as $$
declare c public.oauth_cliente;
begin
  select * into c from public.oauth_cliente where id = p_cliente and desativado_em is null;
  if not found then raise exception 'invalid_client' using errcode = '28000'; end if;
  if c.metodo_auth <> 'none' and (p_segredo_hash is null or p_segredo_hash <> c.segredo_hash) then
    raise exception 'invalid_client' using errcode = '28000';
  end if;
  return c;
end;
$$;

create or replace function public._oauth_emitir(
  p_concessao uuid, p_escopos text[], p_codigo text, p_acesso_hash text, p_refresh_hash text, p_acesso_seg int, p_refresh_seg int
) returns void
language sql security definer
set search_path = ''
as $$
  insert into public.oauth_token (concessao_id, tipo, hash, escopos, codigo_hash, expira_em) values
    (p_concessao, 'acesso', p_acesso_hash, p_escopos, p_codigo, now() + make_interval(secs => p_acesso_seg)),
    (p_concessao, 'refresh', p_refresh_hash, p_escopos, p_codigo, now() + make_interval(secs => p_refresh_seg));
$$;

create or replace function public.oauth_trocar_codigo(
  p_code_hash text, p_cliente text, p_redirect_uri text, p_challenge_calculado text, p_segredo_hash text, p_recurso text,
  p_acesso_hash text, p_refresh_hash text, p_acesso_seg int, p_refresh_seg int
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  c public.oauth_cliente := public._oauth_cliente_autenticado(p_cliente, p_segredo_hash);
  k public.oauth_codigo;
  v_ativa boolean;
begin
  select * into k from public.oauth_codigo where hash = p_code_hash for update;
  if not found or k.cliente_id <> c.id then raise exception 'invalid_grant' using errcode = '22023'; end if;
  -- A partir daqui as recusas DEVOLVEM {"erro"} em vez de levantar exceção: o que foi gravado (código queimado,
  -- tokens derrubados) precisa ficar gravado, e uma exceção desfaria tudo.
  if k.usado_em is not null then
    -- Código reaproveitado: derruba os tokens emitidos a partir dele (OAuth 2.1).
    update public.oauth_token set revogado_em = now() where codigo_hash = k.hash and revogado_em is null;
    return jsonb_build_object('erro', 'invalid_grant');
  end if;
  update public.oauth_codigo set usado_em = now() where hash = k.hash;
  if k.expira_em < now() or k.redirect_uri <> p_redirect_uri or k.code_challenge <> p_challenge_calculado
     or (p_recurso is not null and p_recurso <> k.recurso) then
    return jsonb_build_object('erro', 'invalid_grant');
  end if;
  select revogada_em is null into v_ativa from public.oauth_concessao where id = k.concessao_id;
  if not coalesce(v_ativa, false) then return jsonb_build_object('erro', 'invalid_grant'); end if;
  perform public._oauth_emitir(k.concessao_id, k.escopos, k.hash, p_acesso_hash, p_refresh_hash, p_acesso_seg, p_refresh_seg);
  return jsonb_build_object('escopos', to_jsonb(k.escopos), 'expires_in', p_acesso_seg);
end;
$$;

create or replace function public.oauth_renovar(
  p_refresh_hash text, p_cliente text, p_segredo_hash text, p_acesso_hash text, p_refresh_hash_novo text, p_acesso_seg int, p_refresh_seg int
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  c public.oauth_cliente := public._oauth_cliente_autenticado(p_cliente, p_segredo_hash);
  t public.oauth_token;
  g public.oauth_concessao;
  v_escopos text[];
begin
  select * into t from public.oauth_token where hash = p_refresh_hash and tipo = 'refresh' for update;
  if not found then raise exception 'invalid_grant' using errcode = '22023'; end if;
  select * into g from public.oauth_concessao where id = t.concessao_id for update;
  if g.cliente_id <> c.id then raise exception 'invalid_grant' using errcode = '22023'; end if;
  if t.substituido_em is not null or t.revogado_em is not null then
    -- Refresh já usado = possível roubo: revoga a concessão inteira.
    if g.revogada_em is null then
      update public.oauth_concessao set revogada_em = now(), motivo_revogacao = 'refresh_reutilizado' where id = g.id;
    end if;
    update public.oauth_token set revogado_em = now() where concessao_id = g.id and revogado_em is null;
    return jsonb_build_object('erro', 'invalid_grant'); -- sem exceção: a revogação precisa ficar gravada
  end if;
  if g.revogada_em is not null or t.expira_em < now() then raise exception 'invalid_grant' using errcode = '22023'; end if;
  -- Escopos nunca crescem no refresh (e caem se a concessão encolheu).
  v_escopos := array(select e from unnest(t.escopos) e where e = any(g.escopos) order by e);
  if cardinality(v_escopos) = 0 then raise exception 'invalid_grant' using errcode = '22023'; end if;
  update public.oauth_token set substituido_em = now() where id = t.id;
  perform public._oauth_emitir(g.id, v_escopos, t.codigo_hash, p_acesso_hash, p_refresh_hash_novo, p_acesso_seg, p_refresh_seg);
  return jsonb_build_object('escopos', to_jsonb(v_escopos), 'expires_in', p_acesso_seg);
end;
$$;

-- RFC 7009: revogar um token derruba os tokens da mesma concessão (a concessão continua; o cliente pode reautorizar).
create or replace function public.oauth_revogar_token(p_hash text, p_cliente text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare v_conc uuid;
begin
  select t.concessao_id into v_conc from public.oauth_token t join public.oauth_concessao g on g.id = t.concessao_id
  where t.hash = p_hash and g.cliente_id = p_cliente;
  if v_conc is not null then
    update public.oauth_token set revogado_em = now() where concessao_id = v_conc and revogado_em is null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Cada requisição MCP: confere o token NO BANCO (revogação vale na hora) e aplica o limite.
-- ---------------------------------------------------------------------
create or replace function public.mcp_autenticar(p_acesso_hash text, p_limite_minuto int, p_limite_dia int)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  t public.oauth_token;
  g public.oauth_concessao;
  m public.membro;
  v_cliente text;
  v_perfil text;
  v_conversa uuid;
begin
  select * into t from public.oauth_token where hash = p_acesso_hash and tipo = 'acesso' for update;
  if not found or t.revogado_em is not null or t.expira_em < now() then raise exception 'token_invalido' using errcode = '28000'; end if;
  select * into g from public.oauth_concessao where id = t.concessao_id;
  if g.revogada_em is not null then raise exception 'token_invalido' using errcode = '28000'; end if;
  select * into m from public.membro where id = g.membro_id;
  if not found then raise exception 'token_invalido' using errcode = '28000'; end if;
  -- A permissão pode ter sido tirada depois da autorização: confere a cada chamada.
  if not (m.papel = 'dono' or exists (select 1 from public.permissao_tela p where p.membro_id = m.id and p.modulo = 'assistente')) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  if not (select conectores_ativos from public.escritorio where id = g.escritorio_id) then
    raise exception 'conectores_desligados' using errcode = '42501';
  end if;

  if t.janela_inicio is null or t.janela_inicio < now() - interval '1 minute' then
    update public.oauth_token set janela_inicio = now(), janela_contagem = 1 where id = t.id;
  elsif t.janela_contagem >= p_limite_minuto then
    raise exception 'limite_excedido' using errcode = '54000';
  else
    update public.oauth_token set janela_contagem = janela_contagem + 1 where id = t.id;
  end if;
  if (select count(*) from public.mcp_chamada where concessao_id = g.id and criado_em > now() - interval '1 day') >= p_limite_dia then
    raise exception 'limite_excedido' using errcode = '54000';
  end if;

  select c.nome, c.perfil into v_cliente, v_perfil from public.oauth_cliente c where c.id = g.cliente_id;
  v_conversa := g.conversa_id;
  if v_conversa is null then
    insert into public.assistente_conversa (escritorio_id, usuario_id, titulo)
    values (g.escritorio_id, g.usuario_id, left('Conector: ' || v_cliente, 120)) returning id into v_conversa;
    update public.oauth_concessao set conversa_id = v_conversa where id = g.id;
  end if;
  update public.oauth_concessao set ultimo_uso_em = now() where id = g.id;
  return jsonb_build_object('usuario_id', g.usuario_id, 'escritorio_id', g.escritorio_id, 'concessao_id', g.id,
    'escopos', to_jsonb(t.escopos), 'conversa_id', v_conversa, 'cliente', v_cliente, 'perfil', v_perfil);
end;
$$;

create or replace function public.mcp_registrar_chamada(p_concessao uuid, p_ferramenta text, p_escrita boolean, p_ok boolean, p_codigo text)
returns void
language sql security definer
set search_path = ''
as $$
  insert into public.mcp_chamada (concessao_id, escritorio_id, usuario_id, ferramenta, escrita, ok, codigo)
  select g.id, g.escritorio_id, g.usuario_id, left(p_ferramenta, 60), coalesce(p_escrita, false), p_ok, left(p_codigo, 60)
  from public.oauth_concessao g where g.id = p_concessao
$$;

-- ---------------------------------------------------------------------
-- Tela "Conexões" (usuário logado)
-- ---------------------------------------------------------------------
create or replace function public.conexoes_listar(p_escritorio uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare v_dono boolean := public.eh_dono(p_escritorio);
begin
  if not public.eh_membro(p_escritorio) then raise exception 'sem_permissao' using errcode = '42501'; end if;
  return jsonb_build_object(
    'dono', v_dono,
    'conectores_ativos', (select conectores_ativos from public.escritorio where id = p_escritorio),
    'expor_sigilo', (select conectores_expor_sigilo from public.escritorio where id = p_escritorio),
    'conexoes', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', g.id, 'cliente', c.nome, 'perfil', c.perfil, 'escopos', to_jsonb(g.escopos),
        'pessoa', coalesce(nullif(m.nome, ''), m.email), 'minha', g.usuario_id = auth.uid(),
        'criado_em', g.criado_em, 'ultimo_uso_em', g.ultimo_uso_em, 'revogada_em', g.revogada_em, 'motivo', g.motivo_revogacao,
        'chamadas_24h', (select count(*) from public.mcp_chamada x where x.concessao_id = g.id and x.criado_em > now() - interval '1 day'),
        'escritas_24h', (select count(*) from public.mcp_chamada x where x.concessao_id = g.id and x.escrita and x.ok and x.criado_em > now() - interval '1 day')
      ) order by g.revogada_em is not null, g.criado_em desc), '[]'::jsonb)
      from public.oauth_concessao g
      join public.oauth_cliente c on c.id = g.cliente_id
      join public.membro m on m.id = g.membro_id
      where g.escritorio_id = p_escritorio and (g.usuario_id = auth.uid() or v_dono)
        and (g.revogada_em is null or g.revogada_em > now() - interval '30 days'))
  );
end;
$$;

create or replace function public.conexao_revogar(p_concessao uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare g public.oauth_concessao;
begin
  select * into g from public.oauth_concessao where id = p_concessao for update;
  if not found or not (g.usuario_id = auth.uid() or public.eh_dono(g.escritorio_id)) then
    raise exception 'nao_encontrado' using errcode = 'P0002';
  end if;
  if g.revogada_em is null then
    update public.oauth_concessao set revogada_em = now(), revogada_por = auth.uid(),
      motivo_revogacao = case when g.usuario_id = auth.uid() then 'usuario' else 'dono' end
    where id = g.id;
  end if;
  update public.oauth_token set revogado_em = now() where concessao_id = g.id and revogado_em is null;
end;
$$;

create or replace function public.conectores_configurar(p_escritorio uuid, p_ativos boolean, p_expor_sigilo boolean)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.eh_dono(p_escritorio) then raise exception 'sem_permissao' using errcode = '42501'; end if;
  update public.escritorio set conectores_ativos = coalesce(p_ativos, conectores_ativos),
    conectores_expor_sigilo = coalesce(p_expor_sigilo, conectores_expor_sigilo)
  where id = p_escritorio;
end;
$$;

-- ---------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------
revoke execute on function public._canal_externo(), public._sigilo_oculto(uuid), public._processo_sigiloso(uuid) from public, anon;
grant execute on function public._canal_externo(), public._sigilo_oculto(uuid), public._processo_sigiloso(uuid) to authenticated;

revoke execute on function public.oauth_cliente_registrar(text, text[], text, text), public._oauth_cliente_autenticado(text, text),
  public._oauth_emitir(uuid, text[], text, text, text, int, int),
  public.oauth_trocar_codigo(text, text, text, text, text, text, text, text, int, int),
  public.oauth_renovar(text, text, text, text, text, int, int), public.oauth_revogar_token(text, text),
  public.mcp_autenticar(text, int, int), public.mcp_registrar_chamada(uuid, text, boolean, boolean, text)
from public, anon, authenticated;
grant execute on function public.oauth_cliente_registrar(text, text[], text, text),
  public.oauth_trocar_codigo(text, text, text, text, text, text, text, text, int, int),
  public.oauth_renovar(text, text, text, text, text, int, int), public.oauth_revogar_token(text, text),
  public.mcp_autenticar(text, int, int), public.mcp_registrar_chamada(uuid, text, boolean, boolean, text)
to service_role;

revoke execute on function public.oauth_cliente_publico(text), public.oauth_autorizar(text, uuid, text[], text, text, text, text),
  public.conexoes_listar(uuid), public.conexao_revogar(uuid), public.conectores_configurar(uuid, boolean, boolean) from public, anon;
grant execute on function public.oauth_cliente_publico(text), public.oauth_autorizar(text, uuid, text[], text, text, text, text),
  public.conexoes_listar(uuid), public.conexao_revogar(uuid), public.conectores_configurar(uuid, boolean, boolean) to authenticated;
