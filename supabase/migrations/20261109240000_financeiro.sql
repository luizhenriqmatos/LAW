-- =====================================================================
-- Prompt 7: financeiro do escritório (lançamentos, parcelas, pagamentos).
--
--  - lancamento: o fato financeiro (receita ou despesa), ligado a cliente e processo CONFIRMADOS (gatilho do Prompt 3).
--  - parcela: dividir o lançamento em N; a diferença de centavos vai para a PRIMEIRA parcela.
--  - pagamento: cada pagamento (parcial ou total) fica registrado; a parcela soma os não estornados. Assim "recebido no mês"
--    é exato mesmo quando uma parcela é paga em dois meses, e erro de digitação se corrige estornando.
--  - Tudo em centavos (bigint). Datas de competência/vencimento/pagamento são `date` no calendário de Brasília.
--  - Quem não tem a tela Financeiro não lê nada: RLS nas três tabelas e cada função confere `pode_ver(escritorio, 'financeiro')`.
--  - Escrita só pelas funções abaixo (parcela e pagamento não aceitam escrita direta). Auditoria nas três tabelas.
--  - Saldo em aberto = soma de (valor - valor pago) das parcelas aberta/atrasada/parcial de lançamentos não cancelados.
--    "Atrasado" é derivado da data (vencimento < hoje e saldo > 0), então nunca fica desatualizado; o job diário só grava o
--    status 'atrasada' nas parcelas abertas para quem consulta a tabela direto.
-- =====================================================================

create or replace function public.hoje_brasilia()
returns date
language sql stable
as $$ select (now() at time zone 'America/Sao_Paulo')::date $$;

alter table public.lancamento
  add column tipo text not null default 'receita' check (tipo in ('receita','despesa')),
  add column categoria text not null default 'outros'
    check (categoria in ('honorarios_contratuais','exito','custas','reembolso','despesa_fixa','outros')),
  add column data_competencia date not null default public.hoje_brasilia(),
  add column cancelado_em timestamptz null,
  add column criado_por uuid null,
  add column atualizado_em timestamptz not null default now(),
  add constraint lancamento_valor_positivo check (valor_centavos > 0);
create index lancamento_cliente_idx on public.lancamento (cliente_id) where cliente_id is not null;
create index lancamento_processo_idx on public.lancamento (processo_id) where processo_id is not null;
create index lancamento_competencia_idx on public.lancamento (escritorio_id, data_competencia desc);

create table public.parcela (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  lancamento_id uuid not null references public.lancamento(id),
  numero int not null check (numero >= 1),
  valor_centavos bigint not null check (valor_centavos > 0),
  vencimento date not null,
  data_pagamento date null,
  valor_pago_centavos bigint not null default 0,
  forma_pagamento text null check (forma_pagamento in ('pix','transferencia','boleto','cartao','dinheiro','cheque','outro')),
  status text not null default 'aberta' check (status in ('aberta','paga','parcial','atrasada','cancelada')),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (lancamento_id, numero),
  check (valor_pago_centavos between 0 and valor_centavos),
  check (status <> 'paga' or (valor_pago_centavos = valor_centavos and data_pagamento is not null)),
  check (status <> 'parcial' or (valor_pago_centavos > 0 and valor_pago_centavos < valor_centavos)),
  check (status not in ('aberta','atrasada') or valor_pago_centavos = 0)
);
create index parcela_escritorio_venc_idx on public.parcela (escritorio_id, vencimento) where status in ('aberta','atrasada','parcial');
create index parcela_lancamento_idx on public.parcela (lancamento_id);

create table public.pagamento (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  parcela_id uuid not null references public.parcela(id),
  valor_centavos bigint not null check (valor_centavos > 0),
  data_pagamento date not null,
  forma_pagamento text null check (forma_pagamento in ('pix','transferencia','boleto','cartao','dinheiro','cheque','outro')),
  criado_por uuid null,
  criado_em timestamptz not null default now(),
  estornado_em timestamptz null,
  estornado_por uuid null
);
create index pagamento_parcela_idx on public.pagamento (parcela_id);
create index pagamento_data_idx on public.pagamento (escritorio_id, data_pagamento) where estornado_em is null;

