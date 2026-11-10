-- =====================================================================
-- Prompt 9: portal do cliente (acompanhar os próprios processos, sem senha).
--
--  - O advogado libera processo a processo, por cliente, e escolhe o que aparece (movimentações, resumo, compromissos,
--    documentos). Sem linha em portal_liberacao = nada visível.
--  - SEGREDO DE JUSTIÇA NUNCA entra no portal, e a trava é do banco, em quatro camadas:
--      1) gatilho em portal_liberacao / portal_documento / compromisso.visivel_portal recusa processo em segredo;
--      2) gatilho no processo (e nos metadados do DataJud) retira tudo que já estava liberado quando o sigilo aparece;
--      3) toda leitura do portal passa por _portal_liberacoes_do_email(), que de novo exclui processo em segredo;
--      4) o resumo por IA nem chega a ser pedido: portal_movimentos_para_resumo() recusa processo em segredo.
--    `portal_processo_sigiloso()` falha FECHADO: processo desconhecido conta como sigiloso.
--  - Acesso por link mágico: token aleatório de 32 bytes, guardado só como SHA-256; uso único (linha travada com
--    `for update`), vale 30 minutos; a sessão do portal vale 7 dias. Quem lê/escreve essas tabelas é só o servidor
--    (service_role): nenhuma policy para `authenticated`, então hash de token nunca chega a um navegador.
--  - O visitante do portal NÃO é usuário do Supabase Auth. Toda função do portal recebe o hash da sessão e a valida
--    por dentro; nenhuma aceita cliente_id vindo do app. A sessão é ligada ao e-mail, e o e-mail é conferido de novo
--    a cada leitura (se o escritório trocar o e-mail do cliente, o acesso acaba).
--  - Resumo por IA: rascunho ou publicação direta, conforme `escritorio.portal_resumo_modo`. Publicação direta nunca
--    vale quando a verificação automática achou alerta (opinião, previsão, fato fora das movimentações).
--  - Cada acesso do cliente (entrada, lista, processo, documento) grava data e IP em portal_acesso.
-- =====================================================================

alter table public.escritorio
  add column portal_resumo_modo text not null default 'revisar' check (portal_resumo_modo in ('revisar','direto'));

-- ---------------------------------------------------------------------
-- Segredo de justiça: fonte única da verdade (falha fechado)
-- ---------------------------------------------------------------------
create or replace function public.portal_processo_sigiloso(p_processo uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    (select p.segredo_justica
            or coalesce((
                 select (md.dados->>'nivelSigilo') ~ '^[1-9]'
                 from public.processo_metadados md
                 where md.escritorio_id = p.escritorio_id and md.numero_cnj = p.numero_cnj
               ), false)
     from public.processo p
     where p.id = p_processo),
    true)
$$;

-- ---------------------------------------------------------------------
-- Tabelas do lado do escritório
-- ---------------------------------------------------------------------
create table public.portal_liberacao (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  processo_id uuid not null references public.processo(id) on delete cascade,
  cliente_id uuid not null references public.cliente(id),
  -- O que o cliente vê. Tudo começa desligado: o advogado marca o que quer mostrar.
  ver_movimentacoes boolean not null default false,
  ver_resumo boolean not null default false,
  ver_compromissos boolean not null default false,
  ver_documentos boolean not null default false,
  titulo_cliente text null check (titulo_cliente is null or length(btrim(titulo_cliente)) between 1 and 120),
  situacao_texto text null check (situacao_texto is null or length(btrim(situacao_texto)) between 1 and 280),
  ativo boolean not null default true,
  liberado_por uuid null,
  liberado_em timestamptz not null default now(),
  revogado_em timestamptz null,
  motivo_revogacao text null check (motivo_revogacao is null or length(motivo_revogacao) <= 80),
  unique (processo_id, cliente_id),
  check (ativo = (revogado_em is null))
);
create index portal_liberacao_escritorio_idx on public.portal_liberacao (escritorio_id, ativo);
create index portal_liberacao_cliente_idx on public.portal_liberacao (cliente_id) where ativo;

create table public.portal_resumo (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  processo_id uuid not null references public.processo(id) on delete cascade,
  texto text not null check (length(btrim(texto)) between 31 and 3000),
  origem text not null check (origem in ('ia','advogado')),
  status text not null default 'rascunho' check (status in ('rascunho','publicado','retirado','descartado','substituido')),
  modelo text null,
  -- Impressão digital das movimentações usadas: o job só gera de novo quando ela muda.
  base_hash text null check (base_hash is null or base_hash ~ '^[0-9a-f]{64}$'),
  alertas jsonb not null default '[]'::jsonb check (jsonb_typeof(alertas) = 'array'),
  criado_por uuid null,
  criado_em timestamptz not null default now(),
  publicado_em timestamptz null,
  publicado_por uuid null,
  revisado_por uuid null,
  -- Todo resumo termina com o encaminhamento ao advogado. O banco não deixa gravar sem ele.
  check (btrim(texto) like '%Dúvidas? Fale com seu advogado.'),
  check (status <> 'publicado' or publicado_em is not null)
);
create unique index portal_resumo_rascunho_idx on public.portal_resumo (processo_id) where status = 'rascunho';
create unique index portal_resumo_publicado_idx on public.portal_resumo (processo_id) where status = 'publicado';
create index portal_resumo_escritorio_idx on public.portal_resumo (escritorio_id, status, criado_em desc);

create table public.portal_documento (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  processo_id uuid not null references public.processo(id) on delete cascade,
  arquivo_drive_id text not null check (length(arquivo_drive_id) between 5 and 200),
  nome text not null check (length(btrim(nome)) between 1 and 200),
  mime text null check (mime is null or length(mime) <= 120),
  tamanho bigint null check (tamanho is null or tamanho >= 0),
  compartilhado_por uuid null,
  compartilhado_em timestamptz not null default now(),
  revogado_em timestamptz null,
  revogado_por uuid null
);
create unique index portal_documento_ativo_idx on public.portal_documento (processo_id, arquivo_drive_id) where revogado_em is null;
create index portal_documento_escritorio_idx on public.portal_documento (escritorio_id, processo_id);

