-- Prompt 8 — Motor de cálculo por trechos (cível), índices oficiais em cache e cálculos salvos.
--
-- Princípio: a mesma dívida pode passar por regras diferentes ao longo do tempo. O motor (TypeScript, decimal de alta
-- precisão) corta a linha do tempo em trechos e aplica o regime de cada trecho. Aqui ficam só os DADOS:
--   * índices (cache do SGS do Banco Central; o cálculo nunca chama a API em tempo real);
--   * regimes (dados, não código; nunca alterados: mudança = nova versão);
--   * cálculos salvos (parâmetros + resultado congelado, para o cálculo antigo continuar reproduzível).

-- ---------------------------------------------------------------------
-- Novo módulo (tela) "calculos". Manter igual a src/lib/modulos.ts.
-- ---------------------------------------------------------------------
create or replace function public.modulos_validos()
returns text[]
language sql immutable
set search_path = ''
as $$
  select array['agenda','processos','prazos','tarefas','financeiro','calculos','documentos','portal_cliente','configuracoes']::text[]
$$;

create or replace function public._exigir_calculos(p_escritorio uuid)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '28000'; end if;
  if not public.pode_ver(p_escritorio, 'calculos') then raise exception 'sem_permissao' using errcode = '42501'; end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Índices (dado público do Banco Central). Leitura livre para quem está logado; escrita só pelo job (service_role).
-- ---------------------------------------------------------------------
create table public.indice_serie (
  codigo text primary key check (codigo in ('IPCA','IPCA_E','IPCA_15','INPC','IGP_M','TR','SELIC','TAXA_LEGAL')),
  sgs integer not null unique,
  nome text not null,
  fonte text not null,
  unidade text not null,
  coletado_em timestamptz null,
  ultimo_mes date null,
  erro text null,
  erro_em timestamptz null
);

create table public.indice_valor (
  serie text not null references public.indice_serie(codigo),
  mes date not null check (extract(day from mes) = 1),
  valor numeric(20,10) not null,
  coletado_em timestamptz not null default now(),
  primary key (serie, mes)
);

-- Códigos conferidos em 09/11/2026 contra a API do SGS e as opções da Calculadora do Cidadão (P-005).
insert into public.indice_serie (codigo, sgs, nome, fonte, unidade) values
  ('IPCA',       433,   'IPCA (IBGE)',                        'Banco Central do Brasil, SGS série 433',   '% ao mês'),
  ('IPCA_E',     10764, 'IPCA-E (IBGE)',                      'Banco Central do Brasil, SGS série 10764', '% ao mês'),
  ('IPCA_15',    7478,  'IPCA-15 (IBGE)',                     'Banco Central do Brasil, SGS série 7478',  '% ao mês'),
  ('INPC',       188,   'INPC (IBGE)',                        'Banco Central do Brasil, SGS série 188',   '% ao mês'),
  ('IGP_M',      28655, 'IGP-M (FGV)',                        'Banco Central do Brasil, SGS série 28655', '% ao mês'),
  ('TR',         7811,  'TR mensal (início no dia 1º)',        'Banco Central do Brasil, SGS série 7811',  '% ao mês'),
  ('SELIC',      4390,  'Selic acumulada no mês',             'Banco Central do Brasil, SGS série 4390',  '% ao mês'),
  ('TAXA_LEGAL', 29543, 'Taxa Legal (Res. CMN 5.171/2024)',   'Banco Central do Brasil, SGS série 29543', '% ao mês');

alter table public.indice_serie enable row level security;
alter table public.indice_valor enable row level security;
create policy indice_serie_select on public.indice_serie for select to authenticated using (true);
create policy indice_valor_select on public.indice_valor for select to authenticated using (true);
revoke insert, update, delete on public.indice_serie, public.indice_valor from authenticated, anon;