alter table public.parcela enable row level security;
alter table public.pagamento enable row level security;
create policy parcela_select on public.parcela for select to authenticated using (public.pode_ver(escritorio_id, 'financeiro'));
create policy pagamento_select on public.pagamento for select to authenticated using (public.pode_ver(escritorio_id, 'financeiro'));
revoke all on public.parcela, public.pagamento from anon;
revoke insert, update, delete, truncate on public.parcela, public.pagamento from authenticated;

create trigger auditoria_parcela after insert or update or delete on public.parcela
  for each row execute function public.registrar_auditoria();
create trigger auditoria_pagamento after insert or update or delete on public.pagamento
  for each row execute function public.registrar_auditoria();

-- Valor e tipo do lançamento não mudam depois de parcelado (mexer no valor desalinharia as parcelas).
create or replace function public.lancamento_protege_valor()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if (new.valor_centavos is distinct from old.valor_centavos or new.tipo is distinct from old.tipo)
     and exists (select 1 from public.parcela p where p.lancamento_id = old.id) then
    raise exception 'lancamento_com_parcelas' using errcode = '22023';
  end if;
  new.atualizado_em := now();
  return new;
end;
$$;
create trigger lancamento_protege before update on public.lancamento
  for each row execute function public.lancamento_protege_valor();

create or replace function public._exigir_financeiro(p_escritorio uuid)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '28000'; end if;
  if not public.pode_ver(p_escritorio, 'financeiro') then raise exception 'sem_permissao' using errcode = '42501'; end if;
end;
$$;

-- Recalcula status, valor pago, data e forma de UMA parcela a partir dos pagamentos não estornados.
create or replace function public._recalcular_parcela(p_parcela uuid, p_hoje date default public.hoje_brasilia())
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  p public.parcela;
  v_pago bigint;
  v_data date;
  v_forma text;
begin
  select * into p from public.parcela where id = p_parcela for update;
  if not found or p.status = 'cancelada' then return; end if;
  select coalesce(sum(g.valor_centavos), 0) into v_pago from public.pagamento g where g.parcela_id = p_parcela and g.estornado_em is null;
  select g.data_pagamento, g.forma_pagamento into v_data, v_forma
    from public.pagamento g where g.parcela_id = p_parcela and g.estornado_em is null
    order by g.data_pagamento desc, g.criado_em desc, g.id desc limit 1;
  update public.parcela set
    valor_pago_centavos = v_pago,
    data_pagamento = case when v_pago > 0 then v_data end,
    forma_pagamento = case when v_pago > 0 then v_forma end,
    status = case
      when v_pago >= p.valor_centavos then 'paga'
      when v_pago > 0 then 'parcial'
      when p.vencimento < p_hoje then 'atrasada'
      else 'aberta' end,
    atualizado_em = now()
  where id = p_parcela;
end;
$$;

-- ---------------------------------------------------------------------
-- Criar lançamento já parcelado
-- ---------------------------------------------------------------------
create or replace function public.lancamento_criar(p_escritorio uuid, p_dados jsonb)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  d jsonb := coalesce(p_dados, '{}'::jsonb);
  v_tipo text := d->>'tipo';
  v_cat text := d->>'categoria';
  v_desc text := btrim(coalesce(d->>'descricao', ''));
  v_total bigint := (d->>'valor_centavos')::bigint;
  v_n int := coalesce((d->>'parcelas')::int, 1);
  v_prim date := nullif(d->>'primeiro_vencimento', '')::date;
  v_comp date := coalesce(nullif(d->>'data_competencia', '')::date, public.hoje_brasilia());
  v_cli uuid := nullif(d->>'cliente_id', '')::uuid;
  v_proc uuid := nullif(d->>'processo_id', '')::uuid;
  v_base bigint;
  v_resto bigint;
  v_id uuid;