alter table public.compromisso
  add column visivel_portal boolean not null default false,
  add constraint compromisso_portal_precisa_processo check (not visivel_portal or processo_id is not null);

-- ---------------------------------------------------------------------
-- Tabelas do lado do visitante (só o servidor toca)
-- ---------------------------------------------------------------------
create table public.portal_link (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  origem text not null check (origem in ('cliente','advogado')),
  solicitado_por uuid null,
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null default (now() + interval '30 minutes'),
  usado_em timestamptz null,
  ip inet null
);
create index portal_link_email_idx on public.portal_link (email, criado_em desc);

create table public.portal_sessao (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  link_id uuid not null references public.portal_link(id),
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null default (now() + interval '7 days'),
  encerrada_em timestamptz null,
  ip inet null,
  user_agent text null check (user_agent is null or length(user_agent) <= 300)
);
create index portal_sessao_email_idx on public.portal_sessao (email);

create table public.portal_acesso (
  id bigint generated always as identity primary key,
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  cliente_id uuid not null references public.cliente(id),
  processo_id uuid null references public.processo(id) on delete set null,
  tipo text not null check (tipo in ('link_gerado','entrou','lista','processo','documento')),
  ip inet null,
  criado_em timestamptz not null default now()
);
create index portal_acesso_escritorio_idx on public.portal_acesso (escritorio_id, criado_em desc);
create index portal_acesso_cliente_idx on public.portal_acesso (cliente_id, criado_em desc);

-- ---------------------------------------------------------------------
-- RLS: o escritório lê o que é dele (se tem a tela Portal do cliente); escrita só pelas funções abaixo.
-- Link e sessão: RLS ligada e NENHUMA policy; sem grant para os papéis do app.
-- ---------------------------------------------------------------------
alter table public.portal_liberacao enable row level security;
alter table public.portal_resumo enable row level security;
alter table public.portal_documento enable row level security;
alter table public.portal_acesso enable row level security;
alter table public.portal_link enable row level security;
alter table public.portal_sessao enable row level security;

create policy portal_liberacao_select on public.portal_liberacao for select to authenticated using (public.pode_ver(escritorio_id, 'portal_cliente'));
create policy portal_resumo_select on public.portal_resumo for select to authenticated using (public.pode_ver(escritorio_id, 'portal_cliente'));
create policy portal_documento_select on public.portal_documento for select to authenticated using (public.pode_ver(escritorio_id, 'portal_cliente'));
create policy portal_acesso_select on public.portal_acesso for select to authenticated using (public.pode_ver(escritorio_id, 'portal_cliente'));

revoke all on public.portal_liberacao, public.portal_resumo, public.portal_documento, public.portal_acesso from anon;
revoke insert, update, delete, truncate on public.portal_liberacao, public.portal_resumo, public.portal_documento, public.portal_acesso from authenticated;
revoke all on public.portal_link, public.portal_sessao from anon, authenticated;

create trigger auditoria_portal_liberacao after insert or update or delete on public.portal_liberacao
  for each row execute function public.registrar_auditoria();
create trigger auditoria_portal_resumo after insert or update or delete on public.portal_resumo
  for each row execute function public.registrar_auditoria();
create trigger auditoria_portal_documento after insert or update or delete on public.portal_documento
  for each row execute function public.registrar_auditoria();

-- ---------------------------------------------------------------------
-- Gatilhos de segurança (valem para QUALQUER papel, inclusive service_role)
-- ---------------------------------------------------------------------
create or replace function public.portal_valida_liberacao()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.ativo then
    -- Segredo de justiça primeiro: é a regra que não pode ter outra mensagem na frente.
    if public.portal_processo_sigiloso(new.processo_id) then
      raise exception 'segredo_de_justica' using errcode = '22023';
    end if;
    if not exists (select 1 from public.processo p where p.id = new.processo_id and p.escritorio_id = new.escritorio_id and p.status = 'confirmado') then
      raise exception 'processo_nao_confirmado' using errcode = '22023';
    end if;
    if not exists (select 1 from public.cliente c where c.id = new.cliente_id and c.escritorio_id = new.escritorio_id and c.status = 'confirmado') then
      raise exception 'cliente_nao_confirmado' using errcode = '22023';
    end if;
    if not exists (select 1 from public.cliente c where c.id = new.cliente_id and c.email is not null) then
      raise exception 'cliente_sem_email' using errcode = '22023';
    end if;
    if not exists (select 1 from public.processo_parte pp where pp.processo_id = new.processo_id and pp.cliente_id = new.cliente_id) then
      raise exception 'cliente_fora_do_processo' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
create trigger portal_liberacao_valida before insert or update on public.portal_liberacao
  for each row execute function public.portal_valida_liberacao();

create or replace function public.portal_valida_documento()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.revogado_em is null then
    if public.portal_processo_sigiloso(new.processo_id) then
      raise exception 'segredo_de_justica' using errcode = '22023';
    end if;
    if not exists (select 1 from public.processo p where p.id = new.processo_id and p.escritorio_id = new.escritorio_id and p.status = 'confirmado') then
      raise exception 'processo_nao_confirmado' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
create trigger portal_documento_valida before insert or update on public.portal_documento
  for each row execute function public.portal_valida_documento();

create or replace function public.portal_valida_compromisso()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.visivel_portal and new.processo_id is not null and public.portal_processo_sigiloso(new.processo_id) then
    raise exception 'segredo_de_justica' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger compromisso_portal_valida before insert or update on public.compromisso
  for each row execute function public.portal_valida_compromisso();