-- Grava (ou corrige) valores de uma série. Só o job (service_role). Valor revisado na fonte: atualiza e registra a
-- nova data de coleta; cálculos já salvos não mudam (o resultado fica congelado no cálculo).
create or replace function public.indices_gravar(p_serie text, p_valores jsonb, p_coletado_em timestamptz default now())
returns int
language plpgsql security definer
set search_path = ''
as $$
declare v_n int := 0; v jsonb;
begin
  if not exists (select 1 from public.indice_serie where codigo = p_serie) then raise exception 'serie_invalida' using errcode = '22023'; end if;
  for v in select * from jsonb_array_elements(coalesce(p_valores, '[]'::jsonb)) loop
    insert into public.indice_valor (serie, mes, valor, coletado_em)
    values (p_serie, (v->>'mes')::date, (v->>'valor')::numeric, p_coletado_em)
    on conflict (serie, mes) do update set valor = excluded.valor, coletado_em = excluded.coletado_em
      where public.indice_valor.valor is distinct from excluded.valor;
    v_n := v_n + 1;
  end loop;
  update public.indice_serie
     set coletado_em = p_coletado_em, erro = null, erro_em = null,
         ultimo_mes = (select max(mes) from public.indice_valor where serie = p_serie)
   where codigo = p_serie;
  return v_n;
end;
$$;

create or replace function public.indices_registrar_erro(p_serie text, p_erro text)
returns void
language sql security definer
set search_path = ''
as $$
  update public.indice_serie set erro = left(p_erro, 500), erro_em = now() where codigo = p_serie;
$$;

-- Leitura em bloco (a API limita linhas por consulta; aqui volta tudo de uma vez).
create or replace function public.indices_periodo(p_series text[], p_de date, p_ate date)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'series', coalesce((select jsonb_agg(jsonb_build_object(
        'codigo', s.codigo, 'sgs', s.sgs, 'nome', s.nome, 'fonte', s.fonte, 'coletado_em', s.coletado_em, 'ultimo_mes', s.ultimo_mes)
        order by s.codigo) from public.indice_serie s where s.codigo = any (p_series)), '[]'::jsonb),
    'valores', coalesce((select jsonb_object_agg(x.serie, x.v) from (
        select serie, jsonb_object_agg(to_char(mes, 'YYYY-MM'), valor::text order by mes) as v
        from public.indice_valor
        where serie = any (p_series) and mes >= date_trunc('month', p_de)::date and mes <= p_ate
        group by serie) x), '{}'::jsonb));
$$;

-- ---------------------------------------------------------------------
-- Regimes de atualização. escritorio_id nulo = regime padrão do LAW (vem por migração).
-- Nunca alterados: mudança vira nova versão (mesmo grupo_id, versao + 1); a anterior fica "inativa" mas continua
-- existindo, para o cálculo antigo continuar reproduzível.
-- ---------------------------------------------------------------------
create table public.regime_atualizacao (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid null references public.escritorio(id) on delete cascade,
  grupo_id uuid not null,
  versao int not null default 1 check (versao >= 1),
  ativo boolean not null default true,
  nome text not null check (length(btrim(nome)) between 3 and 120),
  escopo text not null check (escopo in ('civel','trabalhista','fazenda_pre_expedicao','fazenda_pos_expedicao')),
  vigencia_inicio date null,
  vigencia_fim date null, -- inclusive; nula = vigente
  fundamento text not null check (length(btrim(fundamento)) between 3 and 2000),
  correcao_indice text not null check (correcao_indice in ('IPCA','IPCA_E','IPCA_15','INPC','IGP_M','TR','nenhuma')),
  correcao_pro_rata boolean not null default false,
  indice_editavel boolean not null default false,
  juros_tipo text not null check (juros_tipo in ('nenhum','taxa_legal','percentual_fixo_ao_ano_simples','percentual_ao_mes','tr_art39_lei8177','selic_englobando_correcao_e_juros')),
  juros_valor numeric(10,6) null,
  juros_pro_rata boolean not null default true,
  teto text not null default 'nenhum' check (teto in ('nenhum','selic')),
  criado_por uuid null,
  criado_em timestamptz not null default now(),
  constraint regime_vigencia check (vigencia_fim is null or vigencia_inicio is null or vigencia_fim >= vigencia_inicio),
  constraint regime_juros_valor check ((juros_tipo in ('percentual_fixo_ao_ano_simples','percentual_ao_mes')) = (juros_valor is not null)),
  constraint regime_juros_faixa check (juros_valor is null or (juros_valor > 0 and juros_valor <= 100)),
  -- Lei 14.905/2024: Selic já engloba correção; não se soma outro índice no mesmo trecho.
  constraint regime_selic_sem_indice check (juros_tipo <> 'selic_englobando_correcao_e_juros' or correcao_indice = 'nenhuma'),
  unique (grupo_id, versao)
);
create index regime_escritorio_idx on public.regime_atualizacao (escritorio_id, escopo) where ativo;