begin
  perform public._exigir_financeiro(p_escritorio);
  if v_tipo is null or v_tipo not in ('receita','despesa') then raise exception 'tipo_invalido' using errcode = '22023'; end if;
  if v_cat is null or v_cat not in ('honorarios_contratuais','exito','custas','reembolso','despesa_fixa','outros') then
    raise exception 'categoria_invalida' using errcode = '22023';
  end if;
  if length(v_desc) < 2 or length(v_desc) > 200 then raise exception 'descricao_invalida' using errcode = '22023'; end if;
  if v_total is null or v_total <= 0 then raise exception 'valor_invalido' using errcode = '22023'; end if;
  if v_n < 1 or v_n > 120 then raise exception 'parcelas_invalidas' using errcode = '22023'; end if;
  if v_total < v_n then raise exception 'parcelas_demais' using errcode = '22023'; end if;
  if v_prim is null then raise exception 'vencimento_invalido' using errcode = '22023'; end if;
  if v_tipo = 'receita' and v_cli is null then raise exception 'cliente_obrigatorio' using errcode = '22023'; end if;

  -- cliente/processo precisam ser do escritório e CONFIRMADOS (gatilho exigir_vinculo_confirmado).
  insert into public.lancamento (escritorio_id, tipo, categoria, descricao, valor_centavos, data_competencia, cliente_id, processo_id, criado_por)
  values (p_escritorio, v_tipo, v_cat, v_desc, v_total, v_comp, v_cli, v_proc, auth.uid())
  returning id into v_id;

  -- Divisão exata em centavos: todas iguais ao piso, e a sobra inteira vai para a 1ª parcela.
  v_base := v_total / v_n;
  v_resto := v_total - v_base * v_n;
  insert into public.parcela (escritorio_id, lancamento_id, numero, valor_centavos, vencimento, status)
  select p_escritorio, v_id, i, v_base + case when i = 1 then v_resto else 0 end,
         (v_prim + make_interval(months => i - 1))::date,
         case when (v_prim + make_interval(months => i - 1))::date < public.hoje_brasilia() then 'atrasada' else 'aberta' end
  from generate_series(1, v_n) as i;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Pagamentos
-- ---------------------------------------------------------------------
create or replace function public.pagamento_registrar(p_parcela uuid, p_valor bigint, p_data date default null, p_forma text default null)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  p public.parcela;
  v_data date := coalesce(p_data, public.hoje_brasilia());
  v_id uuid;
begin
  select * into p from public.parcela where id = p_parcela for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_financeiro(p.escritorio_id);
  if p.status = 'cancelada' then raise exception 'parcela_cancelada' using errcode = '22023'; end if;
  if p_valor is null or p_valor <= 0 then raise exception 'valor_invalido' using errcode = '22023'; end if;
  if v_data > public.hoje_brasilia() then raise exception 'data_futura' using errcode = '22023'; end if;
  if p_forma is not null and p_forma not in ('pix','transferencia','boleto','cartao','dinheiro','cheque','outro') then
    raise exception 'forma_invalida' using errcode = '22023';
  end if;
  if p.valor_pago_centavos + p_valor > p.valor_centavos then raise exception 'pagamento_excede' using errcode = '22023'; end if;
  insert into public.pagamento (escritorio_id, parcela_id, valor_centavos, data_pagamento, forma_pagamento, criado_por)
  values (p.escritorio_id, p_parcela, p_valor, v_data, p_forma, auth.uid()) returning id into v_id;
  perform public._recalcular_parcela(p_parcela);
  return v_id;
end;
$$;