-- Tira o processo do portal de uma vez: liberações, documentos, resumos e compromissos visíveis.
create or replace function public._portal_retirar_processo(p_processo uuid, p_motivo text)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.portal_liberacao set ativo = false, revogado_em = now(), motivo_revogacao = left(p_motivo, 80)
   where processo_id = p_processo and ativo;
  update public.portal_documento set revogado_em = now() where processo_id = p_processo and revogado_em is null;
  update public.portal_resumo set status = 'retirado' where processo_id = p_processo and status = 'publicado';
  update public.portal_resumo set status = 'descartado' where processo_id = p_processo and status = 'rascunho';
  update public.compromisso set visivel_portal = false where processo_id = p_processo and visivel_portal;
end;
$$;

create or replace function public.portal_gatilho_processo()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform public._portal_retirar_processo(new.id, 'segredo_de_justica');
  return new;
end;
$$;
create trigger processo_portal_segredo after update of segredo_justica on public.processo
  for each row when (new.segredo_justica and not old.segredo_justica) execute function public.portal_gatilho_processo();

create or replace function public.portal_gatilho_metadados()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare r record;
begin
  for r in select p.id from public.processo p where p.escritorio_id = new.escritorio_id and p.numero_cnj = new.numero_cnj loop
    perform public._portal_retirar_processo(r.id, 'segredo_de_justica');
  end loop;
  return new;
end;
$$;
create trigger metadados_portal_segredo after insert or update on public.processo_metadados
  for each row when ((new.dados->>'nivelSigilo') ~ '^[1-9]') execute function public.portal_gatilho_metadados();

-- ---------------------------------------------------------------------
-- Funções do advogado (usuário logado; precisa da tela Portal do cliente)
-- ---------------------------------------------------------------------
create or replace function public._exigir_portal(p_escritorio uuid)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '28000'; end if;
  if not public.pode_ver(p_escritorio, 'portal_cliente') then raise exception 'sem_permissao' using errcode = '42501'; end if;
end;
$$;

