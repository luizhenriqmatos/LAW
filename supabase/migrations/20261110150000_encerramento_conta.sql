-- Prompt 14: encerramento de conta, exportação e exclusão de dados.
--
-- Fluxo: o dono pede o encerramento -> conta fica 30 dias em "encerramento" (somente leitura para usuários logados,
-- exportação completa liberada) -> depois do prazo o job apaga os dados do escritório. Documentos assinados e suas
-- evidências NÃO são apagados: as tabelas assinatura_* não têm FK para escritorio e os gatilhos delas bloqueiam
-- DELETE até `retencao_ate` (5 anos). O relógio é sempre um parâmetro (p_agora) para ser testável.

-- =====================================================================
-- Estado do encerramento no escritório
-- =====================================================================
alter table public.escritorio
  add column encerramento_solicitado_em timestamptz null,
  add column encerramento_solicitado_por uuid null,
  add column encerramento_ate timestamptz null,
  add column aviso_pedido_em timestamptz null,
  add column aviso_7d_em timestamptz null,
  add constraint escritorio_encerramento_coerente check (
    (encerramento_ate is null) = (encerramento_solicitado_em is null)
    and (encerramento_ate is null or encerramento_ate > encerramento_solicitado_em)
  );

-- Registro que sobrevive à exclusão (sem FK de propósito): prova do que foi feito e fila do último e-mail.
create table public.conta_encerrada (
  escritorio_id uuid primary key,
  escritorio_nome text not null,
  solicitado_em timestamptz not null,
  excluido_em timestamptz not null,
  destinatarios text[] not null default '{}',
  envelopes_retidos int not null default 0,
  aviso_exclusao_em timestamptz null
);
alter table public.conta_encerrada enable row level security;
revoke all on public.conta_encerrada from anon, authenticated;

-- =====================================================================
-- Somente leitura durante o encerramento (só para quem está logado; jobs de serviço seguem normais)
-- =====================================================================
create or replace function public.bloquear_escrita_encerramento()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_esc uuid;
begin
  if auth.uid() is null or coalesce(current_setting('law.purga', true), '') = 'on' then
    return coalesce(new, old);
  end if;
  v_esc := case when tg_op = 'DELETE' then (to_jsonb(old)->>'escritorio_id')::uuid else (to_jsonb(new)->>'escritorio_id')::uuid end;
  if v_esc is not null and exists (select 1 from public.escritorio e where e.id = v_esc and e.encerramento_ate is not null) then
    raise exception 'conta_somente_leitura' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

-- Tabelas que continuam graváveis: log de auditoria, avisos e documentos assinados (o cliente ainda pode assinar).
create or replace function public.tabelas_com_escopo_de_escritorio()
returns setof text
language sql stable
set search_path = ''
as $$
  select c.table_name::text
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
   where c.table_schema = 'public' and c.column_name = 'escritorio_id' and c.table_name <> 'conta_encerrada'
   order by 1
$$;

do $$
declare
  t text;
