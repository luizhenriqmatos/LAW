-- Prompt 2 — Motor de captura de publicações e processos
-- Publicações do DJEN, metadados do DataJud e registro de cada execução do job.
-- Gravação só pelo job no servidor (papel service_role, via funções captura_*). O app só lê.

-- =====================================================================
-- Escritório: controle da captura
-- =====================================================================
alter table public.escritorio
  add column ativo boolean not null default true,
  add column ultima_captura_ok_em timestamptz null,
  add column ultima_captura_ate date null;

-- =====================================================================
-- Tabelas
-- =====================================================================
create table public.captura_execucao (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  origem text not null check (origem in ('agendada','onboarding','manual','teste')),
  iniciada_em timestamptz not null default now(),
  terminada_em timestamptz null,
  status text not null default 'rodando' check (status in ('rodando','sucesso','parcial','erro')),
  desde date not null,
  ate date not null,
  encontradas int not null default 0,
  novas int not null default 0,
  duplicadas int not null default 0,
  processos_enriquecidos int not null default 0,
  -- [{ fonte, codigo, mensagem, alvo? }] — sem dado pessoal além da OAB/nome monitorado
  erros jsonb not null default '[]'::jsonb check (jsonb_typeof(erros) = 'array')
);
create index captura_execucao_escritorio_idx on public.captura_execucao (escritorio_id, iniciada_em desc);

create table public.publicacao (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  fonte text not null check (fonte ~ '^[a-z_]{2,30}$'),
  id_externo text null,
  -- tribunal + nº do processo + data de disponibilização + texto normalizado (SHA-256)
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  data_disponibilizacao date not null,
  -- estimada: 1º dia útil seguinte (só fins de semana e feriados nacionais fixos; Prompt 4 refina)
  data_publicacao date null,
  tribunal text not null,
  orgao text null,
  tipo_comunicacao text null,
  tipo_documento text null,
  classe text null,
  texto text not null,
  numero_cnj text null check (numero_cnj is null or numero_cnj ~ '^\d{20}$'),
  numeros_citados text[] not null default '{}',
  advogados jsonb not null default '[]'::jsonb check (jsonb_typeof(advogados) = 'array'),
  destinatarios jsonb not null default '[]'::jsonb check (jsonb_typeof(destinatarios) = 'array'),
  link text null check (link is null or link ~* '^https://'),
  bruto jsonb not null,
  status_triagem text not null default 'pendente'
    check (status_triagem in ('pendente','vinculada','sem_processo','descartada')),
  captura_id uuid null references public.captura_execucao(id) on delete set null,
  capturada_em timestamptz not null default now(),
  unique (escritorio_id, hash)
);
create index publicacao_triagem_idx on public.publicacao (escritorio_id, status_triagem, data_disponibilizacao desc);
create index publicacao_cnj_idx on public.publicacao (escritorio_id, numero_cnj);

create table public.processo_metadados (
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  numero_cnj text not null check (numero_cnj ~ '^\d{20}$'),
  fonte text not null,
  dados jsonb null,         -- null = consultado e não encontrado (ou sigiloso)
  erro text null,           -- preenchido quando a consulta falhou
  atualizado_em timestamptz not null default now(),
  primary key (escritorio_id, numero_cnj)
);

-- =====================================================================
-- Funções do job (só service_role executa)
-- =====================================================================

-- Escritórios ativos com configuração de monitoramento e seus alvos.
create or replace function public.captura_alvos(p_escritorio uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(x order by x->>'escritorio_id'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'escritorio_id', e.id,
      'ultima_captura_ate', e.ultima_captura_ate,
      'alvos', jsonb_agg(jsonb_build_object(
        'tipo', a.tipo, 'oab_numero', a.oab_numero, 'oab_uf', a.oab_uf, 'cnpj', a.cnpj, 'nome', a.nome_sociedade
      ) order by a.criado_em)
    ) as x
    from public.escritorio e
    join public.alvo_monitoramento a on a.escritorio_id = e.id
    where e.ativo and e.modo_monitoramento is not null
      and (p_escritorio is null or e.id = p_escritorio)
    group by e.id
  ) s
$$;

create or replace function public.captura_iniciar(p_escritorio uuid, p_origem text, p_desde date, p_ate date)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.captura_execucao (escritorio_id, origem, desde, ate)
  values (p_escritorio, p_origem, p_desde, p_ate)
  returning id into v_id;
  update public.escritorio set status_monitoramento = 'buscando' where id = p_escritorio;
  return v_id;
end;
$$;

-- Grava em lote; repetidas (mesmo hash no escritório) são ignoradas. Devolve quantas eram novas.
create or replace function public.captura_salvar_publicacoes(p_escritorio uuid, p_execucao uuid, p_itens jsonb)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_novas int;
begin
  with ins as (
    insert into public.publicacao (
      escritorio_id, fonte, id_externo, hash, data_disponibilizacao, data_publicacao, tribunal, orgao,
      tipo_comunicacao, tipo_documento, classe, texto, numero_cnj, numeros_citados, advogados, destinatarios,
      link, bruto, captura_id
    )
    select p_escritorio, x.fonte, x.id_externo, x.hash, x.data_disponibilizacao, x.data_publicacao, x.tribunal, x.orgao,
           x.tipo_comunicacao, x.tipo_documento, x.classe, x.texto, x.numero_cnj,
           coalesce(x.numeros_citados, '{}'), coalesce(x.advogados, '[]'::jsonb), coalesce(x.destinatarios, '[]'::jsonb),
           x.link, x.bruto, p_execucao
    from jsonb_to_recordset(p_itens) as x(
      fonte text, id_externo text, hash text, data_disponibilizacao date, data_publicacao date, tribunal text, orgao text,
      tipo_comunicacao text, tipo_documento text, classe text, texto text, numero_cnj text, numeros_citados text[],
      advogados jsonb, destinatarios jsonb, link text, bruto jsonb
    )
    on conflict (escritorio_id, hash) do nothing
    returning 1
  )
  select count(*) into v_novas from ins;
  return v_novas;
