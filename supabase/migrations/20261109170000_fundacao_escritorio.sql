-- Prompt 1 — Fundação: escritório, equipe e permissões
-- Multi-escritório com RLS em todas as tabelas. Escrita sensível só por funções (RPC) ou pelo dono.

-- =====================================================================
-- Tipos de referência
-- =====================================================================
-- Módulos (telas) controlados por permissão. Manter igual a src/lib/modulos.ts.
create or replace function public.modulos_validos()
returns text[]
language sql immutable
set search_path = ''
as $$
  select array['agenda','processos','prazos','tarefas','financeiro','documentos','portal_cliente','configuracoes']::text[]
$$;

create or replace function public.ufs_validas()
returns text[]
language sql immutable
set search_path = ''
as $$
  select array['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']::text[]
$$;

-- Validação de CNPJ (14 dígitos, sem máscara, com dígitos verificadores).
create or replace function public.cnpj_valido(cnpj text)
returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  pesos1 int[] := array[5,4,3,2,9,8,7,6,5,4,3,2];
  pesos2 int[] := array[6,5,4,3,2,9,8,7,6,5,4,3,2];
  soma int; resto int; d1 int; d2 int; i int;
begin
  if cnpj is null or cnpj !~ '^\d{14}$' or cnpj ~ '^(\d)\1{13}$' then
    return false;
  end if;
  soma := 0;
  for i in 1..12 loop soma := soma + substr(cnpj, i, 1)::int * pesos1[i]; end loop;
  resto := soma % 11; d1 := case when resto < 2 then 0 else 11 - resto end;
  soma := 0;
  for i in 1..13 loop soma := soma + substr(cnpj, i, 1)::int * pesos2[i]; end loop;
  resto := soma % 11; d2 := case when resto < 2 then 0 else 11 - resto end;
  return d1 = substr(cnpj, 13, 1)::int and d2 = substr(cnpj, 14, 1)::int;
end;
$$;

-- =====================================================================
-- Tabelas
-- =====================================================================
create table public.escritorio (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(btrim(nome)) between 2 and 120),
  cnpj text null check (cnpj is null or public.cnpj_valido(cnpj)),
  plano text not null default 'equipe' check (plano in ('solo','equipe','escritorio','juridico')),
  modo_monitoramento text null check (modo_monitoramento in ('oab','sociedade')),
  status_monitoramento text not null default 'nao_configurado'
    check (status_monitoramento in ('nao_configurado','aguardando_busca','buscando','concluido','erro')),
  criado_por uuid not null references auth.users(id),
  criado_em timestamptz not null default now()
);

create table public.membro (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  usuario_id uuid not null references auth.users(id) on delete cascade,
  papel text not null check (papel in ('dono','membro')),
  nome text not null default '',
  email text not null,
  criado_em timestamptz not null default now(),
  unique (escritorio_id, usuario_id)
);
create index membro_usuario_idx on public.membro (usuario_id);

create table public.permissao_tela (
  membro_id uuid not null references public.membro(id) on delete cascade,
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  modulo text not null check (modulo = any (public.modulos_validos())),
  criado_em timestamptz not null default now(),
  primary key (membro_id, modulo)
);
create index permissao_tela_escritorio_idx on public.permissao_tela (escritorio_id);

create table public.alvo_monitoramento (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  tipo text not null check (tipo in ('oab','sociedade')),
  oab_numero text null check (oab_numero is null or oab_numero ~ '^\d{1,7}$'),
  oab_uf text null check (oab_uf is null or oab_uf = any (public.ufs_validas())),
  cnpj text null check (cnpj is null or public.cnpj_valido(cnpj)),
  nome_sociedade text null check (nome_sociedade is null or char_length(btrim(nome_sociedade)) between 2 and 160),
  criado_em timestamptz not null default now(),
  check (
    (tipo = 'oab' and oab_numero is not null and oab_uf is not null and cnpj is null and nome_sociedade is null)
    or (tipo = 'sociedade' and oab_numero is null and oab_uf is null and (cnpj is not null or nome_sociedade is not null))
  )
);
create unique index alvo_oab_unico on public.alvo_monitoramento (escritorio_id, oab_numero, oab_uf) where tipo = 'oab';
create index alvo_escritorio_idx on public.alvo_monitoramento (escritorio_id);

create table public.convite (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  email text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  modulos text[] not null default '{}' check (modulos <@ public.modulos_validos()),
  token_hash text not null unique,
  expira_em timestamptz not null default (now() + interval '7 days'),
  aceito_em timestamptz null,
  aceito_por uuid null references auth.users(id),
  cancelado_em timestamptz null,
  criado_por uuid not null references auth.users(id),
  criado_em timestamptz not null default now()
);
create index convite_escritorio_idx on public.convite (escritorio_id);

