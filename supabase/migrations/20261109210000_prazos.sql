-- =====================================================================
-- Prompt 4 — Prazos: da publicação ao prazo com responsável e alertas automáticos.
--
--  - calendario_forense: feriados e suspensões. Linhas globais (escritorio_id nulo) vêm da migração e são só leitura;
--    cada escritório (dono) acrescenta as suas. A CONTA da data final é feita em código (src/lib/prazos/contagem.ts);
--    o banco guarda o resultado confirmado e o raciocínio que o usuário viu.
--  - prazo: só existe depois que o usuário confirma. Status gravado: aberto | cumprido | cancelado.
--    "Vencido" é derivado (aberto com data final antes de hoje), então nunca fica desatualizado.
--  - prazo_alerta: um registro por alerta enviado (impede repetir). notificacao: aviso dentro do app.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Páscoa (Meeus/Jones/Butcher) — base dos feriados móveis
-- ---------------------------------------------------------------------
create or replace function public.pascoa(p_ano int)
returns date
language plpgsql immutable
set search_path = ''
as $$
declare
  a int := p_ano % 19; b int := p_ano / 100; c int := p_ano % 100;
  d int := b / 4; e int := b % 4; f int := (b + 8) / 25; g int := (b - f + 1) / 3;
  h int := (19 * a + b - d - g + 15) % 30;
  i int := c / 4; k int := c % 4;
  l int := (32 + 2 * e + 2 * i - h - k) % 7;
  m int := (a + 11 * h + 22 * l) / 451;
  mes int := (h + l - 7 * m + 114) / 31;
  dia int := ((h + l - 7 * m + 114) % 31) + 1;
begin
  return make_date(p_ano, mes, dia);
end;
$$;

-- ---------------------------------------------------------------------
-- Calendário forense
-- ---------------------------------------------------------------------
create table public.calendario_forense (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid null references public.escritorio(id) on delete cascade, -- nulo = vale para todos (migração)
  data date not null,
  data_fim date null,
  escopo text not null check (escopo in ('nacional','estadual','municipal','tribunal')),
  tribunal text null check (tribunal is null or tribunal ~ '^[A-Z0-9]{2,10}$'),
  uf text null check (uf is null or uf ~ '^[A-Z]{2}$'),
  tipo text not null check (tipo in ('feriado','suspensao')),
  descricao text not null check (length(btrim(descricao)) between 3 and 120),
  criado_por uuid null,
  criado_em timestamptz not null default now(),
  check (data_fim is null or data_fim >= data),
  check (data_fim is null or data_fim - data <= 120),
  check (escopo <> 'estadual' or uf is not null),
  check (escopo not in ('tribunal','municipal') or tribunal is not null)
);
create index calendario_forense_idx on public.calendario_forense (escritorio_id, data);

-- Semente: feriados nacionais + Bahia (2 de Julho) + TJBA (Carnaval, Corpus Christi), 2025 a 2035.
-- PENDENCIA P-007: conferir com o calendário oficial do TJBA e acrescentar municipais/outros tribunais pela tela.
do $$
declare
  y int;
  p date;
  fixo record;
