-- =====================================================================
-- Prompt 6: documentos no Google Drive do escritório.
--
--  - drive_conexao: UMA por escritório (feita pelo dono). Tokens cifrados pelo app; nenhuma policy para
--    `authenticated`, então o token nunca chega ao navegador. Escopo drive.file: o LAW só enxerga o que ele mesmo criou.
--  - drive_pasta: ids das pastas no Drive (cliente e processo). Apagar/descartar algo no LAW só DESVINCULA a linha;
--    o LAW nunca apaga nada no Drive.
--  - drive_fila: caixa de saída. Gatilhos enfileiram; o servidor cria/renomeia/move pastas depois.
-- Pasta do cliente: LAW/Clientes/<Nome>. Pasta do processo: "<CNJ> - <classe>" dentro da pasta do cliente PRINCIPAL
-- (1º cliente confirmado do polo ativo; sem polo ativo confirmado, o 1º cliente confirmado de qualquer polo).
-- =====================================================================

create table public.drive_conexao (
  escritorio_id uuid primary key references public.escritorio(id) on delete cascade,
  usuario_id uuid not null references auth.users(id),
  refresh_token_cifrado text not null,
  access_token_cifrado text null,
  access_expira_em timestamptz null,
  raiz_id text not null,          -- pasta "LAW"
  clientes_id text not null,      -- pasta "LAW/Clientes"
  status text not null default 'ativa' check (status in ('ativa','revogada','erro')),
  erro text null,
  criado_em timestamptz not null default now()
);

create table public.drive_pasta (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  tipo text not null check (tipo in ('cliente','processo')),
  ref_id uuid not null,
  drive_id text not null,
  nome text not null,
  pai_drive_id text not null,
  status text not null default 'ativa' check (status in ('ativa','desvinculada')),
  criado_em timestamptz not null default now(),
  desvinculada_em timestamptz null,
  check ((status = 'desvinculada') = (desvinculada_em is not null))
);
create unique index drive_pasta_ativa_idx on public.drive_pasta (tipo, ref_id) where status = 'ativa';
create index drive_pasta_esc_idx on public.drive_pasta (escritorio_id, tipo, ref_id);

create table public.drive_fila (
  id bigint generated always as identity primary key,
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  tipo text not null check (tipo in ('cliente','processo')),
  ref_id uuid not null,
  versao int not null default 1,
  tentativas int not null default 0,
  erro text null,
  proxima_tentativa timestamptz not null default now(),
  reservado_ate timestamptz null,
  processado_em timestamptz null,
  criado_em timestamptz not null default now()
);
create unique index drive_fila_dedup_idx on public.drive_fila (tipo, ref_id) where processado_em is null;
create index drive_fila_pendente_idx on public.drive_fila (proxima_tentativa) where processado_em is null;

-- ---------------------------------------------------------------------
-- Gatilhos que enfileiram (só se o escritório tem Drive conectado)
-- ---------------------------------------------------------------------
create or replace function public._drive_enfileirar(p_escritorio uuid, p_tipo text, p_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.drive_conexao d where d.escritorio_id = p_escritorio and d.status = 'ativa') then
    insert into public.drive_fila (escritorio_id, tipo, ref_id) values (p_escritorio, p_tipo, p_id)
    on conflict (tipo, ref_id) where processado_em is null
    do update set versao = public.drive_fila.versao + 1, proxima_tentativa = least(public.drive_fila.proxima_tentativa, now());
  end if;
end;
$$;

create or replace function public.drive_gatilho_cliente()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare r record;
begin
  if (tg_op = 'INSERT' and new.status = 'confirmado')
     or (tg_op = 'UPDATE' and (new.status = 'confirmado' or old.status = 'confirmado')
         and (new.status is distinct from old.status or new.nome is distinct from old.nome)) then
    perform public._drive_enfileirar(new.escritorio_id, 'cliente', new.id);
    for r in select distinct processo_id from public.processo_parte where cliente_id = new.id loop
      perform public._drive_enfileirar(new.escritorio_id, 'processo', r.processo_id);
    end loop;
  end if;
  return new;