-- Financeiro mínimo: existe agora só para provar o bloqueio por permissão. O Prompt 7 completa.
create table public.lancamento (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  descricao text not null,
  valor_centavos bigint not null,
  criado_em timestamptz not null default now()
);
create index lancamento_escritorio_idx on public.lancamento (escritorio_id);

create table public.audit_log (
  id bigint generated always as identity primary key,
  escritorio_id uuid null,
  usuario_id uuid null,
  tabela text not null,
  registro_id text null,
  acao text not null check (acao in ('insert','update','delete')),
  antes jsonb null,
  depois jsonb null,
  criado_em timestamptz not null default now()
);
create index audit_log_escritorio_idx on public.audit_log (escritorio_id, criado_em desc);

-- =====================================================================
-- Funções de permissão (security definer: leem membro sem cair em RLS recursiva)
-- =====================================================================
create or replace function public.eh_membro(p_escritorio uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.membro m
    where m.escritorio_id = p_escritorio and m.usuario_id = auth.uid()
  )
$$;

create or replace function public.eh_dono(p_escritorio uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.membro m
    where m.escritorio_id = p_escritorio and m.usuario_id = auth.uid() and m.papel = 'dono'
  )
$$;

-- Dono vê tudo; membro vê o módulo se tiver a linha em permissao_tela.
create or replace function public.pode_ver(p_escritorio uuid, p_modulo text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.membro m
    where m.escritorio_id = p_escritorio and m.usuario_id = auth.uid()
      and (
        m.papel = 'dono'
        or exists (select 1 from public.permissao_tela p where p.membro_id = m.id and p.modulo = p_modulo)
      )
  )
$$;

-- Módulos que o usuário logado vê num escritório (usado pelo menu e pela guarda de rota).
create or replace function public.meus_modulos(p_escritorio uuid)
returns text[]
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    (select case when m.papel = 'dono' then public.modulos_validos()
            else array(select p.modulo from public.permissao_tela p where p.membro_id = m.id order by p.modulo) end
     from public.membro m
     where m.escritorio_id = p_escritorio and m.usuario_id = auth.uid()),
    '{}'::text[])
$$;