create or replace function public.pagamento_estornar(p_pagamento uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare g public.pagamento;
begin
  select * into g from public.pagamento where id = p_pagamento for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_financeiro(g.escritorio_id);
  if g.estornado_em is not null then raise exception 'ja_estornado' using errcode = '22023'; end if;
  update public.pagamento set estornado_em = now(), estornado_por = auth.uid() where id = p_pagamento;
  perform public._recalcular_parcela(g.parcela_id);
end;
$$;

create or replace function public.parcela_alterar_vencimento(p_parcela uuid, p_vencimento date)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare p public.parcela;
begin
  select * into p from public.parcela where id = p_parcela for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_financeiro(p.escritorio_id);
  if p_vencimento is null then raise exception 'vencimento_invalido' using errcode = '22023'; end if;
  if p.status in ('paga','cancelada') then raise exception 'parcela_encerrada' using errcode = '22023'; end if;
  update public.parcela set vencimento = p_vencimento, atualizado_em = now() where id = p_parcela;
  perform public._recalcular_parcela(p_parcela);
end;
$$;

create or replace function public.parcela_cancelar(p_parcela uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare p public.parcela;
begin
  select * into p from public.parcela where id = p_parcela for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_financeiro(p.escritorio_id);
  if p.status = 'cancelada' then raise exception 'parcela_cancelada' using errcode = '22023'; end if;
  if p.valor_pago_centavos > 0 then raise exception 'parcela_com_pagamento' using errcode = '22023'; end if;
  update public.parcela set status = 'cancelada', atualizado_em = now() where id = p_parcela;
end;
$$;

create or replace function public.lancamento_cancelar(p_lancamento uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare l public.lancamento;
begin
  select * into l from public.lancamento where id = p_lancamento for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_financeiro(l.escritorio_id);
  if l.cancelado_em is not null then raise exception 'ja_cancelado' using errcode = '22023'; end if;
  if exists (select 1 from public.pagamento g join public.parcela p on p.id = g.parcela_id
             where p.lancamento_id = p_lancamento and g.estornado_em is null) then
    raise exception 'lancamento_com_pagamento' using errcode = '22023';
  end if;
  update public.parcela set status = 'cancelada', atualizado_em = now() where lancamento_id = p_lancamento and status <> 'cancelada';
  update public.lancamento set cancelado_em = now() where id = p_lancamento;
end;
$$;

-- ---------------------------------------------------------------------
-- Consultas (devolvem JSON; cada uma confere a permissão antes de ler)
-- ---------------------------------------------------------------------
create or replace function public.financeiro_resumo(p_escritorio uuid, p_hoje date default public.hoje_brasilia())
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_ini date := date_trunc('month', p_hoje)::date;
  v_fim date := (date_trunc('month', p_hoje) + interval '1 month')::date;
  r jsonb;
begin
  perform public._exigir_financeiro(p_escritorio);
  select jsonb_build_object(
    'a_receber', coalesce(sum(pa.valor_centavos - pa.valor_pago_centavos) filter (where l.tipo = 'receita' and pa.vencimento >= p_hoje), 0)::bigint,
    'atrasado', coalesce(sum(pa.valor_centavos - pa.valor_pago_centavos) filter (where l.tipo = 'receita' and pa.vencimento < p_hoje), 0)::bigint,
    'a_pagar', coalesce(sum(pa.valor_centavos - pa.valor_pago_centavos) filter (where l.tipo = 'despesa'), 0)::bigint,
    'parcelas_atrasadas', count(*) filter (where l.tipo = 'receita' and pa.vencimento < p_hoje)::int
  ) into r
  from public.parcela pa join public.lancamento l on l.id = pa.lancamento_id
  where pa.escritorio_id = p_escritorio and l.cancelado_em is null and pa.status in ('aberta','atrasada','parcial');

  return r || jsonb_build_object(
    'recebido_mes', (select coalesce(sum(g.valor_centavos), 0)::bigint
                     from public.pagamento g join public.parcela pa on pa.id = g.parcela_id join public.lancamento l on l.id = pa.lancamento_id
                     where g.escritorio_id = p_escritorio and g.estornado_em is null and l.tipo = 'receita'
                       and g.data_pagamento >= v_ini and g.data_pagamento < v_fim),
    'despesas_mes', (select coalesce(sum(l.valor_centavos), 0)::bigint
                     from public.lancamento l
                     where l.escritorio_id = p_escritorio and l.tipo = 'despesa' and l.cancelado_em is null
                       and l.data_competencia >= v_ini and l.data_competencia < v_fim));
end;
$$;

-- Saldo a receber por cliente ou por processo (só receitas; despesas aparecem no extrato).
create or replace function public.financeiro_saldos(p_escritorio uuid, p_por text, p_hoje date default public.hoje_brasilia())
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare r jsonb;
begin
  perform public._exigir_financeiro(p_escritorio);
  if p_por not in ('cliente','processo') then raise exception 'dados_invalidos' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.em_aberto desc, t.nome), '[]'::jsonb) into r from (
    select
      case when p_por = 'cliente' then l.cliente_id else l.processo_id end as id,
      case when p_por = 'cliente' then (select c.nome from public.cliente c where c.id = l.cliente_id)
           else (select pr.numero_cnj from public.processo pr where pr.id = l.processo_id) end as nome,
      coalesce(sum(pa.valor_centavos - pa.valor_pago_centavos) filter (where pa.status in ('aberta','atrasada','parcial')), 0)::bigint as em_aberto,
      coalesce(sum(pa.valor_centavos - pa.valor_pago_centavos) filter (where pa.status in ('aberta','atrasada','parcial') and pa.vencimento < p_hoje), 0)::bigint as atrasado,
      coalesce(sum(pa.valor_pago_centavos), 0)::bigint as recebido
    from public.lancamento l join public.parcela pa on pa.lancamento_id = l.id
    where l.escritorio_id = p_escritorio and l.tipo = 'receita' and l.cancelado_em is null and pa.status <> 'cancelada'
      and (case when p_por = 'cliente' then l.cliente_id else l.processo_id end) is not null
    group by 1, 2
    having sum(pa.valor_centavos - pa.valor_pago_centavos) filter (where pa.status in ('aberta','atrasada','parcial')) > 0
    limit 200
  ) t;
  return r;
end;
$$;

create or replace function public.financeiro_lancamentos(p_escritorio uuid, p_filtros jsonb default '{}'::jsonb, p_hoje date default public.hoje_brasilia())
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  f jsonb := coalesce(p_filtros, '{}'::jsonb);
  v_lim int := least(greatest(coalesce((f->>'limite')::int, 100), 1), 200);
  v_off int := greatest(coalesce((f->>'deslocamento')::int, 0), 0);
  v_total int;
  v_itens jsonb;
begin
  perform public._exigir_financeiro(p_escritorio);
  with base as (
    select l.id, l.tipo, l.categoria, l.descricao, l.valor_centavos, l.data_competencia, l.cliente_id, l.processo_id, l.cancelado_em, l.criado_em,
           (select c.nome from public.cliente c where c.id = l.cliente_id) as cliente_nome,
           (select pr.numero_cnj from public.processo pr where pr.id = l.processo_id) as numero_cnj,
           a.parcelas, a.pago, a.aberto, a.atrasado, a.proximo_vencimento
    from public.lancamento l
    left join lateral (
      select count(*) filter (where x.status <> 'cancelada')::int as parcelas,
             coalesce(sum(x.valor_pago_centavos) filter (where x.status <> 'cancelada'), 0)::bigint as pago,
             coalesce(sum(x.valor_centavos - x.valor_pago_centavos) filter (where x.status in ('aberta','atrasada','parcial')), 0)::bigint as aberto,
             coalesce(sum(x.valor_centavos - x.valor_pago_centavos) filter (where x.status in ('aberta','atrasada','parcial') and x.vencimento < p_hoje), 0)::bigint as atrasado,
             min(x.vencimento) filter (where x.status in ('aberta','atrasada','parcial')) as proximo_vencimento
      from public.parcela x where x.lancamento_id = l.id) a on true
    where l.escritorio_id = p_escritorio
      and (f->>'tipo' is null or l.tipo = f->>'tipo')
      and (f->>'categoria' is null or l.categoria = f->>'categoria')
      and (f->>'cliente_id' is null or l.cliente_id = (f->>'cliente_id')::uuid)
      and (f->>'processo_id' is null or l.processo_id = (f->>'processo_id')::uuid)
      and (f->>'de' is null or l.data_competencia >= (f->>'de')::date)
      and (f->>'ate' is null or l.data_competencia <= (f->>'ate')::date)
      and (f->>'busca' is null or strpos(lower(l.descricao), lower(f->>'busca')) > 0)
  ), filtrada as (
    select * from base b where
      case f->>'situacao'
        when 'aberto' then b.cancelado_em is null and b.aberto > 0
        when 'atrasado' then b.cancelado_em is null and b.atrasado > 0
        when 'quitado' then b.cancelado_em is null and b.parcelas > 0 and b.aberto = 0
        when 'cancelado' then b.cancelado_em is not null
        else true end
  )
  select (select count(*) from filtrada)::int,
         (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
            select * from filtrada order by data_competencia desc, criado_em desc, id limit v_lim offset v_off) t)
  into v_total, v_itens;
  return jsonb_build_object('total', v_total, 'itens', v_itens);