create or replace function public.portal_liberar(
  p_processo uuid, p_cliente uuid,
  p_movimentacoes boolean, p_resumo boolean, p_compromissos boolean, p_documentos boolean,
  p_situacao text default null, p_titulo text default null
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_esc uuid;
  v_id uuid;
begin
  select p.escritorio_id into v_esc from public.processo p where p.id = p_processo;
  if v_esc is null then raise exception 'processo_invalido' using errcode = '22023'; end if;
  perform public._exigir_portal(v_esc);

  insert into public.portal_liberacao (
    escritorio_id, processo_id, cliente_id, ver_movimentacoes, ver_resumo, ver_compromissos, ver_documentos,
    situacao_texto, titulo_cliente, liberado_por
  ) values (
    v_esc, p_processo, p_cliente, coalesce(p_movimentacoes, false), coalesce(p_resumo, false), coalesce(p_compromissos, false),
    coalesce(p_documentos, false), nullif(btrim(coalesce(p_situacao, '')), ''), nullif(btrim(coalesce(p_titulo, '')), ''), auth.uid()
  )
  on conflict (processo_id, cliente_id) do update set
    ver_movimentacoes = excluded.ver_movimentacoes,
    ver_resumo = excluded.ver_resumo,
    ver_compromissos = excluded.ver_compromissos,
    ver_documentos = excluded.ver_documentos,
    situacao_texto = excluded.situacao_texto,
    titulo_cliente = excluded.titulo_cliente,
    liberado_por = auth.uid(),
    liberado_em = case when public.portal_liberacao.ativo then public.portal_liberacao.liberado_em else now() end,
    ativo = true, revogado_em = null, motivo_revogacao = null
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.portal_revogar(p_liberacao uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare v_esc uuid;
begin
  select l.escritorio_id into v_esc from public.portal_liberacao l where l.id = p_liberacao;
  if v_esc is null then raise exception 'liberacao_invalida' using errcode = '22023'; end if;
  perform public._exigir_portal(v_esc);
  update public.portal_liberacao set ativo = false, revogado_em = now(), motivo_revogacao = 'advogado'
   where id = p_liberacao and ativo;
end;
$$;

create or replace function public.portal_compromisso_visivel(p_compromisso uuid, p_visivel boolean)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare v_esc uuid;
begin
  select c.escritorio_id into v_esc from public.compromisso c where c.id = p_compromisso;
  if v_esc is null then raise exception 'compromisso_invalido' using errcode = '22023'; end if;
  perform public._exigir_portal(v_esc);
  update public.compromisso set visivel_portal = coalesce(p_visivel, false) where id = p_compromisso;
end;
$$;

create or replace function public.portal_documento_compartilhar(p_processo uuid, p_arquivo text, p_nome text, p_mime text, p_tamanho bigint)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_esc uuid;
  v_id uuid;
begin
  select p.escritorio_id into v_esc from public.processo p where p.id = p_processo;
  if v_esc is null then raise exception 'processo_invalido' using errcode = '22023'; end if;
  perform public._exigir_portal(v_esc);
  insert into public.portal_documento (escritorio_id, processo_id, arquivo_drive_id, nome, mime, tamanho, compartilhado_por)
  values (v_esc, p_processo, p_arquivo, left(btrim(p_nome), 200), left(p_mime, 120), p_tamanho, auth.uid())
  on conflict (processo_id, arquivo_drive_id) where revogado_em is null do update set nome = excluded.nome
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.portal_documento_revogar(p_documento uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare v_esc uuid;
begin
  select d.escritorio_id into v_esc from public.portal_documento d where d.id = p_documento;
  if v_esc is null then raise exception 'documento_portal_invalido' using errcode = '22023'; end if;
  perform public._exigir_portal(v_esc);
  update public.portal_documento set revogado_em = now(), revogado_por = auth.uid() where id = p_documento and revogado_em is null;
end;
$$;

-- Só o dono escolhe se o resumo por IA vai direto ou espera revisão.
create or replace function public.portal_configurar(p_escritorio uuid, p_modo text)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '28000'; end if;
  if not public.eh_dono(p_escritorio) then raise exception 'sem_permissao' using errcode = '42501'; end if;
  if p_modo is null or p_modo not in ('revisar','direto') then raise exception 'modo_invalido' using errcode = '22023'; end if;
  update public.escritorio set portal_resumo_modo = p_modo where id = p_escritorio;
end;
$$;

-- Movimentações (só data, código e nome) que alimentam o resumo. Processo em segredo NÃO devolve nada: a IA nem é chamada.
create or replace function public.portal_movimentos_para_resumo(p_processo uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_proc public.processo;
begin
  select * into v_proc from public.processo p where p.id = p_processo;
  if not found then raise exception 'processo_invalido' using errcode = '22023'; end if;
  perform public._exigir_portal(v_proc.escritorio_id);
  if public.portal_processo_sigiloso(p_processo) then raise exception 'segredo_de_justica' using errcode = '22023'; end if;
  return jsonb_build_object(
    'escritorio_id', v_proc.escritorio_id,
    'classe', v_proc.classe,
    'movimentos', public._portal_movimentos(v_proc.escritorio_id, v_proc.numero_cnj, 15)
  );
end;
$$;

create or replace function public._portal_movimentos(p_escritorio uuid, p_cnj text, p_limite int)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('data_hora', s.dh, 'codigo', s.cod, 'nome', s.nome) order by s.dh desc), '[]'::jsonb)
  from (
    select m->>'dataHora' as dh, left(m->>'codigo', 20) as cod, left(m->>'nome', 200) as nome
    from public.processo_metadados md
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(md.dados->'movimentos') = 'array' then md.dados->'movimentos' else '[]'::jsonb end
    ) m
    where md.escritorio_id = p_escritorio and md.numero_cnj = p_cnj and (m->>'dataHora') is not null and (m->>'nome') is not null
    order by m->>'dataHora' desc
    limit greatest(p_limite, 0)
  ) s
$$;

create or replace function public._portal_gravar_resumo(
  p_esc uuid, p_processo uuid, p_texto text, p_origem text, p_modelo text, p_base_hash text, p_alertas jsonb, p_usuario uuid
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_modo text;
  v_status text;
  v_id uuid;
begin
  if not exists (select 1 from public.processo p where p.id = p_processo and p.escritorio_id = p_esc and p.status = 'confirmado') then
    raise exception 'processo_invalido' using errcode = '22023';
  end if;
  if public.portal_processo_sigiloso(p_processo) then raise exception 'segredo_de_justica' using errcode = '22023'; end if;
  if p_origem not in ('ia','advogado') then raise exception 'resumo_invalido' using errcode = '22023'; end if;
  if p_texto is null or btrim(p_texto) not like '%Dúvidas? Fale com seu advogado.' or length(btrim(p_texto)) not between 31 and 3000 then
    raise exception 'resumo_invalido' using errcode = '22023';
  end if;

  select e.portal_resumo_modo into v_modo from public.escritorio e where e.id = p_esc;
  -- Publica direto só quando: veio da IA, o escritório escolheu "direto" e a verificação automática não achou alerta.
  v_status := case when p_origem = 'ia' and v_modo = 'direto' and jsonb_array_length(coalesce(p_alertas, '[]'::jsonb)) = 0
                   then 'publicado' else 'rascunho' end;

  update public.portal_resumo set status = 'descartado' where processo_id = p_processo and status = 'rascunho';
  if v_status = 'publicado' then
    update public.portal_resumo set status = 'substituido' where processo_id = p_processo and status = 'publicado';
  end if;
  insert into public.portal_resumo (escritorio_id, processo_id, texto, origem, status, modelo, base_hash, alertas, criado_por, publicado_em)
  values (p_esc, p_processo, btrim(p_texto), p_origem, v_status, left(p_modelo, 80), p_base_hash, coalesce(p_alertas, '[]'::jsonb), p_usuario,
          case when v_status = 'publicado' then now() end)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'status', v_status);
end;
$$;

-- Advogado gerou (ou escreveu/editou) um resumo.
create or replace function public.portal_resumo_salvar(p_processo uuid, p_texto text, p_origem text, p_modelo text, p_base_hash text, p_alertas jsonb)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare v_esc uuid;
begin
  select p.escritorio_id into v_esc from public.processo p where p.id = p_processo;
  if v_esc is null then raise exception 'processo_invalido' using errcode = '22023'; end if;
  perform public._exigir_portal(v_esc);
  return public._portal_gravar_resumo(v_esc, p_processo, p_texto, p_origem, p_modelo, p_base_hash, p_alertas, auth.uid());
end;
$$;

-- Job (service_role): o escritório é informado pelo job.
create or replace function public.portal_resumo_salvar_servico(p_escritorio uuid, p_processo uuid, p_texto text, p_modelo text, p_base_hash text, p_alertas jsonb)
returns jsonb
language sql security definer
set search_path = ''
as $$
  select public._portal_gravar_resumo(p_escritorio, p_processo, p_texto, 'ia', p_modelo, p_base_hash, p_alertas, null)
$$;

create or replace function public.portal_resumo_editar(p_resumo uuid, p_texto text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare r public.portal_resumo;
begin
  select * into r from public.portal_resumo where id = p_resumo;
  if not found or r.status <> 'rascunho' then raise exception 'resumo_invalido' using errcode = '22023'; end if;
  perform public._exigir_portal(r.escritorio_id);
  if p_texto is null or btrim(p_texto) not like '%Dúvidas? Fale com seu advogado.' or length(btrim(p_texto)) not between 31 and 3000 then
    raise exception 'resumo_invalido' using errcode = '22023';
  end if;
  update public.portal_resumo set texto = btrim(p_texto), revisado_por = auth.uid() where id = p_resumo;
end;
$$;

create or replace function public.portal_resumo_publicar(p_resumo uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare r public.portal_resumo;
begin
  select * into r from public.portal_resumo where id = p_resumo;
  if not found or r.status <> 'rascunho' then raise exception 'resumo_invalido' using errcode = '22023'; end if;
  perform public._exigir_portal(r.escritorio_id);
  if public.portal_processo_sigiloso(r.processo_id) then raise exception 'segredo_de_justica' using errcode = '22023'; end if;
  update public.portal_resumo set status = 'substituido' where processo_id = r.processo_id and status = 'publicado';
  update public.portal_resumo
     set status = 'publicado', publicado_em = now(), publicado_por = auth.uid(), revisado_por = auth.uid()
   where id = p_resumo;
end;
$$;

-- Rascunho vira descartado; publicado vira retirado (some do portal).
create or replace function public.portal_resumo_encerrar(p_resumo uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare r public.portal_resumo;
begin
  select * into r from public.portal_resumo where id = p_resumo;
  if not found or r.status not in ('rascunho','publicado') then raise exception 'resumo_invalido' using errcode = '22023'; end if;
  perform public._exigir_portal(r.escritorio_id);
  update public.portal_resumo set status = case when r.status = 'publicado' then 'retirado' else 'descartado' end where id = p_resumo;
end;
$$;

-- ---------------------------------------------------------------------
-- Link mágico (servidor, service_role). Respostas nunca dizem se o e-mail existe.
-- ---------------------------------------------------------------------

-- Liberações que o e-mail da sessão pode ver AGORA: processo confirmado e fora de segredo, cliente confirmado com este e-mail.
create or replace function public._portal_liberacoes_do_email(p_email text)
returns setof public.portal_liberacao
language sql stable security definer
set search_path = ''
as $$
  select l.*
  from public.portal_liberacao l
  join public.cliente c on c.id = l.cliente_id and c.escritorio_id = l.escritorio_id and c.status = 'confirmado' and lower(c.email) = p_email
  join public.processo p on p.id = l.processo_id and p.escritorio_id = l.escritorio_id and p.status = 'confirmado'
  where l.ativo and not public.portal_processo_sigiloso(l.processo_id)
$$;

create or replace function public._portal_email_da_sessao(p_hash text)
returns text
language sql stable security definer
set search_path = ''
as $$
  select s.email from public.portal_sessao s where s.token_hash = p_hash and s.encerrada_em is null and s.expira_em > now()
$$;

-- Cliente pediu o link pelo próprio portal.
create or replace function public.portal_link_solicitar(p_email text, p_token_hash text, p_ip inet)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_escritorios text[];
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 200 then
    return jsonb_build_object('enviar', false, 'motivo', 'email_invalido');
  end if;
  if (select count(*) from public.portal_link l where l.email = v_email and l.criado_em > now() - interval '1 hour') >= 5 then
    return jsonb_build_object('enviar', false, 'motivo', 'limite');
  end if;
  select array_agg(distinct e.nome order by e.nome) into v_escritorios
  from public._portal_liberacoes_do_email(v_email) l
  join public.escritorio e on e.id = l.escritorio_id;
  if v_escritorios is null then
    return jsonb_build_object('enviar', false, 'motivo', 'sem_acesso');
  end if;

  insert into public.portal_link (email, token_hash, origem, ip) values (v_email, p_token_hash, 'cliente', p_ip);
  insert into public.portal_acesso (escritorio_id, cliente_id, tipo, ip)
  select distinct l.escritorio_id, l.cliente_id, 'link_gerado', p_ip from public._portal_liberacoes_do_email(v_email) l;
  return jsonb_build_object('enviar', true, 'escritorios', to_jsonb(v_escritorios));
end;
$$;

-- O advogado clicou em "enviar acesso" para UM cliente (nunca em lote).
create or replace function public.portal_link_advogado(p_cliente uuid, p_token_hash text, p_ip inet)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  c public.cliente;
  v_email text;
  v_nome text;
begin
  select * into c from public.cliente where id = p_cliente;
  if not found then raise exception 'cliente_nao_confirmado' using errcode = '22023'; end if;
  perform public._exigir_portal(c.escritorio_id);
  if c.status <> 'confirmado' then raise exception 'cliente_nao_confirmado' using errcode = '22023'; end if;
  if c.email is null then raise exception 'cliente_sem_email' using errcode = '22023'; end if;
  v_email := lower(c.email);
  if not exists (select 1 from public._portal_liberacoes_do_email(v_email) l where l.cliente_id = c.id) then
    raise exception 'sem_processo_liberado' using errcode = '22023';
  end if;
  if (select count(*) from public.portal_link l where l.email = v_email and l.criado_em > now() - interval '1 hour') >= 5 then
    raise exception 'limite_links' using errcode = '22023';
  end if;
  select e.nome into v_nome from public.escritorio e where e.id = c.escritorio_id;
  insert into public.portal_link (email, token_hash, origem, solicitado_por, ip) values (v_email, p_token_hash, 'advogado', auth.uid(), p_ip);
  insert into public.portal_acesso (escritorio_id, cliente_id, tipo, ip) values (c.escritorio_id, c.id, 'link_gerado', p_ip);
  return jsonb_build_object('email', v_email, 'escritorio', v_nome);
end;
$$;

-- Troca o link por uma sessão. Uso único: a linha é travada e marcada como usada na mesma transação.
create or replace function public.portal_link_consumir(p_token_hash text, p_sessao_hash text, p_ip inet, p_user_agent text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.portal_link;
  v_expira timestamptz;
  v_sessao uuid;
begin
  select * into v from public.portal_link where token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'invalido'); end if;
  if v.usado_em is not null then return jsonb_build_object('ok', false, 'motivo', 'usado'); end if;
  if v.expira_em <= now() then return jsonb_build_object('ok', false, 'motivo', 'expirado'); end if;

  update public.portal_link set usado_em = now() where id = v.id;
  insert into public.portal_sessao (email, token_hash, link_id, ip, user_agent)
  values (v.email, p_sessao_hash, v.id, p_ip, left(p_user_agent, 300))
  returning id, expira_em into v_sessao, v_expira;

  insert into public.portal_acesso (escritorio_id, cliente_id, tipo, ip)
  select distinct l.escritorio_id, l.cliente_id, 'entrou', p_ip from public._portal_liberacoes_do_email(v.email) l;
  return jsonb_build_object('ok', true, 'expira_em', v_expira);
end;
$$;

create or replace function public.portal_sessao_encerrar(p_sessao_hash text)
returns void
language sql security definer
set search_path = ''
as $$
  update public.portal_sessao set encerrada_em = now() where token_hash = p_sessao_hash and encerrada_em is null
$$;

-- ---------------------------------------------------------------------
-- Leituras do portal (service_role + hash da sessão)
-- ---------------------------------------------------------------------
create or replace function public.portal_inicio(p_sessao_hash text, p_ip inet)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_email text := public._portal_email_da_sessao(p_sessao_hash);
  v_clientes jsonb;
  v_processos jsonb;
begin
  if v_email is null then return jsonb_build_object('ok', false, 'motivo', 'sessao'); end if;

  select coalesce(jsonb_agg(distinct c.nome), '[]'::jsonb) into v_clientes
  from public._portal_liberacoes_do_email(v_email) l join public.cliente c on c.id = l.cliente_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'processo_id', p.id,
    'escritorio', e.nome,
    'numero_cnj', p.numero_cnj,
    'titulo', coalesce(l.titulo_cliente, p.classe),
    'tribunal', p.tribunal,
    'situacao_texto', l.situacao_texto,
    'ver_movimentacoes', l.ver_movimentacoes,
    'ultima_movimentacao', case when l.ver_movimentacoes then (public._portal_movimentos(p.escritorio_id, p.numero_cnj, 1)->0) end
  ) order by e.nome, p.numero_cnj), '[]'::jsonb) into v_processos
  from public._portal_liberacoes_do_email(v_email) l
  join public.processo p on p.id = l.processo_id
  join public.escritorio e on e.id = l.escritorio_id;

  insert into public.portal_acesso (escritorio_id, cliente_id, tipo, ip)
  select distinct l.escritorio_id, l.cliente_id, 'lista', p_ip from public._portal_liberacoes_do_email(v_email) l;

  return jsonb_build_object('ok', true, 'clientes', v_clientes, 'processos', v_processos);
end;
$$;

create or replace function public.portal_processo(p_sessao_hash text, p_processo uuid, p_ip inet)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_email text := public._portal_email_da_sessao(p_sessao_hash);
  l public.portal_liberacao;
  p public.processo;
  v_esc text;
  v_mov jsonb := '[]'::jsonb;
  v_resumo jsonb := null;
  v_comp jsonb := '[]'::jsonb;
  v_docs jsonb := '[]'::jsonb;
begin
  if v_email is null then return jsonb_build_object('ok', false, 'motivo', 'sessao'); end if;
  select * into l from public._portal_liberacoes_do_email(v_email) x where x.processo_id = p_processo order by x.liberado_em limit 1;
  -- Não liberado, em segredo, de outro cliente ou inexistente: a resposta é a mesma.
  if not found then return jsonb_build_object('ok', false, 'motivo', 'nao_encontrado'); end if;

  select * into p from public.processo where id = l.processo_id;
  select e.nome into v_esc from public.escritorio e where e.id = l.escritorio_id;

  if l.ver_movimentacoes then
    v_mov := public._portal_movimentos(p.escritorio_id, p.numero_cnj, 15);
  end if;

  if l.ver_resumo then
    select jsonb_build_object('texto', r.texto, 'publicado_em', r.publicado_em, 'revisado', r.revisado_por is not null)
      into v_resumo
    from public.portal_resumo r where r.processo_id = p.id and r.status = 'publicado';
  end if;

  if l.ver_compromissos then
    select coalesce(jsonb_agg(jsonb_build_object('titulo', s.titulo, 'tipo', s.tipo, 'inicio', s.inicio, 'fim', s.fim, 'local', s.local) order by s.inicio), '[]'::jsonb)
      into v_comp
    from (
      select c.titulo, c.tipo, c.inicio, c.fim, c.local from public.compromisso c
      where c.processo_id = p.id and c.escritorio_id = p.escritorio_id and c.visivel_portal and c.fim >= now()
      order by c.inicio limit 10
    ) s;
  end if;

  if l.ver_documentos then
    select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'nome', d.nome, 'mime', d.mime, 'tamanho', d.tamanho, 'compartilhado_em', d.compartilhado_em) order by d.compartilhado_em desc), '[]'::jsonb)
      into v_docs
    from public.portal_documento d where d.processo_id = p.id and d.revogado_em is null;
  end if;

  insert into public.portal_acesso (escritorio_id, cliente_id, processo_id, tipo, ip)
  values (l.escritorio_id, l.cliente_id, p.id, 'processo', p_ip);

  return jsonb_build_object(
    'ok', true,
    'processo', jsonb_build_object(
      'id', p.id, 'numero_cnj', p.numero_cnj, 'titulo', coalesce(l.titulo_cliente, p.classe),
      'tribunal', p.tribunal, 'orgao_julgador', p.orgao_julgador, 'escritorio', v_esc, 'situacao_texto', l.situacao_texto
    ),
    'ver_movimentacoes', l.ver_movimentacoes, 'ver_resumo', l.ver_resumo, 'ver_compromissos', l.ver_compromissos, 'ver_documentos', l.ver_documentos,
    'movimentacoes', v_mov, 'resumo', v_resumo, 'compromissos', v_comp, 'documentos', v_docs
  );