-- =====================================================================
-- RPCs de escrita sensível
-- =====================================================================
-- Cria escritório + dono numa transação.
create or replace function public.criar_escritorio(p_nome text, p_cnpj text, p_plano text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_usuario uuid := auth.uid();
  v_email text;
  v_id uuid;
begin
  if v_usuario is null then
    raise exception 'nao_autenticado' using errcode = '28000';
  end if;
  select u.email into v_email from auth.users u where u.id = v_usuario;
  insert into public.escritorio (nome, cnpj, plano, criado_por)
  values (btrim(p_nome), nullif(p_cnpj, ''), coalesce(nullif(p_plano, ''), 'equipe'), v_usuario)
  returning id into v_id;
  insert into public.membro (escritorio_id, usuario_id, papel, email)
  values (v_id, v_usuario, 'dono', coalesce(v_email, ''));
  return v_id;
end;
$$;

-- Salva o modo de monitoramento e os alvos (substitui os anteriores). Só o dono.
create or replace function public.salvar_monitoramento(p_escritorio uuid, p_modo text, p_alvos jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  a jsonb;
begin
  if not public.eh_dono(p_escritorio) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  if p_modo not in ('oab','sociedade') then
    raise exception 'modo_invalido' using errcode = '22023';
  end if;
  if jsonb_typeof(p_alvos) <> 'array' or jsonb_array_length(p_alvos) = 0 then
    raise exception 'alvos_vazios' using errcode = '22023';
  end if;
  delete from public.alvo_monitoramento where escritorio_id = p_escritorio;
  for a in select * from jsonb_array_elements(p_alvos) loop
    if p_modo = 'oab' then
      insert into public.alvo_monitoramento (escritorio_id, tipo, oab_numero, oab_uf)
      values (p_escritorio, 'oab', a->>'numero', upper(a->>'uf'));
    else
      insert into public.alvo_monitoramento (escritorio_id, tipo, cnpj, nome_sociedade)
      values (p_escritorio, 'sociedade', nullif(a->>'cnpj', ''), nullif(btrim(coalesce(a->>'nome', '')), ''));
    end if;
  end loop;
  update public.escritorio
     set modo_monitoramento = p_modo, status_monitoramento = 'aguardando_busca'
   where id = p_escritorio;
end;
$$;

-- Cria convite e devolve o código em texto puro UMA vez. No banco fica só o hash.
create or replace function public.criar_convite(p_escritorio uuid, p_email text, p_modulos text[])
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  if not public.eh_dono(p_escritorio) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  if not (coalesce(p_modulos, '{}') <@ public.modulos_validos()) then
    raise exception 'modulo_invalido' using errcode = '22023';
  end if;
  if exists (select 1 from public.membro m where m.escritorio_id = p_escritorio and lower(m.email) = lower(btrim(p_email))) then
    raise exception 'ja_e_membro' using errcode = '23505';
  end if;
  -- Um convite aberto por e-mail: cancela o anterior.
  update public.convite set cancelado_em = now()
   where escritorio_id = p_escritorio and lower(email) = lower(btrim(p_email))
     and aceito_em is null and cancelado_em is null;
  insert into public.convite (escritorio_id, email, modulos, token_hash, criado_por)
  values (p_escritorio, lower(btrim(p_email)), coalesce(p_modulos, '{}'),
          encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), auth.uid());
  return v_token;
end;
$$;

-- Aceita convite: código válido, não vencido, não usado, e-mail igual ao do login.
create or replace function public.aceitar_convite(p_token text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_usuario uuid := auth.uid();
  v_email text;
  c public.convite%rowtype;
  v_membro uuid;
  v_modulo text;
begin
  if v_usuario is null then
    raise exception 'nao_autenticado' using errcode = '28000';
  end if;
  select u.email into v_email from auth.users u where u.id = v_usuario;
  select * into c from public.convite
   where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
   for update;
  if not found or c.cancelado_em is not null then
    raise exception 'convite_invalido' using errcode = '22023';
  end if;
  if c.aceito_em is not null then
    raise exception 'convite_usado' using errcode = '22023';
  end if;
  if c.expira_em < now() then
    raise exception 'convite_vencido' using errcode = '22023';
  end if;
  if lower(coalesce(v_email, '')) <> lower(c.email) then
    raise exception 'convite_outro_email' using errcode = '42501';
  end if;
  insert into public.membro (escritorio_id, usuario_id, papel, email)
  values (c.escritorio_id, v_usuario, 'membro', lower(v_email))
  on conflict (escritorio_id, usuario_id) do nothing
  returning id into v_membro;
  if v_membro is null then
    raise exception 'ja_e_membro' using errcode = '23505';
  end if;
  foreach v_modulo in array c.modulos loop
    insert into public.permissao_tela (membro_id, escritorio_id, modulo)
    values (v_membro, c.escritorio_id, v_modulo);
  end loop;
  update public.convite set aceito_em = now(), aceito_por = v_usuario where id = c.id;
  return c.escritorio_id;
end;
$$;

-- =====================================================================
-- Auditoria (gatilho genérico, só inclusão)
-- =====================================================================
create or replace function public.registrar_auditoria()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_antes jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_depois jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  v_reg jsonb := coalesce(v_depois, v_antes);
begin
  -- Nunca guardar o hash do convite no log.
  v_antes := v_antes - 'token_hash';
  v_depois := v_depois - 'token_hash';
  insert into public.audit_log (escritorio_id, usuario_id, tabela, registro_id, acao, antes, depois)
  values (
    case when tg_table_name = 'escritorio' then (v_reg->>'id')::uuid else (v_reg->>'escritorio_id')::uuid end,
    auth.uid(),
    tg_table_name,
    coalesce(v_reg->>'id', v_reg->>'membro_id' || ':' || coalesce(v_reg->>'modulo', '')),
    lower(tg_op),
    v_antes,
    v_depois
  );
  return coalesce(new, old);
end;
$$;

create trigger auditoria_escritorio after insert or update or delete on public.escritorio
  for each row execute function public.registrar_auditoria();
create trigger auditoria_membro after insert or update or delete on public.membro
  for each row execute function public.registrar_auditoria();
create trigger auditoria_permissao after insert or update or delete on public.permissao_tela
  for each row execute function public.registrar_auditoria();
create trigger auditoria_alvo after insert or update or delete on public.alvo_monitoramento
  for each row execute function public.registrar_auditoria();
create trigger auditoria_convite after insert or update or delete on public.convite
  for each row execute function public.registrar_auditoria();
create trigger auditoria_lancamento after insert or update or delete on public.lancamento
  for each row execute function public.registrar_auditoria();

-- Papel não muda depois de criado (impede membro virar dono por update).
create or replace function public.bloquear_troca_papel()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.papel <> old.papel or new.usuario_id <> old.usuario_id or new.escritorio_id <> old.escritorio_id then
    raise exception 'campo_imutavel' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger membro_campos_imutaveis before update on public.membro
  for each row execute function public.bloquear_troca_papel();

-- =====================================================================
-- RLS
-- =====================================================================
alter table public.escritorio enable row level security;
alter table public.membro enable row level security;
alter table public.permissao_tela enable row level security;
alter table public.alvo_monitoramento enable row level security;
alter table public.convite enable row level security;
alter table public.lancamento enable row level security;
alter table public.audit_log enable row level security;

-- escritorio: membros leem; dono altera; criação só via criar_escritorio().
create policy escritorio_select on public.escritorio for select to authenticated
  using (public.eh_membro(id));
create policy escritorio_update on public.escritorio for update to authenticated
  using (public.eh_dono(id)) with check (public.eh_dono(id));

-- membro: membros do escritório se enxergam; dono altera nome e remove quem não é dono.
create policy membro_select on public.membro for select to authenticated
  using (public.eh_membro(escritorio_id));
create policy membro_update on public.membro for update to authenticated
  using (public.eh_dono(escritorio_id)) with check (public.eh_dono(escritorio_id));
create policy membro_delete on public.membro for delete to authenticated
  using (public.eh_dono(escritorio_id) and papel <> 'dono');

-- permissao_tela: dono vê e edita todas; membro só lê as próprias.
create policy permissao_select on public.permissao_tela for select to authenticated
  using (
    public.eh_dono(escritorio_id)
    or exists (select 1 from public.membro m where m.id = membro_id and m.usuario_id = auth.uid())
  );
create policy permissao_insert on public.permissao_tela for insert to authenticated
  with check (
    public.eh_dono(escritorio_id)
    and exists (select 1 from public.membro m
                where m.id = membro_id and m.escritorio_id = permissao_tela.escritorio_id and m.papel = 'membro')
  );
create policy permissao_delete on public.permissao_tela for delete to authenticated
  using (public.eh_dono(escritorio_id));

-- alvo_monitoramento: membros leem; escrita só via salvar_monitoramento() (dono).
create policy alvo_select on public.alvo_monitoramento for select to authenticated
  using (public.eh_membro(escritorio_id));

-- convite: só o dono lê e cancela; criação via criar_convite().
create policy convite_select on public.convite for select to authenticated
  using (public.eh_dono(escritorio_id));
create policy convite_update on public.convite for update to authenticated
  using (public.eh_dono(escritorio_id)) with check (public.eh_dono(escritorio_id));

-- lancamento: só quem pode ver o módulo financeiro.
create policy lancamento_select on public.lancamento for select to authenticated
  using (public.pode_ver(escritorio_id, 'financeiro'));
create policy lancamento_insert on public.lancamento for insert to authenticated
  with check (public.pode_ver(escritorio_id, 'financeiro'));
create policy lancamento_update on public.lancamento for update to authenticated
  using (public.pode_ver(escritorio_id, 'financeiro')) with check (public.pode_ver(escritorio_id, 'financeiro'));
create policy lancamento_delete on public.lancamento for delete to authenticated
  using (public.pode_ver(escritorio_id, 'financeiro'));

-- audit_log: só o dono lê; ninguém grava direto.
create policy audit_select on public.audit_log for select to authenticated
  using (public.eh_dono(escritorio_id));

-- =====================================================================
-- Privilégios: nada para anon; audit_log sem escrita pelo cliente
-- =====================================================================
revoke all on public.escritorio, public.membro, public.permissao_tela, public.alvo_monitoramento,
  public.convite, public.lancamento, public.audit_log from anon;
revoke insert, update, delete, truncate on public.audit_log from authenticated;
revoke insert, delete, truncate on public.escritorio from authenticated;
revoke insert, truncate on public.membro from authenticated;
revoke insert, delete, truncate on public.alvo_monitoramento, public.convite from authenticated;
revoke update, truncate on public.permissao_tela from authenticated;
-- Update só nas colunas que a interface realmente edita.
revoke update on public.escritorio, public.membro, public.convite from authenticated;
grant update (nome, cnpj) on public.escritorio to authenticated;
grant update (nome) on public.membro to authenticated;
grant update (cancelado_em) on public.convite to authenticated;

revoke execute on function public.criar_escritorio(text, text, text) from public, anon;
revoke execute on function public.salvar_monitoramento(uuid, text, jsonb) from public, anon;
revoke execute on function public.criar_convite(uuid, text, text[]) from public, anon;
revoke execute on function public.aceitar_convite(text) from public, anon;
revoke execute on function public.meus_modulos(uuid) from public, anon;
grant execute on function public.criar_escritorio(text, text, text) to authenticated;
grant execute on function public.salvar_monitoramento(uuid, text, jsonb) to authenticated;
grant execute on function public.criar_convite(uuid, text, text[]) to authenticated;
grant execute on function public.aceitar_convite(text) to authenticated;
grant execute on function public.meus_modulos(uuid) to authenticated;