end;
$$;

-- Parcelas com o contexto do lançamento: extrato por cliente/processo, "vencendo", CSV. Totais separados por tipo.
create or replace function public.financeiro_parcelas(p_escritorio uuid, p_filtros jsonb default '{}'::jsonb, p_hoje date default public.hoje_brasilia())
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  f jsonb := coalesce(p_filtros, '{}'::jsonb);
  v_lim int := least(greatest(coalesce((f->>'limite')::int, 500), 1), 5000);
  v_itens jsonb;
  v_tot jsonb;
  v_n int;
begin
  perform public._exigir_financeiro(p_escritorio);
  with base as (
    select pa.id, pa.lancamento_id, pa.numero, pa.valor_centavos, pa.vencimento, pa.data_pagamento, pa.valor_pago_centavos, pa.forma_pagamento, pa.status,
           l.tipo, l.categoria, l.descricao, l.data_competencia, l.cliente_id, l.processo_id, l.cancelado_em,
           (select c.nome from public.cliente c where c.id = l.cliente_id) as cliente_nome,
           (select pr.numero_cnj from public.processo pr where pr.id = l.processo_id) as numero_cnj,
           (select count(*) from public.parcela x where x.lancamento_id = l.id and x.status <> 'cancelada')::int as total_parcelas
    from public.parcela pa join public.lancamento l on l.id = pa.lancamento_id
    where pa.escritorio_id = p_escritorio
      and (f->>'lancamento_id' is null or pa.lancamento_id = (f->>'lancamento_id')::uuid)
      and (f->>'cliente_id' is null or l.cliente_id = (f->>'cliente_id')::uuid)
      and (f->>'processo_id' is null or l.processo_id = (f->>'processo_id')::uuid)
      and (f->>'tipo' is null or l.tipo = f->>'tipo')
      and (f->>'categoria' is null or l.categoria = f->>'categoria')
      and (f->>'de' is null or pa.vencimento >= (f->>'de')::date)
      and (f->>'ate' is null or pa.vencimento <= (f->>'ate')::date)
      and (f->>'comp_de' is null or l.data_competencia >= (f->>'comp_de')::date)
      and (f->>'comp_ate' is null or l.data_competencia <= (f->>'comp_ate')::date)
      and (f->>'busca' is null or strpos(lower(l.descricao), lower(f->>'busca')) > 0)
      and case f->>'situacao'
            when 'em_aberto' then pa.status in ('aberta','atrasada','parcial')
            when 'atrasada' then pa.status in ('aberta','atrasada','parcial') and pa.vencimento < p_hoje
            when 'paga' then pa.status = 'paga'
            when 'cancelada' then pa.status = 'cancelada'
            else true end
  )
  select (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select * from base order by vencimento, lancamento_id, numero limit v_lim) t),
         (select jsonb_build_object('receita', jsonb_build_object(
        'total', coalesce(sum(valor_centavos) filter (where tipo = 'receita' and status <> 'cancelada'), 0)::bigint,
        'pago', coalesce(sum(valor_pago_centavos) filter (where tipo = 'receita' and status <> 'cancelada'), 0)::bigint,
        'em_aberto', coalesce(sum(valor_centavos - valor_pago_centavos) filter (where tipo = 'receita' and status in ('aberta','atrasada','parcial')), 0)::bigint,
        'atrasado', coalesce(sum(valor_centavos - valor_pago_centavos) filter (where tipo = 'receita' and status in ('aberta','atrasada','parcial') and vencimento < p_hoje), 0)::bigint), 'despesa', jsonb_build_object(
        'total', coalesce(sum(valor_centavos) filter (where tipo = 'despesa' and status <> 'cancelada'), 0)::bigint,
        'pago', coalesce(sum(valor_pago_centavos) filter (where tipo = 'despesa' and status <> 'cancelada'), 0)::bigint,
        'em_aberto', coalesce(sum(valor_centavos - valor_pago_centavos) filter (where tipo = 'despesa' and status in ('aberta','atrasada','parcial')), 0)::bigint,
        'atrasado', coalesce(sum(valor_centavos - valor_pago_centavos) filter (where tipo = 'despesa' and status in ('aberta','atrasada','parcial') and vencimento < p_hoje), 0)::bigint)) from base),
         (select count(*) from base)::int
  into v_itens, v_tot, v_n;
  return jsonb_build_object('itens', v_itens, 'totais', v_tot, 'total', v_n, 'truncado', v_n > v_lim);