end;
$$;

-- Qual arquivo do Drive entregar. Quem baixa de verdade é o servidor, com o token do escritório.
create or replace function public.portal_documento_obter(p_sessao_hash text, p_processo uuid, p_documento uuid, p_ip inet)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_email text := public._portal_email_da_sessao(p_sessao_hash);
  l public.portal_liberacao;
  d public.portal_documento;
begin
  if v_email is null then return jsonb_build_object('ok', false, 'motivo', 'sessao'); end if;
  select * into l from public._portal_liberacoes_do_email(v_email) x where x.processo_id = p_processo and x.ver_documentos order by x.liberado_em limit 1;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'nao_encontrado'); end if;
  select * into d from public.portal_documento x where x.id = p_documento and x.processo_id = p_processo and x.revogado_em is null;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'nao_encontrado'); end if;

  insert into public.portal_acesso (escritorio_id, cliente_id, processo_id, tipo, ip) values (l.escritorio_id, l.cliente_id, p_processo, 'documento', p_ip);
  return jsonb_build_object('ok', true, 'escritorio_id', d.escritorio_id, 'arquivo_drive_id', d.arquivo_drive_id, 'nome', d.nome, 'mime', d.mime);
end;
$$;

-- Job de resumos: processos liberados com "resumo" ligado, fora de segredo, com movimentações.
create or replace function public.portal_resumos_pendentes(p_limite int default 20)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'escritorio_id', p.escritorio_id,
      'processo_id', p.id,
      'classe', p.classe,
      'ultimo_base_hash', (select r.base_hash from public.portal_resumo r where r.processo_id = p.id order by r.criado_em desc limit 1),
      'movimentos', public._portal_movimentos(p.escritorio_id, p.numero_cnj, 15)
    ) as x
    from public.processo p
    where p.status = 'confirmado'
      and not public.portal_processo_sigiloso(p.id)
      and exists (select 1 from public.portal_liberacao l where l.processo_id = p.id and l.ativo and l.ver_resumo)
    order by p.id
    limit greatest(least(p_limite, 200), 0)
  ) s