end;
$$;

-- Números ainda sem metadados recentes (consultados há menos de p_horas, com sucesso, ficam de fora).
create or replace function public.captura_numeros_pendentes(p_escritorio uuid, p_numeros text[], p_horas int default 24)
returns text[]
language sql stable
set search_path = ''
as $$
  select coalesce(array_agg(n order by n), '{}')
  from unnest(p_numeros) as n
  where not exists (
    select 1 from public.processo_metadados m
    where m.escritorio_id = p_escritorio and m.numero_cnj = n and m.erro is null
      and m.atualizado_em > now() - make_interval(hours => p_horas)
  )
$$;

create or replace function public.captura_salvar_metadados(p_escritorio uuid, p_numero text, p_fonte text, p_dados jsonb, p_erro text)
returns void
language sql
set search_path = ''
as $$
  insert into public.processo_metadados (escritorio_id, numero_cnj, fonte, dados, erro, atualizado_em)
  values (p_escritorio, p_numero, p_fonte, p_dados, p_erro, now())
  on conflict (escritorio_id, numero_cnj) do update
    set fonte = excluded.fonte,
        -- falha nova não apaga dado bom antigo
        dados = case when excluded.erro is null then excluded.dados else public.processo_metadados.dados end,
        erro = excluded.erro,
        atualizado_em = excluded.atualizado_em
$$;

-- Fecha a execução. Só avança "última captura OK" se TODAS as buscas de publicação deram certo:
-- assim a próxima execução cobre de novo o período que falhou.
create or replace function public.captura_finalizar(
  p_execucao uuid, p_status text, p_encontradas int, p_novas int, p_duplicadas int, p_enriquecidos int,
  p_erros jsonb, p_publicacoes_ok boolean
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  e public.captura_execucao%rowtype;
begin
  update public.captura_execucao
     set terminada_em = now(), status = p_status, encontradas = p_encontradas, novas = p_novas,
         duplicadas = p_duplicadas, processos_enriquecidos = p_enriquecidos, erros = coalesce(p_erros, '[]'::jsonb)
   where id = p_execucao
  returning * into e;
  update public.escritorio
     set status_monitoramento = case when p_publicacoes_ok then 'concluido' else 'erro' end,
         ultima_captura_ok_em = case when p_publicacoes_ok then now() else ultima_captura_ok_em end,
         ultima_captura_ate = case when p_publicacoes_ok then e.ate else ultima_captura_ate end
   where id = e.escritorio_id;
end;
$$;

-- =====================================================================
-- Auditoria: mudança de status de triagem (Prompt 3) e exclusão ficam registradas
-- =====================================================================
create trigger auditoria_publicacao after update or delete on public.publicacao
  for each row execute function public.registrar_auditoria();

-- =====================================================================
-- RLS
-- =====================================================================
alter table public.publicacao enable row level security;
alter table public.processo_metadados enable row level security;
alter table public.captura_execucao enable row level security;

-- Publicações e metadados: quem vê Processos ou Prazos.
create policy publicacao_select on public.publicacao for select to authenticated
  using (public.pode_ver(escritorio_id, 'processos') or public.pode_ver(escritorio_id, 'prazos'));
create policy publicacao_update on public.publicacao for update to authenticated
  using (public.pode_ver(escritorio_id, 'processos') or public.pode_ver(escritorio_id, 'prazos'))
  with check (public.pode_ver(escritorio_id, 'processos') or public.pode_ver(escritorio_id, 'prazos'));

create policy metadados_select on public.processo_metadados for select to authenticated
  using (public.pode_ver(escritorio_id, 'processos') or public.pode_ver(escritorio_id, 'prazos'));

-- Execuções: todo membro vê (o aviso de atraso precisa chegar a todos).
create policy captura_select on public.captura_execucao for select to authenticated
  using (public.eh_membro(escritorio_id));

-- =====================================================================
-- Privilégios
-- =====================================================================
revoke all on public.publicacao, public.processo_metadados, public.captura_execucao from anon;
revoke insert, update, delete, truncate on public.publicacao, public.processo_metadados, public.captura_execucao from authenticated;
-- Na publicação, o app só muda o status de triagem.
grant update (status_triagem) on public.publicacao to authenticated;
-- Colunas de controle da captura não são editáveis pelo app (escritorio já tem update só em nome e cnpj).

revoke execute on function public.captura_alvos(uuid) from public, anon, authenticated;
revoke execute on function public.captura_iniciar(uuid, text, date, date) from public, anon, authenticated;
revoke execute on function public.captura_salvar_publicacoes(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.captura_numeros_pendentes(uuid, text[], int) from public, anon, authenticated;
revoke execute on function public.captura_salvar_metadados(uuid, text, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.captura_finalizar(uuid, text, int, int, int, int, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.captura_alvos(uuid) to service_role;
grant execute on function public.captura_iniciar(uuid, text, date, date) to service_role;
grant execute on function public.captura_salvar_publicacoes(uuid, uuid, jsonb) to service_role;
grant execute on function public.captura_numeros_pendentes(uuid, text[], int) to service_role;
grant execute on function public.captura_salvar_metadados(uuid, text, text, jsonb, text) to service_role;
grant execute on function public.captura_finalizar(uuid, text, int, int, int, int, jsonb, boolean) to service_role;