end;
$$;

create or replace function public.lancamento_obter(p_lancamento uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare l public.lancamento;
begin
  select * into l from public.lancamento where id = p_lancamento;
  if not found then return null; end if;
  perform public._exigir_financeiro(l.escritorio_id);
  return jsonb_build_object(
    'lancamento', to_jsonb(l),
    'cliente_nome', (select c.nome from public.cliente c where c.id = l.cliente_id),
    'numero_cnj', (select pr.numero_cnj from public.processo pr where pr.id = l.processo_id),
    'parcelas', (select coalesce(jsonb_agg(
        to_jsonb(pa) || jsonb_build_object('pagamentos', (
          select coalesce(jsonb_agg(to_jsonb(g) order by g.data_pagamento, g.criado_em), '[]'::jsonb) from public.pagamento g where g.parcela_id = pa.id))
        order by pa.numero), '[]'::jsonb)
      from public.parcela pa where pa.lancamento_id = l.id));
end;
$$;

-- Opções dos formulários e filtros. Quem tem Financeiro mas não tem Processos também precisa escolher cliente/processo
-- confirmados (a RLS de cliente/processo exige a tela Processos), por isso a lista sai por aqui, só com nome e número.
create or replace function public.financeiro_opcoes(p_escritorio uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform public._exigir_financeiro(p_escritorio);
  return jsonb_build_object(
    'clientes', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome) order by c.nome), '[]'::jsonb)
                 from (select id, nome from public.cliente where escritorio_id = p_escritorio and status = 'confirmado' order by nome limit 2000) c),
    'processos', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'numero_cnj', p.numero_cnj, 'titulo', p.titulo) order by p.numero_cnj), '[]'::jsonb)
                  from (select id, numero_cnj, titulo from public.processo where escritorio_id = p_escritorio and status = 'confirmado' order by numero_cnj limit 2000) p));