$$;

-- ---------------------------------------------------------------------
-- Quem pode executar o quê
-- ---------------------------------------------------------------------
-- Só o servidor (service_role):
revoke execute on function public.portal_link_solicitar(text, text, inet) from public, anon, authenticated;
revoke execute on function public.portal_link_consumir(text, text, inet, text) from public, anon, authenticated;
revoke execute on function public.portal_sessao_encerrar(text) from public, anon, authenticated;
revoke execute on function public.portal_inicio(text, inet) from public, anon, authenticated;
revoke execute on function public.portal_processo(text, uuid, inet) from public, anon, authenticated;
revoke execute on function public.portal_documento_obter(text, uuid, uuid, inet) from public, anon, authenticated;
revoke execute on function public.portal_resumos_pendentes(int) from public, anon, authenticated;
revoke execute on function public.portal_resumo_salvar_servico(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public._portal_liberacoes_do_email(text) from public, anon, authenticated;
revoke execute on function public._portal_email_da_sessao(text) from public, anon, authenticated;
revoke execute on function public._portal_movimentos(uuid, text, int) from public, anon, authenticated;
revoke execute on function public._portal_gravar_resumo(uuid, uuid, text, text, text, text, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public._portal_retirar_processo(uuid, text) from public, anon, authenticated;
revoke execute on function public.portal_processo_sigiloso(uuid) from public, anon, authenticated;
-- Usuário logado (cada função confere a permissão por dentro):
revoke execute on function public._exigir_portal(uuid) from public, anon;
revoke execute on function public.portal_liberar(uuid, uuid, boolean, boolean, boolean, boolean, text, text) from public, anon;
revoke execute on function public.portal_revogar(uuid) from public, anon;
revoke execute on function public.portal_compromisso_visivel(uuid, boolean) from public, anon;
revoke execute on function public.portal_documento_compartilhar(uuid, text, text, text, bigint) from public, anon;
revoke execute on function public.portal_documento_revogar(uuid) from public, anon;
revoke execute on function public.portal_configurar(uuid, text) from public, anon;
revoke execute on function public.portal_movimentos_para_resumo(uuid) from public, anon;
revoke execute on function public.portal_resumo_salvar(uuid, text, text, text, text, jsonb) from public, anon;
revoke execute on function public.portal_resumo_editar(uuid, text) from public, anon;
revoke execute on function public.portal_resumo_publicar(uuid) from public, anon;
revoke execute on function public.portal_resumo_encerrar(uuid) from public, anon;
revoke execute on function public.portal_link_advogado(uuid, text, inet) from public, anon;

-- ---------------------------------------------------------------------
-- Telas do advogado. Quem tem "Portal do cliente" enxerga, por estas funções, só o que o portal precisa do processo
-- (sem abrir as tabelas de processo, cliente e agenda, que seguem presas aos seus próprios módulos).
-- ---------------------------------------------------------------------
create or replace function public.portal_painel_processo(p_processo uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  p public.processo;
  v_sigiloso boolean;
begin
  select * into p from public.processo x where x.id = p_processo;
  if not found then raise exception 'processo_invalido' using errcode = '22023'; end if;
  perform public._exigir_portal(p.escritorio_id);
  v_sigiloso := public.portal_processo_sigiloso(p_processo);
  if v_sigiloso or p.status <> 'confirmado' then
    return jsonb_build_object('processo', jsonb_build_object('id', p.id, 'numero_cnj', p.numero_cnj, 'sigiloso', v_sigiloso, 'confirmado', p.status = 'confirmado'));
  end if;

  return jsonb_build_object(
    'processo', jsonb_build_object('id', p.id, 'numero_cnj', p.numero_cnj, 'classe', p.classe, 'tribunal', p.tribunal, 'sigiloso', false, 'confirmado', true),
    'modo', (select e.portal_resumo_modo from public.escritorio e where e.id = p.escritorio_id),
    'partes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'cliente_id', c.id, 'nome', c.nome, 'polo', pp.polo,
        'email_mascarado', case when c.email is null then null else left(c.email, 1) || '***@' || split_part(c.email, '@', 2) end,
        'liberacao', (select jsonb_build_object(
            'id', l.id, 'ativo', l.ativo, 'ver_movimentacoes', l.ver_movimentacoes, 'ver_resumo', l.ver_resumo,
            'ver_compromissos', l.ver_compromissos, 'ver_documentos', l.ver_documentos, 'situacao_texto', l.situacao_texto, 'titulo_cliente', l.titulo_cliente)
          from public.portal_liberacao l where l.processo_id = p.id and l.cliente_id = c.id)
      ) order by c.nome), '[]'::jsonb)
      from public.processo_parte pp join public.cliente c on c.id = pp.cliente_id and c.status = 'confirmado'
      where pp.processo_id = p.id
    ),
    'compromissos', (
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'titulo', c.titulo, 'tipo', c.tipo, 'inicio', c.inicio, 'local', c.local, 'visivel_portal', c.visivel_portal) order by c.inicio), '[]'::jsonb)
      from (select * from public.compromisso x where x.processo_id = p.id and x.fim >= now() order by x.inicio limit 30) c
    ),
    'resumos', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'texto', r.texto, 'status', r.status, 'origem', r.origem, 'alertas', r.alertas, 'criado_em', r.criado_em, 'publicado_em', r.publicado_em, 'revisado', r.revisado_por is not null
      ) order by r.criado_em desc), '[]'::jsonb)
      from public.portal_resumo r where r.processo_id = p.id and r.status in ('rascunho','publicado')
    ),
    'documentos', (
      select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'nome', d.nome, 'tamanho', d.tamanho, 'arquivo_drive_id', d.arquivo_drive_id, 'compartilhado_em', d.compartilhado_em) order by d.compartilhado_em desc), '[]'::jsonb)
      from public.portal_documento d where d.processo_id = p.id and d.revogado_em is null
    )
  );