end;
$$;
create trigger cliente_drive after insert or update on public.cliente
  for each row execute function public.drive_gatilho_cliente();

create or replace function public.drive_gatilho_processo()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and new.status = 'confirmado')
     or (tg_op = 'UPDATE' and (new.status = 'confirmado' or old.status = 'confirmado')
         and (new.status is distinct from old.status or new.classe is distinct from old.classe or new.numero_cnj is distinct from old.numero_cnj)) then
    perform public._drive_enfileirar(new.escritorio_id, 'processo', new.id);
  end if;
  return new;
end;
$$;
create trigger processo_drive after insert or update on public.processo
  for each row execute function public.drive_gatilho_processo();

-- Parte ligada/desligada/trocada de cliente muda quem é o cliente principal do processo.
create or replace function public.drive_gatilho_parte()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare v_proc uuid := coalesce(new.processo_id, old.processo_id); v_esc uuid := coalesce(new.escritorio_id, old.escritorio_id);
begin
  if tg_op = 'UPDATE' and new.cliente_id is not distinct from old.cliente_id and new.polo is not distinct from old.polo then
    return new;
  end if;
  if exists (select 1 from public.processo p where p.id = v_proc and p.status = 'confirmado') then
    perform public._drive_enfileirar(v_esc, 'processo', v_proc);
  end if;
  return coalesce(new, old);
end;
$$;
create trigger parte_drive after insert or update or delete on public.processo_parte
  for each row execute function public.drive_gatilho_parte();

-- ---------------------------------------------------------------------
-- Funções do usuário logado
-- ---------------------------------------------------------------------

-- Renomear cliente já confirmado (a pasta no Drive acompanha pelo gatilho acima). Auditado pelo gatilho de auditoria do cliente.
create or replace function public.cliente_renomear(p_cliente uuid, p_nome text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare v public.cliente;
begin
  select * into v from public.cliente where id = p_cliente for update;
  if not found then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  perform public._exigir_processos(v.escritorio_id);
  if v.status <> 'confirmado' then raise exception 'cliente_nao_confirmado' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_nome, ''))) < 2 then raise exception 'nome_invalido' using errcode = '22023'; end if;
  update public.cliente set nome = left(btrim(regexp_replace(p_nome, '\s+', ' ', 'g')), 200), atualizado_em = now() where id = p_cliente;