begin
  for y in 2025..2035 loop
    p := public.pascoa(y);
    for fixo in select * from (values
      ('01-01', 'Confraternização Universal'), ('04-21', 'Tiradentes'), ('05-01', 'Dia do Trabalho'),
      ('09-07', 'Independência do Brasil'), ('10-12', 'Nossa Senhora Aparecida'), ('11-02', 'Finados'),
      ('11-15', 'Proclamação da República'), ('12-25', 'Natal')
    ) as t(md, nome) loop
      insert into public.calendario_forense (data, escopo, tipo, descricao)
      values (to_date(y || '-' || fixo.md, 'YYYY-MM-DD'), 'nacional', 'feriado', fixo.nome);
    end loop;
    -- Consciência Negra é feriado nacional desde 2024 (Lei 14.759/2023).
    insert into public.calendario_forense (data, escopo, tipo, descricao)
      values (make_date(y, 11, 20), 'nacional', 'feriado', 'Dia Nacional de Zumbi e da Consciência Negra');
    insert into public.calendario_forense (data, escopo, tipo, descricao)
      values (p - 2, 'nacional', 'feriado', 'Sexta-feira Santa');
    insert into public.calendario_forense (data, escopo, uf, tipo, descricao)
      values (make_date(y, 7, 2), 'estadual', 'BA', 'feriado', 'Independência da Bahia');
    insert into public.calendario_forense (data, escopo, tribunal, tipo, descricao) values
      (p - 48, 'tribunal', 'TJBA', 'feriado', 'Carnaval (segunda-feira)'),
      (p - 47, 'tribunal', 'TJBA', 'feriado', 'Carnaval (terça-feira)'),
      (p + 60, 'tribunal', 'TJBA', 'feriado', 'Corpus Christi');
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Prazo
-- ---------------------------------------------------------------------
create table public.prazo (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  processo_id uuid not null references public.processo(id),
  publicacao_id uuid null references public.publicacao(id) on delete set null,
  descricao text not null check (length(btrim(descricao)) between 3 and 200),
  dias int not null check (dias between 1 and 365),
  tipo_contagem text not null check (tipo_contagem in ('util','corrido')),
  responsavel_id uuid not null references public.membro(id),
  data_disponibilizacao date not null,
  data_publicacao date not null,
  inicio_contagem date not null,
  data_final date not null,
  raciocinio jsonb not null,
  status text not null default 'aberto' check (status in ('aberto','cumprido','cancelado')),
  cumprido_em timestamptz null,
  criado_por uuid null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  check (data_disponibilizacao < data_publicacao and data_publicacao < inicio_contagem and inicio_contagem <= data_final),
  check ((status = 'cumprido') = (cumprido_em is not null))
);
create index prazo_lista_idx on public.prazo (escritorio_id, status, data_final);
create index prazo_responsavel_idx on public.prazo (responsavel_id, status, data_final);
create index prazo_processo_idx on public.prazo (processo_id);
create index prazo_publicacao_idx on public.prazo (publicacao_id);

-- Publicação que o usuário decidiu que não gera prazo (some da lista de sugestões; não apaga nada).
alter table public.publicacao add column sem_prazo_em timestamptz null;

create table public.prazo_alerta (
  id bigint generated always as identity primary key,
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  prazo_id uuid not null references public.prazo(id) on delete cascade,
  tipo text not null check (tipo in ('antes_3','dia','vencido')),
  data_ref date not null,
  email_status text not null default 'pendente' check (email_status in ('pendente','enviado','falhou','sem_email')),
  email_erro text null,
  criado_em timestamptz not null default now(),
  unique (prazo_id, tipo, data_ref)
);

create table public.notificacao (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  usuario_id uuid not null references auth.users(id) on delete cascade,
  tipo text not null check (tipo in ('prazo_antes_3','prazo_dia','prazo_vencido')),
  titulo text not null,
  corpo text not null,
  link text null check (link is null or link ~ '^/app/'),
  prazo_id uuid null references public.prazo(id) on delete cascade,
  lida_em timestamptz null,
  criado_em timestamptz not null default now()
);
create index notificacao_usuario_idx on public.notificacao (usuario_id, lida_em, criado_em desc);

-- Prazo só existe sobre processo CONFIRMADO do mesmo escritório, com responsável do mesmo escritório.
create or replace function public.validar_prazo()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.processo p where p.id = new.processo_id and p.escritorio_id = new.escritorio_id and p.status = 'confirmado') then
    raise exception 'processo_nao_confirmado' using errcode = '22023';
  end if;
  if not exists (select 1 from public.membro m where m.id = new.responsavel_id and m.escritorio_id = new.escritorio_id) then
    raise exception 'responsavel_invalido' using errcode = '22023';
  end if;
  if new.publicacao_id is not null and not exists (
    select 1 from public.publicacao b where b.id = new.publicacao_id and b.escritorio_id = new.escritorio_id and b.processo_id = new.processo_id
  ) then
    raise exception 'publicacao_invalida' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger prazo_valida before insert on public.prazo for each row execute function public.validar_prazo();