create or replace function public.regime_imutavel()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'ativo') is distinct from (to_jsonb(old) - 'ativo') then
    raise exception 'regime_imutavel' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger regime_imutavel before update on public.regime_atualizacao for each row execute function public.regime_imutavel();
create trigger regime_sem_apagar before delete on public.regime_atualizacao for each row
  when (old.escritorio_id is null) execute function public.regime_imutavel();
create trigger auditoria_regime after insert or update on public.regime_atualizacao
  for each row when (new.escritorio_id is not null) execute function public.registrar_auditoria();

alter table public.regime_atualizacao enable row level security;
create policy regime_select on public.regime_atualizacao for select to authenticated
  using (escritorio_id is null or public.pode_ver(escritorio_id, 'calculos'));
revoke insert, update, delete on public.regime_atualizacao from authenticated, anon;

-- Regimes cíveis padrão. São SUGESTÃO: o contrato ou a decisão podem fixar outro critério.
insert into public.regime_atualizacao
  (id, escritorio_id, grupo_id, versao, nome, escopo, vigencia_inicio, vigencia_fim, fundamento,
   correcao_indice, correcao_pro_rata, indice_editavel, juros_tipo, juros_valor, juros_pro_rata)
values
  ('00000000-0000-4000-8000-000000000801', null, '00000000-0000-4000-8000-000000000801', 1,
   'Cível — até 29/08/2024 (índice escolhido + juros de 1% ao mês)', 'civel', null, '2024-08-29',
   'Código Civil, art. 406 (redação anterior à Lei 14.905/2024) c/c CTN, art. 161, § 1º: juros de mora de 1% ao mês, simples. Correção pelo índice convencionado ou fixado na decisão (padrão sugerido: INPC; Lei 6.899/1981).',
   'INPC', false, true, 'percentual_ao_mes', 1, true),
  ('00000000-0000-4000-8000-000000000802', null, '00000000-0000-4000-8000-000000000802', 1,
   'Cível — desde 30/08/2024 (IPCA + Taxa Legal, Lei 14.905/2024)', 'civel', '2024-08-30', null,
   'Lei 14.905/2024: Código Civil, art. 389, parágrafo único (correção pelo IPCA quando não houver índice convencionado) e art. 406, §§ 1º a 3º (juros pela Taxa Legal = Selic menos IPCA, piso zero; Resolução CMN 5.171/2024). Vedada a soma da Selic com outro índice de correção no mesmo período.',
   'IPCA', false, true, 'taxa_legal', null, true);