end;
$$;

create or replace function public.portal_visao_geral(p_escritorio uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform public._exigir_portal(p_escritorio);
  return jsonb_build_object(
    'modo', (select e.portal_resumo_modo from public.escritorio e where e.id = p_escritorio),
    'e_dono', public.eh_dono(p_escritorio),
    'liberacoes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', l.id, 'processo_id', l.processo_id, 'numero_cnj', p.numero_cnj, 'cliente_nome', c.nome,
        'ver_movimentacoes', l.ver_movimentacoes, 'ver_resumo', l.ver_resumo, 'ver_compromissos', l.ver_compromissos, 'ver_documentos', l.ver_documentos,
        'liberado_em', l.liberado_em
      ) order by l.liberado_em desc), '[]'::jsonb)
      from (select * from public.portal_liberacao x where x.escritorio_id = p_escritorio and x.ativo order by x.liberado_em desc limit 200) l
      join public.processo p on p.id = l.processo_id
      join public.cliente c on c.id = l.cliente_id
    ),
    'rascunhos', (
      select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'processo_id', r.processo_id, 'numero_cnj', p.numero_cnj, 'criado_em', r.criado_em, 'alertas', jsonb_array_length(r.alertas)) order by r.criado_em desc), '[]'::jsonb)
      from (select * from public.portal_resumo x where x.escritorio_id = p_escritorio and x.status = 'rascunho' order by x.criado_em desc limit 50) r
      join public.processo p on p.id = r.processo_id
    ),
    'acessos', (
      select coalesce(jsonb_agg(jsonb_build_object('criado_em', a.criado_em, 'tipo', a.tipo, 'ip', host(a.ip), 'cliente_nome', c.nome, 'numero_cnj', p.numero_cnj) order by a.criado_em desc), '[]'::jsonb)
      from (select * from public.portal_acesso x where x.escritorio_id = p_escritorio and x.tipo <> 'lista' order by x.criado_em desc limit 40) a
      join public.cliente c on c.id = a.cliente_id
      left join public.processo p on p.id = a.processo_id
    )
  );
end;
$$;

revoke execute on function public.portal_painel_processo(uuid) from public, anon;
revoke execute on function public.portal_visao_geral(uuid) from public, anon;

-- Pasta do processo no Drive, para o advogado escolher o que compartilhar. Processo em segredo não devolve pasta.
create or replace function public.portal_pasta_processo(p_processo uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_esc uuid;
  v_drive text;
begin
  select p.escritorio_id into v_esc from public.processo p where p.id = p_processo and p.status = 'confirmado';
  if v_esc is null then raise exception 'processo_invalido' using errcode = '22023'; end if;
  perform public._exigir_portal(v_esc);
  if public.portal_processo_sigiloso(p_processo) then raise exception 'segredo_de_justica' using errcode = '22023'; end if;
  select d.drive_id into v_drive from public.drive_pasta d where d.tipo = 'processo' and d.ref_id = p_processo and d.status = 'ativa';
  if v_drive is null then return null; end if;
  return jsonb_build_object('escritorio_id', v_esc, 'drive_id', v_drive);
end;
$$;
revoke execute on function public.portal_pasta_processo(uuid) from public, anon;