create trigger auditoria_prazo after insert or update or delete on public.prazo
  for each row execute function public.registrar_auditoria();
create trigger auditoria_calendario after insert or update or delete on public.calendario_forense
  for each row execute function public.registrar_auditoria();

-- ---------------------------------------------------------------------
-- Ações do usuário
-- ---------------------------------------------------------------------

create or replace function public._exigir_prazos(p_escritorio uuid)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '28000'; end if;
  if not public.pode_ver(p_escritorio, 'prazos') then raise exception 'sem_permissao' using errcode = '42501'; end if;
end;
$$;

-- Quem pode ser responsável: dono ou membro com a tela Prazos.
create or replace function public.responsaveis_prazo(p_escritorio uuid)
returns table (id uuid, nome text, email text)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform public._exigir_prazos(p_escritorio);
  return query
    select m.id, m.nome, m.email from public.membro m
    where m.escritorio_id = p_escritorio
      and (m.papel = 'dono' or exists (select 1 from public.permissao_tela t where t.membro_id = m.id and t.modulo = 'prazos'))
    order by m.nome, m.email;
end;
$$;

-- Grava o prazo JÁ CONFIRMADO pelo usuário. As datas vêm do módulo de contagem (código), nunca de IA.
create or replace function public.criar_prazo(
  p_processo uuid, p_publicacao uuid, p_descricao text, p_dias int, p_tipo text, p_responsavel uuid,
  p_disponibilizacao date, p_data_publicacao date, p_inicio date, p_data_final date, p_raciocinio jsonb
) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_esc uuid;
  v_id uuid;