create or replace function public._regime_de_json(p jsonb, p_escritorio uuid, p_grupo uuid, p_versao int)
returns public.regime_atualizacao
language plpgsql
set search_path = ''
as $$
declare r public.regime_atualizacao;
begin
  r.id := gen_random_uuid();
  r.escritorio_id := p_escritorio;
  r.grupo_id := coalesce(p_grupo, r.id);
  r.versao := p_versao;
  r.ativo := true;
  r.nome := btrim(coalesce(p->>'nome', ''));
  r.escopo := coalesce(p->>'escopo', 'civel');
  r.vigencia_inicio := nullif(p->>'vigencia_inicio', '')::date;
  r.vigencia_fim := nullif(p->>'vigencia_fim', '')::date;
  r.fundamento := btrim(coalesce(p->>'fundamento', ''));
  r.correcao_indice := coalesce(p->>'correcao_indice', 'nenhuma');
  r.correcao_pro_rata := coalesce((p->>'correcao_pro_rata')::boolean, false);
  r.indice_editavel := coalesce((p->>'indice_editavel')::boolean, false);
  r.juros_tipo := coalesce(p->>'juros_tipo', 'nenhum');
  r.juros_valor := nullif(p->>'juros_valor', '')::numeric;
  r.juros_pro_rata := coalesce((p->>'juros_pro_rata')::boolean, true);
  r.teto := coalesce(p->>'teto', 'nenhum');
  r.criado_por := auth.uid();
  r.criado_em := now();
  if r.juros_tipo = 'selic_englobando_correcao_e_juros' and r.correcao_indice <> 'nenhuma' then
    raise exception 'selic_com_indice' using errcode = '22023';
  end if;
  if length(r.nome) < 3 or length(r.nome) > 120 then raise exception 'regime_sem_nome' using errcode = '22023'; end if;
  if length(r.fundamento) < 3 then raise exception 'fundamento_obrigatorio' using errcode = '22023'; end if;
  if r.vigencia_fim is not null and r.vigencia_inicio is not null and r.vigencia_fim < r.vigencia_inicio then
    raise exception 'vigencia_invalida' using errcode = '22023';
  end if;
  return r;
end;
$$;

-- Regime personalizado ("critério definido na sentença").
create or replace function public.regime_criar(p_escritorio uuid, p_dados jsonb)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare r public.regime_atualizacao;
begin
  perform public._exigir_calculos(p_escritorio);
  r := public._regime_de_json(p_dados, p_escritorio, null, 1);
  begin
    insert into public.regime_atualizacao select r.*;
  exception when check_violation then
    raise exception 'regime_invalido' using errcode = '22023';
  end;
  return r.id;
end;
$$;

-- Nova versão de um regime do escritório. A versão antiga fica guardada (inativa) para os cálculos que a usaram.
create or replace function public.regime_nova_versao(p_regime uuid, p_dados jsonb)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare a public.regime_atualizacao; r public.regime_atualizacao;
begin
  select * into a from public.regime_atualizacao where id = p_regime;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  if a.escritorio_id is null then raise exception 'regime_do_sistema' using errcode = '42501'; end if;
  perform public._exigir_calculos(a.escritorio_id);
  if not a.ativo then raise exception 'regime_desatualizado' using errcode = '22023'; end if;
  r := public._regime_de_json(p_dados, a.escritorio_id, a.grupo_id,
         (select max(versao) + 1 from public.regime_atualizacao where grupo_id = a.grupo_id));
  update public.regime_atualizacao set ativo = false where grupo_id = a.grupo_id and ativo;
  begin
    insert into public.regime_atualizacao select r.*;
  exception when check_violation then
    raise exception 'regime_invalido' using errcode = '22023';
  end;
  return r.id;
end;
$$;