begin
  for t in select public.tabelas_com_escopo_de_escritorio() loop
    if t in ('audit_log', 'notificacao') or t like 'assinatura\_%' then
      continue;
    end if;
    execute format(
      'create trigger bloquear_encerramento before insert or update or delete on public.%I
         for each row execute function public.bloquear_escrita_encerramento()', t);
  end loop;
end $$;

create or replace function public.bloquear_edicao_escritorio_encerrando()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.encerramento_ate is not null and auth.uid() is not null
     and coalesce(current_setting('law.purga', true), '') <> 'on'
     and (new.nome is distinct from old.nome or new.cnpj is distinct from old.cnpj) then
    raise exception 'conta_somente_leitura' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger escritorio_somente_leitura before update on public.escritorio
  for each row execute function public.bloquear_edicao_escritorio_encerrando();

-- A exclusão final não deve despejar dados pessoais no log de auditoria.
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
  if coalesce(current_setting('law.purga', true), '') = 'on' then
    return coalesce(new, old);
  end if;
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

-- =====================================================================
-- Pedido e cancelamento (dono)
-- =====================================================================
create or replace function public.conta_encerramento_solicitar(p_escritorio uuid, p_usuario uuid, p_agora timestamptz)
returns timestamptz
language plpgsql security definer
set search_path = ''
as $$
declare
  e public.escritorio;
begin
  if not exists (select 1 from public.membro m where m.escritorio_id = p_escritorio and m.usuario_id = p_usuario and m.papel = 'dono') then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  select * into e from public.escritorio where id = p_escritorio for update;
  if e.encerramento_ate is not null then
    raise exception 'ja_em_encerramento' using errcode = '23505';
  end if;
  update public.escritorio
     set encerramento_solicitado_em = p_agora,
         encerramento_solicitado_por = p_usuario,
         encerramento_ate = p_agora + interval '30 days',
         aviso_pedido_em = null,
         aviso_7d_em = null
   where id = p_escritorio;
  return p_agora + interval '30 days';
end;
$$;

create or replace function public.encerramento_solicitar(p_escritorio uuid)
returns timestamptz
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  return public.conta_encerramento_solicitar(p_escritorio, auth.uid(), now());
end;
$$;

create or replace function public.encerramento_cancelar(p_escritorio uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.eh_dono(p_escritorio) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  update public.escritorio
     set encerramento_solicitado_em = null, encerramento_solicitado_por = null, encerramento_ate = null,
         aviso_pedido_em = null, aviso_7d_em = null
   where id = p_escritorio and encerramento_ate is not null;
  if not found then
    raise exception 'sem_encerramento' using errcode = '22023';
  end if;
end;
$$;

-- =====================================================================
-- Exportação completa (dono, a qualquer momento)
-- =====================================================================
-- Todas as tabelas com escritorio_id, exceto assinaturas (têm função própria). Sem colunas cifradas, hashes de
-- token e bytea. Devolve { tabela: [linhas] }.
create or replace function public.conta_exportar(p_escritorio uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  t text;
  cols text;
  j jsonb;
  v jsonb := '{}'::jsonb;
begin
  if not public.eh_dono(p_escritorio) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  for t in select public.tabelas_com_escopo_de_escritorio() loop
    if t like 'assinatura\_%' then
      continue;
    end if;
    select string_agg(format('%I', c.column_name), ', ' order by c.ordinal_position) into cols
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = t
       and c.column_name not like '%cifrado' and c.column_name <> 'token_hash' and c.data_type <> 'bytea';
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from (select %s from public.%I where escritorio_id = $1) x', cols, t)
      into j using p_escritorio;
    v := v || jsonb_build_object(t, j);
  end loop;
  return v;
end;
$$;

-- Envelopes de assinatura do escritório, com signatários e evidências (sem token e sem PDF; o PDF vai à parte).
create or replace function public.conta_exportar_assinaturas(p_escritorio uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.eh_dono(p_escritorio) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'assinatura_envelope', coalesce((select jsonb_agg(to_jsonb(x) order by x.criado_em) from public.assinatura_envelope x where x.escritorio_id = p_escritorio), '[]'::jsonb),
    'assinatura_signatario', coalesce((select jsonb_agg(to_jsonb(x) - 'token_hash' - 'token_expira_em') from public.assinatura_signatario x where x.escritorio_id = p_escritorio), '[]'::jsonb),
    'assinatura_evidencia', coalesce((select jsonb_agg(to_jsonb(x)) from public.assinatura_evidencia x where x.escritorio_id = p_escritorio), '[]'::jsonb)
  );
end;
$$;

-- PDFs de um envelope (base64), para o ZIP.
create or replace function public.conta_exportar_arquivo(p_escritorio uuid, p_envelope uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  r jsonb;
begin
  if not public.eh_dono(p_escritorio) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  select jsonb_build_object('nome_arquivo', e.nome_arquivo, 'original', encode(a.original, 'base64'),
                            'final', case when a.final is null then null else encode(a.final, 'base64') end)
    into r
    from public.assinatura_envelope e
    join public.assinatura_arquivo a on a.envelope_id = e.id
   where e.id = p_envelope and e.escritorio_id = p_escritorio;
  return r;
end;
$$;

-- =====================================================================
-- Rotina (service_role): avisos e exclusão
-- =====================================================================
create or replace function public.conta_vencidas(p_agora timestamptz)
returns uuid[]
language sql stable security definer
set search_path = ''
as $$
  select coalesce(array_agg(e.id order by e.encerramento_ate), '{}')
    from public.escritorio e
   where e.encerramento_ate is not null and e.encerramento_ate <= p_agora
$$;

create or replace function public.conta_excluir(p_escritorio uuid, p_agora timestamptz)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  e public.escritorio;
  v_emails text[];
  v_ret int;
begin
  select * into e from public.escritorio where id = p_escritorio for update;
  if not found then
    raise exception 'escritorio_inexistente' using errcode = 'P0002';
  end if;
  if e.encerramento_ate is null or e.encerramento_ate > p_agora then
    raise exception 'fora_do_prazo' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct m.email order by m.email), '{}') into v_emails
    from public.membro m where m.escritorio_id = p_escritorio and m.papel = 'dono';
  select count(*) into v_ret from public.assinatura_envelope where escritorio_id = p_escritorio;

  perform set_config('law.purga', 'on', true);
  -- As FKs são todas "on delete cascade": apagar o escritório leva as tabelas do escritório. As assinaturas não têm
  -- FK nem passam pelo cascade, e os gatilhos delas ainda bloqueariam o DELETE durante a retenção.
  delete from public.escritorio where id = p_escritorio;
  -- Log de auditoria do escritório vai embora (tem dados pessoais), menos o das assinaturas.
  delete from public.audit_log where escritorio_id = p_escritorio and tabela not like 'assinatura\_%';
  perform set_config('law.purga', 'off', true);

  insert into public.conta_encerrada (escritorio_id, escritorio_nome, solicitado_em, excluido_em, destinatarios, envelopes_retidos)
  values (p_escritorio, e.nome, e.encerramento_solicitado_em, p_agora, v_emails, v_ret);
  insert into public.audit_log (escritorio_id, usuario_id, tabela, registro_id, acao, antes, depois)
  values (p_escritorio, null, 'escritorio', p_escritorio::text, 'delete',
          jsonb_build_object('nome', e.nome, 'excluido_em', p_agora, 'envelopes_retidos', v_ret), null);
  return jsonb_build_object('excluido', true, 'envelopes_retidos', v_ret);
end;
$$;

-- Avisos que ainda faltam enviar: pedido, 7 dias antes e exclusão (esta vem do registro que sobrevive).
create or replace function public.conta_pendencias(p_agora timestamptz)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(x order by x->>'tipo', x->>'escritorio_id'), '[]'::jsonb) from (
    select jsonb_build_object('escritorio_id', e.id, 'tipo', 'pedido', 'nome', e.nome, 'ate', e.encerramento_ate,
             'destinatarios', (select coalesce(jsonb_agg(m.email order by m.email), '[]'::jsonb) from public.membro m where m.escritorio_id = e.id and m.papel = 'dono')) x
      from public.escritorio e
     where e.encerramento_ate is not null and e.aviso_pedido_em is null
    union all
    select jsonb_build_object('escritorio_id', e.id, 'tipo', 'sete_dias', 'nome', e.nome, 'ate', e.encerramento_ate,
             'destinatarios', (select coalesce(jsonb_agg(m.email order by m.email), '[]'::jsonb) from public.membro m where m.escritorio_id = e.id and m.papel = 'dono'))
      from public.escritorio e
     where e.encerramento_ate is not null and e.aviso_7d_em is null
       and p_agora >= e.encerramento_ate - interval '7 days' and p_agora < e.encerramento_ate
    union all
    select jsonb_build_object('escritorio_id', c.escritorio_id, 'tipo', 'exclusao', 'nome', c.escritorio_nome, 'ate', c.excluido_em,
             'destinatarios', to_jsonb(c.destinatarios))
      from public.conta_encerrada c
     where c.aviso_exclusao_em is null
  ) q
$$;

create or replace function public.conta_marcar_aviso(p_escritorio uuid, p_tipo text, p_agora timestamptz)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_tipo = 'pedido' then
    update public.escritorio set aviso_pedido_em = p_agora where id = p_escritorio;
  elsif p_tipo = 'sete_dias' then
    update public.escritorio set aviso_7d_em = p_agora where id = p_escritorio;
  elsif p_tipo = 'exclusao' then
    update public.conta_encerrada set aviso_exclusao_em = p_agora where escritorio_id = p_escritorio;
  else
    raise exception 'tipo_invalido' using errcode = '22023';
  end if;
end;
$$;

-- =====================================================================
-- Privilégios
-- =====================================================================
revoke execute on function public.conta_encerramento_solicitar(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.conta_vencidas(timestamptz) from public, anon, authenticated;
revoke execute on function public.conta_excluir(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.conta_pendencias(timestamptz) from public, anon, authenticated;
revoke execute on function public.conta_marcar_aviso(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.conta_encerramento_solicitar(uuid, uuid, timestamptz) to service_role;
grant execute on function public.conta_vencidas(timestamptz) to service_role;
grant execute on function public.conta_excluir(uuid, timestamptz) to service_role;
grant execute on function public.conta_pendencias(timestamptz) to service_role;
grant execute on function public.conta_marcar_aviso(uuid, text, timestamptz) to service_role;

revoke execute on function public.encerramento_solicitar(uuid) from public, anon;
revoke execute on function public.encerramento_cancelar(uuid) from public, anon;
revoke execute on function public.conta_exportar(uuid) from public, anon;
revoke execute on function public.conta_exportar_assinaturas(uuid) from public, anon;
revoke execute on function public.conta_exportar_arquivo(uuid, uuid) from public, anon;
grant execute on function public.encerramento_solicitar(uuid) to authenticated;
grant execute on function public.encerramento_cancelar(uuid) to authenticated;
grant execute on function public.conta_exportar(uuid) to authenticated;
grant execute on function public.conta_exportar_assinaturas(uuid) to authenticated;
grant execute on function public.conta_exportar_arquivo(uuid, uuid) to authenticated;
revoke execute on function public.tabelas_com_escopo_de_escritorio() from public, anon;
grant execute on function public.tabelas_com_escopo_de_escritorio() to authenticated, service_role;