begin
  select escritorio_id into v_esc from public.processo where id = p_processo;
  if v_esc is null then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_prazos(v_esc);
  if not (public.pode_ver(v_esc, 'processos') or public.pode_ver(v_esc, 'prazos')) then raise exception 'sem_permissao' using errcode = '42501'; end if;
  -- O responsável precisa conseguir ver prazos, senão o alerta chegaria a quem não pode abri-lo.
  if not exists (
    select 1 from public.membro m where m.id = p_responsavel and m.escritorio_id = v_esc
      and (m.papel = 'dono' or exists (select 1 from public.permissao_tela t where t.membro_id = m.id and t.modulo = 'prazos'))
  ) then raise exception 'responsavel_invalido' using errcode = '22023'; end if;
  if jsonb_typeof(p_raciocinio) is distinct from 'object' then raise exception 'raciocinio_invalido' using errcode = '22023'; end if;

  insert into public.prazo (
    escritorio_id, processo_id, publicacao_id, descricao, dias, tipo_contagem, responsavel_id,
    data_disponibilizacao, data_publicacao, inicio_contagem, data_final, raciocinio, criado_por
  ) values (
    v_esc, p_processo, p_publicacao, btrim(p_descricao), p_dias, p_tipo, p_responsavel,
    p_disponibilizacao, p_data_publicacao, p_inicio, p_data_final, p_raciocinio, auth.uid()
  ) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.alterar_status_prazo(p_prazo uuid, p_status text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.prazo;
begin
  select * into v from public.prazo where id = p_prazo for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_prazos(v.escritorio_id);
  if p_status not in ('aberto','cumprido','cancelado') then raise exception 'status_invalido' using errcode = '22023'; end if;
  update public.prazo set
    status = p_status,
    cumprido_em = case when p_status = 'cumprido' then now() end,
    atualizado_em = now()
  where id = p_prazo;
end;
$$;

create or replace function public.alterar_responsavel_prazo(p_prazo uuid, p_responsavel uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.prazo;
begin
  select * into v from public.prazo where id = p_prazo for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_prazos(v.escritorio_id);
  if not exists (
    select 1 from public.membro m where m.id = p_responsavel and m.escritorio_id = v.escritorio_id
      and (m.papel = 'dono' or exists (select 1 from public.permissao_tela t where t.membro_id = m.id and t.modulo = 'prazos'))
  ) then raise exception 'responsavel_invalido' using errcode = '22023'; end if;
  update public.prazo set responsavel_id = p_responsavel, atualizado_em = now() where id = p_prazo;
end;
$$;

create or replace function public.dispensar_prazo_publicacao(p_publicacao uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.publicacao;
begin
  select * into v from public.publicacao where id = p_publicacao for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_prazos(v.escritorio_id);
  update public.publicacao set sem_prazo_em = now() where id = p_publicacao;
end;
$$;

-- Calendário do escritório (só o dono). As linhas globais não se alteram por aqui.
create or replace function public.calendario_adicionar(
  p_escritorio uuid, p_data date, p_data_fim date, p_escopo text, p_tribunal text, p_uf text, p_tipo text, p_descricao text
) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '28000'; end if;
  if not public.eh_dono(p_escritorio) then raise exception 'sem_permissao' using errcode = '42501'; end if;
  if p_escopo = 'nacional' then raise exception 'escopo_invalido' using errcode = '22023'; end if; -- nacional é mantido pelo LAW
  insert into public.calendario_forense (escritorio_id, data, data_fim, escopo, tribunal, uf, tipo, descricao, criado_por)
  values (p_escritorio, p_data, p_data_fim, p_escopo, nullif(upper(btrim(p_tribunal)), ''), nullif(upper(btrim(p_uf)), ''), p_tipo, btrim(p_descricao), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.calendario_remover(p_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.calendario_forense;
begin
  select * into v from public.calendario_forense where id = p_id for update;
  if not found or v.escritorio_id is null then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '28000'; end if;
  if not public.eh_dono(v.escritorio_id) then raise exception 'sem_permissao' using errcode = '42501'; end if;
  delete from public.calendario_forense where id = p_id;
end;
$$;

create or replace function public.marcar_notificacoes_lidas(p_ids uuid[])
returns int
language sql security definer
set search_path = ''
as $$
  with u as (
    update public.notificacao set lida_em = now()
    where usuario_id = auth.uid() and lida_em is null and (p_ids is null or id = any(p_ids))
    returning 1
  ) select count(*)::int from u
$$;

-- ---------------------------------------------------------------------
-- Funções do job de alertas (service_role)
-- ---------------------------------------------------------------------

-- Prazos abertos que já vencem até `p_ate`, com o responsável e o que já foi avisado.
create or replace function public.alertas_candidatos(p_ate date)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'prazo_id', p.id, 'escritorio_id', p.escritorio_id, 'data_final', p.data_final, 'status', p.status,
    'descricao', p.descricao, 'numero_cnj', pr.numero_cnj,
    'usuario_id', m.usuario_id, 'responsavel_nome', m.nome, 'responsavel_email', m.email,
    'enviados', coalesce((select jsonb_agg(jsonb_build_object('tipo', a.tipo, 'data_ref', a.data_ref)) from public.prazo_alerta a where a.prazo_id = p.id), '[]'::jsonb)
  ) order by p.data_final), '[]'::jsonb)
  from public.prazo p
  join public.processo pr on pr.id = p.processo_id
  join public.membro m on m.id = p.responsavel_id
  join public.escritorio e on e.id = p.escritorio_id and e.ativo
  where p.status = 'aberto' and p.data_final <= p_ate
$$;

-- Reserva o alerta (impede repetir) e cria o aviso dentro do app. Devolve false se já tinha sido enviado.
create or replace function public.alerta_reservar(p_prazo uuid, p_tipo text, p_data_ref date, p_titulo text, p_corpo text, p_link text)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.prazo;
  v_usuario uuid;
  v_id bigint;
begin
  select * into v from public.prazo where id = p_prazo;
  if not found or v.status <> 'aberto' then return false; end if;
  insert into public.prazo_alerta (escritorio_id, prazo_id, tipo, data_ref)
  values (v.escritorio_id, p_prazo, p_tipo, p_data_ref)
  on conflict (prazo_id, tipo, data_ref) do nothing
  returning id into v_id;
  if v_id is null then return false; end if;
  select usuario_id into v_usuario from public.membro where id = v.responsavel_id;
  insert into public.notificacao (escritorio_id, usuario_id, tipo, titulo, corpo, link, prazo_id)
  values (v.escritorio_id, v_usuario, 'prazo_' || p_tipo, p_titulo, p_corpo, p_link, p_prazo);
  return true;
end;
$$;

create or replace function public.alerta_marcar_email(p_prazo uuid, p_tipo text, p_data_ref date, p_status text, p_erro text)
returns void
language sql security definer
set search_path = ''
as $$
  update public.prazo_alerta set email_status = p_status, email_erro = left(p_erro, 200)
  where prazo_id = p_prazo and tipo = p_tipo and data_ref = p_data_ref
$$;

-- ---------------------------------------------------------------------
-- RLS e privilégios
-- ---------------------------------------------------------------------
alter table public.calendario_forense enable row level security;
alter table public.prazo enable row level security;
alter table public.prazo_alerta enable row level security;
alter table public.notificacao enable row level security;

create policy calendario_select on public.calendario_forense for select to authenticated
  using (escritorio_id is null or public.eh_membro(escritorio_id));
create policy prazo_select on public.prazo for select to authenticated
  using (public.pode_ver(escritorio_id, 'prazos'));
create policy prazo_alerta_select on public.prazo_alerta for select to authenticated
  using (public.pode_ver(escritorio_id, 'prazos'));
create policy notificacao_select on public.notificacao for select to authenticated
  using (usuario_id = auth.uid());

revoke all on public.calendario_forense, public.prazo, public.prazo_alerta, public.notificacao from anon;
revoke insert, update, delete, truncate on public.calendario_forense, public.prazo, public.prazo_alerta, public.notificacao from authenticated;

revoke execute on function public.pascoa(int) from public, anon;
revoke execute on function public.validar_prazo() from public, anon, authenticated;
revoke execute on function public._exigir_prazos(uuid) from public, anon, authenticated;

revoke execute on function public.responsaveis_prazo(uuid) from public, anon;
revoke execute on function public.criar_prazo(uuid, uuid, text, int, text, uuid, date, date, date, date, jsonb) from public, anon;
revoke execute on function public.alterar_status_prazo(uuid, text) from public, anon;
revoke execute on function public.alterar_responsavel_prazo(uuid, uuid) from public, anon;
revoke execute on function public.dispensar_prazo_publicacao(uuid) from public, anon;
revoke execute on function public.calendario_adicionar(uuid, date, date, text, text, text, text, text) from public, anon;
revoke execute on function public.calendario_remover(uuid) from public, anon;
revoke execute on function public.marcar_notificacoes_lidas(uuid[]) from public, anon;
grant execute on function public.responsaveis_prazo(uuid) to authenticated;
grant execute on function public.criar_prazo(uuid, uuid, text, int, text, uuid, date, date, date, date, jsonb) to authenticated;
grant execute on function public.alterar_status_prazo(uuid, text) to authenticated;
grant execute on function public.alterar_responsavel_prazo(uuid, uuid) to authenticated;
grant execute on function public.dispensar_prazo_publicacao(uuid) to authenticated;
grant execute on function public.calendario_adicionar(uuid, date, date, text, text, text, text, text) to authenticated;
grant execute on function public.calendario_remover(uuid) to authenticated;
grant execute on function public.marcar_notificacoes_lidas(uuid[]) to authenticated;

revoke execute on function public.alertas_candidatos(date) from public, anon, authenticated;
revoke execute on function public.alerta_reservar(uuid, text, date, text, text, text) from public, anon, authenticated;
revoke execute on function public.alerta_marcar_email(uuid, text, date, text, text) from public, anon, authenticated;
grant execute on function public.alertas_candidatos(date) to service_role;
grant execute on function public.alerta_reservar(uuid, text, date, text, text, text) to service_role;
grant execute on function public.alerta_marcar_email(uuid, text, date, text, text) to service_role;
