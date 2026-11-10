-- Prompt 8B — Créditos trabalhistas (ADC 58 / TST) e verbas rescisórias.
-- 1. Regimes podem valer a partir de um marco do processo ou até a véspera dele (ex.: ajuizamento), além das datas fixas.
-- 2. Três regimes trabalhistas padrão. 3. Novo tipo de cálculo "trabalhista".

alter table public.regime_atualizacao
  add column inicio_no_marco text null check (inicio_no_marco in ('ajuizamento','citacao','transito_em_julgado','expedicao_requisitorio')),
  add column fim_no_marco text null check (fim_no_marco in ('ajuizamento','citacao','transito_em_julgado','expedicao_requisitorio'));

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
  r.inicio_no_marco := nullif(p->>'inicio_no_marco', '');
  r.fim_no_marco := nullif(p->>'fim_no_marco', '');
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

-- Fases do STF (ADC 58) e do TST (SBDI-1, E-ED-RR-713-03.2010.5.04.0029). Iguais a src/lib/calculos/regimes-padrao.ts.
insert into public.regime_atualizacao
  (id, escritorio_id, grupo_id, versao, nome, escopo, vigencia_inicio, vigencia_fim, inicio_no_marco, fim_no_marco, fundamento,
   correcao_indice, correcao_pro_rata, indice_editavel, juros_tipo, juros_valor, juros_pro_rata)
values
  ('00000000-0000-4000-8000-000000000803', null, '00000000-0000-4000-8000-000000000803', 1,
   'Trabalhista — fase pré-judicial (IPCA-E + juros do art. 39 da Lei 8.177/1991)', 'trabalhista', null, null, null, 'ajuizamento',
   'STF, ADC 58 e 59 (Tema 1191): até lei superveniente, IPCA-E na fase pré-judicial e Selic a partir do ajuizamento. Do vencimento de cada verba até a véspera do ajuizamento: correção pelo IPCA-E e juros legais do art. 39, caput, da Lei 8.177/1991 (TR acumulada no período).',
   'IPCA_E', false, false, 'tr_art39_lei8177', null, true),
  ('00000000-0000-4000-8000-000000000804', null, '00000000-0000-4000-8000-000000000804', 1,
   'Trabalhista — do ajuizamento até 29/08/2024 (Selic)', 'trabalhista', null, '2024-08-29', 'ajuizamento', null,
   'STF, ADC 58 e 59 (Tema 1191): até lei superveniente, IPCA-E na fase pré-judicial e Selic a partir do ajuizamento. Do ajuizamento até 29/08/2024: só a Selic, que já engloba correção e juros; nenhum juro adicional.',
   'nenhuma', false, false, 'selic_englobando_correcao_e_juros', null, true),
  ('00000000-0000-4000-8000-000000000805', null, '00000000-0000-4000-8000-000000000805', 1,
   'Trabalhista — fase judicial desde 30/08/2024 (IPCA + Taxa Legal)', 'trabalhista', '2024-08-30', null, 'ajuizamento', null,
   'TST, SBDI-1, E-ED-RR-713-03.2010.5.04.0029 (17/10/2024), aplicando a Lei 14.905/2024: a partir de 30/08/2024, correção pelo IPCA (CC, art. 389, parágrafo único) e juros pela Taxa Legal = Selic menos IPCA, podendo ser zero (CC, art. 406).',
   'IPCA', false, false, 'taxa_legal', null, true);

alter table public.calculo drop constraint calculo_tipo_check;
alter table public.calculo add constraint calculo_tipo_check check (tipo in ('atualizacao','art523','honorarios','trabalhista'));

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
  if v_tipo is null or v_tipo not in ('atualizacao','art523','honorarios','trabalhista') then raise exception 'tipo_invalido' using errcode = '22023'; end if;
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