end;
$$;
create or replace function public.drive_status(p_escritorio uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare d public.drive_conexao%rowtype;
begin
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '28000'; end if;
  if not public.eh_membro(p_escritorio) then raise exception 'sem_permissao' using errcode = '42501'; end if;
  select * into d from public.drive_conexao where escritorio_id = p_escritorio;
  if not found then return jsonb_build_object('conectado', false); end if;
  return jsonb_build_object(
    'conectado', true, 'status', d.status, 'erro', d.erro, 'raiz_id', d.raiz_id,
    'pastas', (select count(*)::int from public.drive_pasta p where p.escritorio_id = p_escritorio and p.status = 'ativa'),
    'pendentes', (select count(*)::int from public.drive_fila f where f.escritorio_id = p_escritorio and f.processado_em is null),
    'falhas', (select count(*)::int from public.drive_fila f where f.escritorio_id = p_escritorio and f.erro is not null));
end;
$$;

-- Pasta do cliente/processo para quem tem Processos ou Documentos. NULL = ainda sem pasta.
create or replace function public.drive_pasta_de(p_tipo text, p_ref uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare v_esc uuid; v_pasta public.drive_pasta%rowtype; v_status text;
begin
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '28000'; end if;
  if p_tipo = 'cliente' then select escritorio_id, status into v_esc, v_status from public.cliente where id = p_ref;
  elsif p_tipo = 'processo' then select escritorio_id, status into v_esc, v_status from public.processo where id = p_ref;
  else raise exception 'dados_invalidos' using errcode = '22023'; end if;
  if v_esc is null then raise exception 'nao_encontrado' using errcode = 'P0002'; end if;
  if not (public.pode_ver(v_esc, 'processos') or public.pode_ver(v_esc, 'documentos')) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  select * into v_pasta from public.drive_pasta where tipo = p_tipo and ref_id = p_ref and status = 'ativa';
  if not found or v_status <> 'confirmado' then return null; end if;
  return jsonb_build_object('escritorio_id', v_esc, 'drive_id', v_pasta.drive_id, 'nome', v_pasta.nome);
end;
$$;

-- ---------------------------------------------------------------------
-- Funções de serviço (só service_role)
-- ---------------------------------------------------------------------
create or replace function public.drive_conexao_salvar(
  p_escritorio uuid, p_usuario uuid, p_refresh_cifrado text, p_access_cifrado text, p_expira timestamptz,
  p_raiz text, p_clientes text
) returns void
language plpgsql security definer
set search_path = ''
as $$
declare r record;
begin
  if not exists (select 1 from public.membro m where m.escritorio_id = p_escritorio and m.usuario_id = p_usuario and m.papel = 'dono') then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  -- Pasta "LAW" nova (conta diferente ou pasta recriada): o que estava ligado à raiz antiga só é desvinculado, nada é apagado.
  if exists (select 1 from public.drive_conexao d where d.escritorio_id = p_escritorio and d.raiz_id <> p_raiz) then
    update public.drive_pasta set status = 'desvinculada', desvinculada_em = now() where escritorio_id = p_escritorio and status = 'ativa';
  end if;
  insert into public.drive_conexao (escritorio_id, usuario_id, refresh_token_cifrado, access_token_cifrado, access_expira_em, raiz_id, clientes_id)
  values (p_escritorio, p_usuario, p_refresh_cifrado, p_access_cifrado, p_expira, p_raiz, p_clientes)
  on conflict (escritorio_id) do update set
    usuario_id = excluded.usuario_id, refresh_token_cifrado = excluded.refresh_token_cifrado,
    access_token_cifrado = excluded.access_token_cifrado, access_expira_em = excluded.access_expira_em,
    raiz_id = excluded.raiz_id, clientes_id = excluded.clientes_id, status = 'ativa', erro = null;
  for r in select id from public.cliente where escritorio_id = p_escritorio and status = 'confirmado' loop
    perform public._drive_enfileirar(p_escritorio, 'cliente', r.id);
  end loop;
  for r in select id from public.processo where escritorio_id = p_escritorio and status = 'confirmado' loop
    perform public._drive_enfileirar(p_escritorio, 'processo', r.id);
  end loop;
end;
$$;

create or replace function public.drive_conexao_obter(p_escritorio uuid)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select to_jsonb(d) from public.drive_conexao d where d.escritorio_id = p_escritorio
$$;

-- Desconectar: tira a conexão e DESVINCULA as pastas. Nada é apagado no Drive.
create or replace function public.drive_conexao_remover(p_escritorio uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.drive_pasta set status = 'desvinculada', desvinculada_em = now() where escritorio_id = p_escritorio and status = 'ativa';
  delete from public.drive_fila where escritorio_id = p_escritorio and processado_em is null;
  delete from public.drive_conexao where escritorio_id = p_escritorio;
end;
$$;

create or replace function public.drive_conexao_tokens(p_escritorio uuid, p_access_cifrado text, p_expira timestamptz)
returns void
language sql security definer
set search_path = ''
as $$
  update public.drive_conexao set access_token_cifrado = p_access_cifrado, access_expira_em = p_expira where escritorio_id = p_escritorio
$$;

create or replace function public.drive_conexao_ok(p_escritorio uuid)
returns void
language sql security definer
set search_path = ''
as $$
  update public.drive_conexao set erro = null where escritorio_id = p_escritorio and status = 'ativa' and erro is not null
$$;

create or replace function public.drive_conexao_falhou(p_escritorio uuid, p_status text, p_erro text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare d public.drive_conexao%rowtype;
begin
  if p_status not in ('revogada','erro') then raise exception 'status_invalido' using errcode = '22023'; end if;
  select * into d from public.drive_conexao where escritorio_id = p_escritorio for update;
  if not found or d.status <> 'ativa' then return; end if;
  update public.drive_conexao set status = p_status, erro = left(p_erro, 300) where escritorio_id = p_escritorio;
  -- Avisa o dono (quem conectou) e todos os outros donos do escritório.
  insert into public.notificacao (escritorio_id, usuario_id, tipo, titulo, corpo, link)
  select p_escritorio, m.usuario_id, 'google', 'Google Drive desconectado',
         case when p_status = 'revogada'
           then 'O acesso ao Google Drive do escritório foi revogado ou expirou. A criação de pastas e os envios pararam; o resto do LAW segue normal. O dono precisa reconectar em Documentos.'
           else 'A integração com o Google Drive parou por um erro. O dono precisa reconectar em Documentos.' end,
         '/app/documentos'
  from public.membro m where m.escritorio_id = p_escritorio and m.papel = 'dono';
end;
$$;

create or replace function public.drive_pegar_fila(p_limite int)
returns table (id bigint, escritorio_id uuid, tipo text, ref_id uuid, versao int)
language plpgsql security definer
set search_path = ''
as $$
begin
  return query
    with c as (
      select f.id from public.drive_fila f
      where f.processado_em is null and f.proxima_tentativa <= now() and (f.reservado_ate is null or f.reservado_ate < now())
      order by f.id limit greatest(1, least(p_limite, 200)) for update skip locked
    )
    update public.drive_fila f set reservado_ate = now() + interval '5 minutes'
    from c where f.id = c.id
    returning f.id, f.escritorio_id, f.tipo, f.ref_id, f.versao;
end;
$$;

create or replace function public.drive_concluir(p_fila bigint, p_versao int, p_erro text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare f public.drive_fila%rowtype;
begin
  select * into f from public.drive_fila where id = p_fila for update;
  if not found then return; end if;
  if p_erro is null then
    if f.versao <> p_versao then
      update public.drive_fila set reservado_ate = null, proxima_tentativa = now() where id = p_fila;
    else
      update public.drive_fila set processado_em = now(), erro = null, reservado_ate = null where id = p_fila;
    end if;
  elsif f.tentativas + 1 >= 8 then
    update public.drive_fila set processado_em = now(), tentativas = f.tentativas + 1, erro = left(p_erro, 300), reservado_ate = null where id = p_fila;
  else
    update public.drive_fila set tentativas = f.tentativas + 1, erro = left(p_erro, 300), reservado_ate = null,
      proxima_tentativa = now() + make_interval(mins => least(power(2, f.tentativas + 1)::int, 240))
    where id = p_fila;
  end if;
end;
$$;

-- Estado do item para o sincronizador. `existe` = deve ter pasta. Processo: precisa de cliente principal confirmado.
create or replace function public.drive_item(p_tipo text, p_ref uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare c public.cliente%rowtype; p public.processo%rowtype; v_cli uuid;
begin
  if p_tipo = 'cliente' then
    select * into c from public.cliente where id = p_ref;
    if not found then return null; end if;
    return jsonb_build_object('escritorio_id', c.escritorio_id, 'existe', c.status = 'confirmado', 'nome', c.nome);
  elsif p_tipo = 'processo' then
    select * into p from public.processo where id = p_ref;
    if not found then return null; end if;
    select c2.id into v_cli
      from public.processo_parte pp join public.cliente c2 on c2.id = pp.cliente_id
      where pp.processo_id = p_ref and c2.status = 'confirmado'
      order by (pp.polo = 'ativo') desc, pp.criado_em, pp.id limit 1;
    return jsonb_build_object('escritorio_id', p.escritorio_id, 'existe', p.status = 'confirmado' and v_cli is not null,
      'numero_cnj', p.numero_cnj, 'classe', p.classe, 'cliente_principal', v_cli);
  end if;
  raise exception 'origem_invalida' using errcode = '22023';
end;
$$;

create or replace function public.drive_pasta_obter(p_tipo text, p_ref uuid)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ativa', (select to_jsonb(a) from public.drive_pasta a where a.tipo = p_tipo and a.ref_id = p_ref and a.status = 'ativa'),
    'antiga', (select to_jsonb(d) from public.drive_pasta d where d.tipo = p_tipo and d.ref_id = p_ref and d.status = 'desvinculada' order by d.desvinculada_em desc limit 1))
$$;

create or replace function public.drive_pasta_salvar(p_escritorio uuid, p_tipo text, p_ref uuid, p_drive_id text, p_nome text, p_pai text)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.drive_pasta set status = 'desvinculada', desvinculada_em = now()
    where tipo = p_tipo and ref_id = p_ref and status = 'ativa' and drive_id <> p_drive_id;
  update public.drive_pasta set status = 'ativa', desvinculada_em = null, nome = p_nome, pai_drive_id = p_pai
    where tipo = p_tipo and ref_id = p_ref and drive_id = p_drive_id and escritorio_id = p_escritorio;
  if not found then
    insert into public.drive_pasta (escritorio_id, tipo, ref_id, drive_id, nome, pai_drive_id) values (p_escritorio, p_tipo, p_ref, p_drive_id, p_nome, p_pai);
  end if;
end;
$$;

create or replace function public.drive_pasta_desvincular(p_tipo text, p_ref uuid)
returns void
language sql security definer
set search_path = ''
as $$
  update public.drive_pasta set status = 'desvinculada', desvinculada_em = now() where tipo = p_tipo and ref_id = p_ref and status = 'ativa'
$$;

-- ---------------------------------------------------------------------
-- RLS e privilégios
-- ---------------------------------------------------------------------
alter table public.drive_conexao enable row level security;
alter table public.drive_pasta enable row level security;
alter table public.drive_fila enable row level security;
-- Sem policy para authenticated: tudo passa pelas funções acima.
revoke all on public.drive_conexao, public.drive_pasta, public.drive_fila from anon, authenticated;

revoke execute on function public._drive_enfileirar(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.drive_gatilho_cliente() from public, anon, authenticated;
revoke execute on function public.drive_gatilho_processo() from public, anon, authenticated;
revoke execute on function public.drive_gatilho_parte() from public, anon, authenticated;
revoke execute on function public.drive_status(uuid) from public, anon;
revoke execute on function public.drive_pasta_de(text, uuid) from public, anon;
revoke execute on function public.cliente_renomear(uuid, text) from public, anon;
grant execute on function public.drive_status(uuid), public.drive_pasta_de(text, uuid), public.cliente_renomear(uuid, text) to authenticated;

revoke execute on function public.drive_conexao_salvar(uuid, uuid, text, text, timestamptz, text, text) from public, anon, authenticated;
revoke execute on function public.drive_conexao_obter(uuid) from public, anon, authenticated;
revoke execute on function public.drive_conexao_remover(uuid) from public, anon, authenticated;
revoke execute on function public.drive_conexao_tokens(uuid, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.drive_conexao_ok(uuid) from public, anon, authenticated;
revoke execute on function public.drive_conexao_falhou(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.drive_pegar_fila(int) from public, anon, authenticated;
revoke execute on function public.drive_concluir(bigint, int, text) from public, anon, authenticated;
revoke execute on function public.drive_item(text, uuid) from public, anon, authenticated;
revoke execute on function public.drive_pasta_obter(text, uuid) from public, anon, authenticated;
revoke execute on function public.drive_pasta_salvar(uuid, text, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.drive_pasta_desvincular(text, uuid) from public, anon, authenticated;
grant execute on function public.drive_conexao_salvar(uuid, uuid, text, text, timestamptz, text, text),
  public.drive_conexao_obter(uuid), public.drive_conexao_remover(uuid), public.drive_conexao_tokens(uuid, text, timestamptz),
  public.drive_conexao_ok(uuid), public.drive_conexao_falhou(uuid, text, text), public.drive_pegar_fila(int),
  public.drive_concluir(bigint, int, text), public.drive_item(text, uuid), public.drive_pasta_obter(text, uuid),
  public.drive_pasta_salvar(uuid, text, uuid, text, text, text), public.drive_pasta_desvincular(text, uuid) to service_role;