end;
$$;

-- ---------------------------------------------------------------------
-- Job diário (service_role): parcela aberta e vencida vira "atrasada".
-- ---------------------------------------------------------------------
create or replace function public.parcelas_marcar_atrasadas(p_hoje date default public.hoje_brasilia())
returns int
language plpgsql security definer
set search_path = ''
as $$
declare v_n int;
begin
  update public.parcela pa set status = 'atrasada', atualizado_em = now()
  where pa.status = 'aberta' and pa.vencimento < p_hoje
    and exists (select 1 from public.lancamento l where l.id = pa.lancamento_id and l.cancelado_em is null);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------
revoke execute on function public._exigir_financeiro(uuid) from public, anon, authenticated;
revoke execute on function public._recalcular_parcela(uuid, date) from public, anon, authenticated;
revoke execute on function public.lancamento_protege_valor() from public, anon, authenticated;

revoke execute on function public.lancamento_criar(uuid, jsonb) from public, anon;
revoke execute on function public.pagamento_registrar(uuid, bigint, date, text) from public, anon;
revoke execute on function public.pagamento_estornar(uuid) from public, anon;
revoke execute on function public.parcela_alterar_vencimento(uuid, date) from public, anon;
revoke execute on function public.parcela_cancelar(uuid) from public, anon;
revoke execute on function public.lancamento_cancelar(uuid) from public, anon;
revoke execute on function public.financeiro_resumo(uuid, date) from public, anon;
revoke execute on function public.financeiro_saldos(uuid, text, date) from public, anon;
revoke execute on function public.financeiro_lancamentos(uuid, jsonb, date) from public, anon;
revoke execute on function public.financeiro_parcelas(uuid, jsonb, date) from public, anon;
revoke execute on function public.lancamento_obter(uuid) from public, anon;
revoke execute on function public.financeiro_opcoes(uuid) from public, anon;
grant execute on function public.lancamento_criar(uuid, jsonb), public.pagamento_registrar(uuid, bigint, date, text),
  public.pagamento_estornar(uuid), public.parcela_alterar_vencimento(uuid, date), public.parcela_cancelar(uuid),
  public.lancamento_cancelar(uuid), public.financeiro_resumo(uuid, date), public.financeiro_saldos(uuid, text, date),
  public.financeiro_lancamentos(uuid, jsonb, date), public.financeiro_parcelas(uuid, jsonb, date), public.lancamento_obter(uuid), public.financeiro_opcoes(uuid)
  to authenticated;

revoke execute on function public.parcelas_marcar_atrasadas(date) from public, anon, authenticated;
grant execute on function public.parcelas_marcar_atrasadas(date) to service_role;