create or replace function public.regime_arquivar(p_regime uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare a public.regime_atualizacao;
begin
  select * into a from public.regime_atualizacao where id = p_regime;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  if a.escritorio_id is null then raise exception 'regime_do_sistema' using errcode = '42501'; end if;
  perform public._exigir_calculos(a.escritorio_id);
  update public.regime_atualizacao set ativo = false where id = p_regime;
end;
$$;

-- ---------------------------------------------------------------------
-- Cálculos salvos e marcos processuais.
-- ---------------------------------------------------------------------
create table public.calculo (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  processo_id uuid null references public.processo(id),
  tipo text not null check (tipo in ('atualizacao','art523','honorarios')),
  titulo text not null check (length(btrim(titulo)) between 2 and 160),
  partes text null check (partes is null or length(partes) <= 500),
  parametros jsonb not null,
  regimes uuid[] not null default '{}',
  resultado jsonb not null,
  total_centavos bigint not null,
  data_calculo date not null,
  origem_id uuid null references public.calculo(id) on delete set null,
  pdf_drive_id text null,
  pdf_enviado_em timestamptz null,
  criado_por uuid null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index calculo_escritorio_idx on public.calculo (escritorio_id, atualizado_em desc);
create index calculo_processo_idx on public.calculo (processo_id) where processo_id is not null;

create table public.marco_processual (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  calculo_id uuid not null references public.calculo(id) on delete cascade,
  tipo text not null check (tipo in ('vencimento','citacao','ajuizamento','transito_em_julgado','intimacao','expedicao_requisitorio')),
  data date not null,
  unique (calculo_id, tipo)
);

alter table public.calculo enable row level security;
alter table public.marco_processual enable row level security;
create policy calculo_select on public.calculo for select to authenticated using (public.pode_ver(escritorio_id, 'calculos'));
create policy marco_select on public.marco_processual for select to authenticated using (public.pode_ver(escritorio_id, 'calculos'));
revoke insert, update, delete on public.calculo, public.marco_processual from authenticated, anon;

create trigger auditoria_calculo after insert or update or delete on public.calculo
  for each row execute function public.registrar_auditoria();

-- Salva (cria ou atualiza) um cálculo. O motor roda no servidor do app; aqui o banco confere a permissão,
-- o vínculo com o processo e se os regimes usados são visíveis ao escritório.
create or replace function public.calculo_salvar(p_escritorio uuid, p_id uuid, p_dados jsonb)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid := p_id;
  v_tipo text := p_dados->>'tipo';
  v_proc uuid := nullif(p_dados->>'processo_id', '')::uuid;
  v_origem uuid := nullif(p_dados->>'origem_id', '')::uuid;
  v_regimes uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p_dados->'regimes', '[]'::jsonb)) x), '{}');
  v_atual public.calculo;
  m jsonb;
begin
  perform public._exigir_calculos(p_escritorio);
  if v_tipo is null or v_tipo not in ('atualizacao','art523','honorarios') then raise exception 'tipo_invalido' using errcode = '22023'; end if;
  if jsonb_typeof(p_dados->'parametros') <> 'object' or jsonb_typeof(p_dados->'resultado') <> 'object' then
    raise exception 'dados_invalidos' using errcode = '22023';
  end if;
  if v_proc is not null and not exists (
    select 1 from public.processo where id = v_proc and escritorio_id = p_escritorio and status = 'confirmado') then
    raise exception 'processo_invalido' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_regimes) u(id) where not exists (
    select 1 from public.regime_atualizacao r where r.id = u.id and (r.escritorio_id is null or r.escritorio_id = p_escritorio))) then
    raise exception 'regime_invalido' using errcode = '22023';
  end if;
  if v_origem is not null and not exists (select 1 from public.calculo where id = v_origem and escritorio_id = p_escritorio) then
    v_origem := null;
  end if;

  if v_id is null then
    insert into public.calculo (escritorio_id, processo_id, tipo, titulo, partes, parametros, regimes, resultado, total_centavos,
                               data_calculo, origem_id, criado_por)
    values (p_escritorio, v_proc, v_tipo, btrim(p_dados->>'titulo'), nullif(btrim(p_dados->>'partes'), ''), p_dados->'parametros',
            v_regimes, p_dados->'resultado', (p_dados->>'total_centavos')::bigint, (p_dados->>'data_calculo')::date, v_origem, auth.uid())
    returning id into v_id;
  else
    select * into v_atual from public.calculo where id = v_id;
    if not found or v_atual.escritorio_id <> p_escritorio then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
    if v_atual.tipo <> v_tipo then raise exception 'tipo_invalido' using errcode = '22023'; end if;
    update public.calculo set
      processo_id = v_proc, titulo = btrim(p_dados->>'titulo'), partes = nullif(btrim(p_dados->>'partes'), ''),
      parametros = p_dados->'parametros', regimes = v_regimes, resultado = p_dados->'resultado',
      total_centavos = (p_dados->>'total_centavos')::bigint, data_calculo = (p_dados->>'data_calculo')::date,
      pdf_drive_id = null, pdf_enviado_em = null, atualizado_em = now()
    where id = v_id;
    delete from public.marco_processual where calculo_id = v_id;
  end if;

  for m in select * from jsonb_array_elements(coalesce(p_dados->'marcos', '[]'::jsonb)) loop
    if nullif(m->>'data', '') is not null then
      insert into public.marco_processual (escritorio_id, calculo_id, tipo, data)
      values (p_escritorio, v_id, m->>'tipo', (m->>'data')::date)
      on conflict (calculo_id, tipo) do update set data = excluded.data;
    end if;
  end loop;
  return v_id;
exception
  when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format then
    raise exception 'dados_invalidos' using errcode = '22023';
end;
$$;

create or replace function public.calculo_excluir(p_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare v_esc uuid;
begin
  select escritorio_id into v_esc from public.calculo where id = p_id;
  if v_esc is null then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_calculos(v_esc);
  update public.calculo set origem_id = null where origem_id = p_id;
  delete from public.calculo where id = p_id;
end;
$$;

create or replace function public.calculo_registrar_pdf(p_id uuid, p_drive_id text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare v_esc uuid;
begin
  select escritorio_id into v_esc from public.calculo where id = p_id;
  if v_esc is null then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_calculos(v_esc);
  update public.calculo set pdf_drive_id = left(p_drive_id, 200), pdf_enviado_em = now() where id = p_id;
end;
$$;

-- Processos confirmados para ligar ao cálculo (quem tem Cálculos sem ter Processos também precisa escolher),
-- com tribunal (calendário do art. 523) e as partes por polo (cabeçalho do demonstrativo).
create or replace function public.calculo_opcoes(p_escritorio uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform public._exigir_calculos(p_escritorio);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id, 'numero_cnj', p.numero_cnj, 'titulo', p.titulo, 'tribunal', p.tribunal,
      'ativo', (select string_agg(pp.nome, ', ' order by pp.nome) from public.processo_parte pp where pp.processo_id = p.id and pp.polo = 'ativo'),
      'passivo', (select string_agg(pp.nome, ', ' order by pp.nome) from public.processo_parte pp where pp.processo_id = p.id and pp.polo = 'passivo'))
      order by p.numero_cnj)
    from (select * from public.processo where escritorio_id = p_escritorio and status = 'confirmado' order by numero_cnj limit 2000) p), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------
-- Permissões das funções.
-- ---------------------------------------------------------------------
revoke execute on function public.indices_gravar(text, jsonb, timestamptz), public.indices_registrar_erro(text, text)
  from public, anon, authenticated;
grant execute on function public.indices_gravar(text, jsonb, timestamptz), public.indices_registrar_erro(text, text) to service_role;

revoke execute on function public._exigir_calculos(uuid), public._regime_de_json(jsonb, uuid, uuid, int) from public, anon;
revoke execute on function
  public.indices_periodo(text[], date, date), public.regime_criar(uuid, jsonb), public.regime_nova_versao(uuid, jsonb),
  public.regime_arquivar(uuid), public.calculo_salvar(uuid, uuid, jsonb), public.calculo_excluir(uuid),
  public.calculo_registrar_pdf(uuid, text), public.calculo_opcoes(uuid)
  from public, anon;
grant execute on function
  public.indices_periodo(text[], date, date), public.regime_criar(uuid, jsonb), public.regime_nova_versao(uuid, jsonb),
  public.regime_arquivar(uuid), public.calculo_salvar(uuid, uuid, jsonb), public.calculo_excluir(uuid),
  public.calculo_registrar_pdf(uuid, text), public.calculo_opcoes(uuid)
  to authenticated;
