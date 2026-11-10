-- =====================================================================
-- Prompt 13: recepcionista do WhatsApp (atendimento inicial automático com passagem para humano).
--
-- Regras centrais:
--  - A recepcionista NÃO escreve texto livre: todas as respostas dela são frases fixas do código (src/lib/whatsapp).
--    A IA, se ligada, só escolhe uma das 5 categorias. Por isso ela não consegue dar orientação jurídica,
--    opinar sobre o caso, prever resultado, informar dado de processo nem prometer prazo.
--  - Passou para humano => conversa em estado 'humano' e a recepcionista fica MUDA até alguém encerrar o atendimento.
--  - Janela de 24 h da Meta: texto livre só dentro de 24 h da última mensagem do contato. Fora dela, só o modelo
--    (template) aprovado, e só em conversa que o próprio contato iniciou (sem disparo em massa).
--  - Webhook roda com service_role: as funções recepcao_* são só do servidor. As telas usam atendimento_*.
--  - Mensagens têm dado pessoal: leitura só com o módulo 'atendimento'; não vão para o audit_log (a própria
--    whatsapp_mensagem é o registro). Conversa, atendimento, número e configuração gravam em audit_log.
-- =====================================================================

create or replace function public.modulos_validos()
returns text[]
language sql immutable
set search_path = ''
as $$
  select array['agenda','processos','prazos','tarefas','financeiro','calculos','documentos','portal_cliente','assinaturas','assistente','atendimento','configuracoes']::text[]
$$;

alter table public.notificacao drop constraint notificacao_tipo_check;
alter table public.notificacao add constraint notificacao_tipo_check
  check (tipo in ('prazo_antes_3','prazo_dia','prazo_vencido','google','atendimento_novo'));

-- DDD + 8 últimos dígitos: casa o telefone do WhatsApp (55 + DDD + 9 + 8 dígitos, ou sem o 9) com o cadastro.
create or replace function public.telefone_chave(p text)
returns text
language sql immutable
set search_path = ''
as $$
  with d as (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as n),
  s as (select case when length(n) >= 12 and left(n, 2) = '55' then substr(n, 3) else n end as n from d)
  select case when length(n) >= 10 then left(n, 2) || right(n, 8) else null end from s
$$;

-- =====================================================================
-- Tabelas
-- =====================================================================
create table public.recepcao_config (
  escritorio_id uuid primary key references public.escritorio(id) on delete cascade,
  ativa boolean not null default false,
  -- Quem é avisado a cada atendimento novo. Vazio = todos os donos do escritório.
  responsavel_id uuid null references auth.users(id) on delete set null,
  -- Frases escritas pelo escritório e repetidas como estão. Vazio = a recepcionista não fala de prazo nem horário.
  prazo_resposta_texto text null check (prazo_resposta_texto is null or length(btrim(prazo_resposta_texto)) between 1 and 160),
  horario_texto text null check (horario_texto is null or length(btrim(horario_texto)) between 1 and 160),
  -- Modelo (template) aprovado na Meta, usado para retomar conversa fora da janela de 24 h.
  modelo_retomada text null check (modelo_retomada is null or modelo_retomada ~ '^[a-z0-9_]{1,200}$'),
  modelo_idioma text not null default 'pt_BR' check (modelo_idioma ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  atualizado_em timestamptz not null default now()
);

create table public.whatsapp_numero (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  phone_number_id text not null unique check (phone_number_id ~ '^\d{5,24}$'),
  numero_exibicao text null check (numero_exibicao is null or length(numero_exibicao) <= 30),
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);
create index whatsapp_numero_escritorio_idx on public.whatsapp_numero (escritorio_id);

create table public.whatsapp_conversa (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  numero_id uuid not null references public.whatsapp_numero(id) on delete cascade,
  telefone text not null check (telefone ~ '^\d{8,16}$'),
  nome_perfil text null check (nome_perfil is null or length(nome_perfil) <= 120),
  cliente_id uuid null references public.cliente(id) on delete set null,
  -- cliente_cadastrado: um único cliente confirmado tem este telefone. ambiguo: mais de um. novo_contato: nenhum.
  identificacao text not null check (identificacao in ('cliente_cadastrado','ambiguo','novo_contato')),
  estado text not null default 'novo'
    check (estado in ('novo','aguardando_motivo','aguardando_nome','aguardando_resumo','humano','encerrada')),
  categoria text null check (categoria in ('novo_caso','andamento','financeiro','agendamento','outro')),
  nome_informado text null check (nome_informado is null or length(nome_informado) <= 120),
  resumo text null check (resumo is null or length(resumo) <= 500),
  tentativas int not null default 0 check (tentativas between 0 and 10),
  versao int not null default 1,
  -- Última mensagem RECEBIDA do contato: a janela de 24 h conta a partir dela.
  ultima_entrada_em timestamptz not null default now(),
  atendimento_id uuid null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
-- Uma conversa em andamento por contato e número.
create unique index whatsapp_conversa_ativa_idx on public.whatsapp_conversa (numero_id, telefone) where estado <> 'encerrada';
create index whatsapp_conversa_escritorio_idx on public.whatsapp_conversa (escritorio_id, atualizado_em desc);

create table public.atendimento (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  conversa_id uuid not null references public.whatsapp_conversa(id) on delete cascade,
  cliente_id uuid null references public.cliente(id) on delete set null,
  identificacao text not null check (identificacao in ('cliente_cadastrado','ambiguo','novo_contato')),
  canal text not null default 'whatsapp' check (canal = 'whatsapp'),
  telefone text not null,
  nome_contato text not null check (length(nome_contato) between 1 and 200),
  categoria text not null check (categoria in ('novo_caso','andamento','financeiro','agendamento','outro')),
  resumo text null check (resumo is null or length(resumo) <= 500),
  status text not null default 'aberto' check (status in ('aberto','em_andamento','encerrado')),
  responsavel_id uuid null references auth.users(id) on delete set null,
  ultima_leitura_em timestamptz null,
  encerrado_em timestamptz null,
  encerrado_por uuid null,
  criado_em timestamptz not null default now(),
  check ((status = 'encerrado') = (encerrado_em is not null))
);
create index atendimento_escritorio_idx on public.atendimento (escritorio_id, status, criado_em desc);
alter table public.whatsapp_conversa add constraint whatsapp_conversa_atendimento_fk
  foreign key (atendimento_id) references public.atendimento(id) on delete set null;

create table public.whatsapp_mensagem (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null references public.escritorio(id) on delete cascade,
  conversa_id uuid not null references public.whatsapp_conversa(id) on delete cascade,
  direcao text not null check (direcao in ('entrada','saida')),
  autor text not null check (autor in ('contato','recepcao','humano')),
  usuario_id uuid null references auth.users(id) on delete set null,
  wamid text null,
  tipo text not null default 'texto' check (tipo in ('texto','modelo','outro')),
  texto text null check (texto is null or length(texto) <= 4096),
  status text not null check (status in ('recebida','pendente','enviada','entregue','lida','falhou')),
  erro text null check (erro is null or length(erro) <= 500),
  -- Entrada já tratada pela recepcionista. Se o servidor cair no meio, a Meta reenvia e a mensagem é tratada de novo.
  processada_em timestamptz null,
  criado_em timestamptz not null default clock_timestamp(),
  check ((direcao = 'entrada') = (autor = 'contato'))
);
create unique index whatsapp_mensagem_wamid_idx on public.whatsapp_mensagem (wamid) where wamid is not null;
create index whatsapp_mensagem_conversa_idx on public.whatsapp_mensagem (conversa_id, criado_em);

alter table public.recepcao_config enable row level security;
alter table public.whatsapp_numero enable row level security;
alter table public.whatsapp_conversa enable row level security;
alter table public.atendimento enable row level security;
alter table public.whatsapp_mensagem enable row level security;

create policy recepcao_config_select on public.recepcao_config for select to authenticated using (public.pode_ver(escritorio_id, 'atendimento'));
create policy whatsapp_numero_select on public.whatsapp_numero for select to authenticated using (public.pode_ver(escritorio_id, 'atendimento'));
create policy whatsapp_conversa_select on public.whatsapp_conversa for select to authenticated using (public.pode_ver(escritorio_id, 'atendimento'));
create policy atendimento_select on public.atendimento for select to authenticated using (public.pode_ver(escritorio_id, 'atendimento'));
create policy whatsapp_mensagem_select on public.whatsapp_mensagem for select to authenticated using (public.pode_ver(escritorio_id, 'atendimento'));

revoke all on public.recepcao_config, public.whatsapp_numero, public.whatsapp_conversa, public.atendimento, public.whatsapp_mensagem
  from public, anon, authenticated;
grant select on public.recepcao_config, public.whatsapp_numero, public.whatsapp_conversa, public.atendimento, public.whatsapp_mensagem to authenticated;

create trigger auditoria_recepcao_config after insert or update or delete on public.recepcao_config
  for each row execute function public.registrar_auditoria();
create trigger auditoria_whatsapp_numero after insert or update or delete on public.whatsapp_numero
  for each row execute function public.registrar_auditoria();
create trigger auditoria_whatsapp_conversa after insert or update or delete on public.whatsapp_conversa
  for each row execute function public.registrar_auditoria();
create trigger auditoria_atendimento after insert or update or delete on public.atendimento
  for each row execute function public.registrar_auditoria();

-- =====================================================================
-- Telas: configuração (só o dono)
-- =====================================================================
create or replace function public.recepcao_config_salvar(p_escritorio uuid, p_dados jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_resp uuid := nullif(p_dados->>'responsavel_id', '')::uuid;
begin
  if not public.eh_dono(p_escritorio) then raise exception 'sem_permissao' using errcode = '42501'; end if;
  if v_resp is not null and not exists (select 1 from public.membro m where m.escritorio_id = p_escritorio and m.usuario_id = v_resp) then
    raise exception 'responsavel_invalido' using errcode = '22023';
  end if;
  insert into public.recepcao_config (escritorio_id, ativa, responsavel_id, prazo_resposta_texto, horario_texto, modelo_retomada, modelo_idioma)
  values (
    p_escritorio, coalesce((p_dados->>'ativa')::boolean, false), v_resp,
    nullif(btrim(coalesce(p_dados->>'prazo_resposta_texto', '')), ''),
    nullif(btrim(coalesce(p_dados->>'horario_texto', '')), ''),
    nullif(btrim(coalesce(p_dados->>'modelo_retomada', '')), ''),
    coalesce(nullif(btrim(coalesce(p_dados->>'modelo_idioma', '')), ''), 'pt_BR')
  )
  on conflict (escritorio_id) do update set
    ativa = excluded.ativa, responsavel_id = excluded.responsavel_id,
    prazo_resposta_texto = excluded.prazo_resposta_texto, horario_texto = excluded.horario_texto,
    modelo_retomada = excluded.modelo_retomada, modelo_idioma = excluded.modelo_idioma, atualizado_em = now();
end;
$$;

create or replace function public.whatsapp_numero_salvar(p_escritorio uuid, p_phone_number_id text, p_numero_exibicao text, p_ativo boolean)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.eh_dono(p_escritorio) then raise exception 'sem_permissao' using errcode = '42501'; end if;
  if exists (select 1 from public.whatsapp_numero n where n.phone_number_id = p_phone_number_id and n.escritorio_id <> p_escritorio) then
    raise exception 'numero_em_uso' using errcode = '23505';
  end if;
  insert into public.whatsapp_numero (escritorio_id, phone_number_id, numero_exibicao, ativo)
  values (p_escritorio, p_phone_number_id, nullif(btrim(coalesce(p_numero_exibicao, '')), ''), coalesce(p_ativo, true))
  on conflict (phone_number_id) do update set numero_exibicao = excluded.numero_exibicao, ativo = excluded.ativo;
end;
$$;

-- =====================================================================
-- Webhook (service_role)
-- =====================================================================
create or replace function public._recepcao_estado(p_conversa uuid)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'conversa_id', c.id, 'escritorio_id', c.escritorio_id, 'estado', c.estado, 'versao', c.versao,
    'categoria', c.categoria, 'nome', c.nome_informado, 'resumo', c.resumo, 'tentativas', c.tentativas,
    'identificado', c.cliente_id is not null, 'identificacao', c.identificacao,
    'telefone', c.telefone, 'atendimento_id', c.atendimento_id,
    'phone_number_id', n.phone_number_id,
    'escritorio_nome', e.nome,
    'prazo_resposta_texto', g.prazo_resposta_texto, 'horario_texto', g.horario_texto
  )
  from public.whatsapp_conversa c
  join public.whatsapp_numero n on n.id = c.numero_id
  join public.escritorio e on e.id = c.escritorio_id
  left join public.recepcao_config g on g.escritorio_id = c.escritorio_id
  where c.id = p_conversa
$$;

-- Grava a mensagem recebida (idempotente pelo wamid) e devolve o estado da conversa para o servidor decidir a resposta.
create or replace function public.recepcao_receber(
  p_phone_number_id text, p_wa_id text, p_wamid text, p_tipo text, p_texto text, p_nome_perfil text, p_enviada_em timestamptz
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  n public.whatsapp_numero;
  g public.recepcao_config;
  c public.whatsapp_conversa;
  v_ids uuid[];
  v_ident text;
  v_cliente uuid;
  v_quando timestamptz := least(coalesce(p_enviada_em, now()), now());
  v_msg uuid;
  d public.whatsapp_mensagem;
begin
  select * into n from public.whatsapp_numero where phone_number_id = p_phone_number_id and ativo;
  if not found then return jsonb_build_object('ignorado', 'numero_desconhecido'); end if;
  select * into g from public.recepcao_config where escritorio_id = n.escritorio_id;
  if not found or not g.ativa then return jsonb_build_object('ignorado', 'recepcao_desativada'); end if;
  if p_wamid is not null then
    select * into d from public.whatsapp_mensagem where wamid = p_wamid;
    if found then
      if d.processada_em is not null or d.escritorio_id <> n.escritorio_id then return jsonb_build_object('ignorado', 'duplicada'); end if;
      -- Reenvio da Meta de uma mensagem que chegou mas não foi tratada: trata agora.
      return public._recepcao_estado(d.conversa_id) || jsonb_build_object('mensagem_id', d.id);
    end if;
  end if;

  select * into c from public.whatsapp_conversa where numero_id = n.id and telefone = p_wa_id and estado <> 'encerrada' for update;
  if not found then
    select array_agg(k.id) into v_ids from public.cliente k
      where k.escritorio_id = n.escritorio_id and k.status = 'confirmado' and k.telefone is not null
        and public.telefone_chave(k.telefone) = public.telefone_chave(p_wa_id);
    v_ident := case when coalesce(cardinality(v_ids), 0) = 1 then 'cliente_cadastrado'
                    when coalesce(cardinality(v_ids), 0) > 1 then 'ambiguo' else 'novo_contato' end;
    v_cliente := case when v_ident = 'cliente_cadastrado' then v_ids[1] end;
    insert into public.whatsapp_conversa (escritorio_id, numero_id, telefone, nome_perfil, cliente_id, identificacao, ultima_entrada_em)
    values (n.escritorio_id, n.id, p_wa_id, left(p_nome_perfil, 120), v_cliente, v_ident, v_quando)
    returning * into c;
  else
    update public.whatsapp_conversa
      set ultima_entrada_em = greatest(ultima_entrada_em, v_quando), atualizado_em = now(),
          nome_perfil = coalesce(left(p_nome_perfil, 120), nome_perfil)
      where id = c.id;
  end if;

  -- Com humano na conversa a recepcionista está muda: nada a tratar.
  insert into public.whatsapp_mensagem (escritorio_id, conversa_id, direcao, autor, wamid, tipo, texto, status, processada_em, criado_em)
  values (n.escritorio_id, c.id, 'entrada', 'contato', p_wamid, case when p_tipo = 'texto' then 'texto' else 'outro' end,
          left(p_texto, 4096), 'recebida', case when c.estado = 'humano' then now() end, clock_timestamp())
  returning id into v_msg;

  return public._recepcao_estado(c.id) || jsonb_build_object('mensagem_id', v_msg);
end;
$$;

-- Aplica a decisão da recepcionista de uma vez só: novo estado, respostas (pendentes de envio) e, se for o caso,
-- o atendimento + aviso ao responsável. 'conversa_mudou' (40001) = outra mensagem passou na frente; o servidor tenta de novo.
create or replace function public.recepcao_aplicar(
  p_conversa uuid, p_versao int, p_estado text, p_categoria text, p_nome text, p_resumo text, p_tentativas int,
  p_respostas text[], p_transferir boolean, p_mensagem uuid
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  c public.whatsapp_conversa;
  g public.recepcao_config;
  v_at uuid;
  v_nome text;
  v_saidas jsonb := '[]'::jsonb;
  v_id uuid;
  v_txt text;
  v_dest uuid[];
  u uuid;
  v_rotulo text;
begin
  select * into c from public.whatsapp_conversa where id = p_conversa for update;
  if not found then raise exception 'conversa_inexistente' using errcode = '22023'; end if;
  if c.versao <> p_versao or c.estado = 'humano' or c.estado = 'encerrada' then
    raise exception 'conversa_mudou' using errcode = '40001';
  end if;
  select * into g from public.recepcao_config where escritorio_id = c.escritorio_id;

  update public.whatsapp_conversa set
    estado = case when p_transferir then 'humano' else p_estado end,
    categoria = p_categoria, nome_informado = left(p_nome, 120), resumo = left(p_resumo, 500),
    tentativas = p_tentativas, versao = versao + 1, atualizado_em = now()
  where id = c.id;

  if p_transferir then
    select coalesce(nullif(btrim(k.nome), ''), null) into v_nome from public.cliente k where k.id = c.cliente_id;
    v_nome := coalesce(v_nome, nullif(btrim(p_nome), ''), nullif(btrim(c.nome_perfil), ''), 'Contato ' || c.telefone);
    insert into public.atendimento (escritorio_id, conversa_id, cliente_id, identificacao, telefone, nome_contato, categoria, resumo, responsavel_id)
    values (c.escritorio_id, c.id, c.cliente_id, c.identificacao, c.telefone, left(v_nome, 200), coalesce(p_categoria, 'outro'),
            left(p_resumo, 500), g.responsavel_id)
    returning id into v_at;
    update public.whatsapp_conversa set atendimento_id = v_at where id = c.id;

    v_rotulo := case coalesce(p_categoria, 'outro')
      when 'novo_caso' then 'Novo caso' when 'andamento' then 'Andamento de processo' when 'financeiro' then 'Financeiro'
      when 'agendamento' then 'Agendamento' else 'Outro assunto' end;
    v_dest := case
      when g.responsavel_id is not null and exists (select 1 from public.membro m where m.escritorio_id = c.escritorio_id and m.usuario_id = g.responsavel_id)
        then array[g.responsavel_id]
      else array(select m.usuario_id from public.membro m where m.escritorio_id = c.escritorio_id and m.papel = 'dono')
    end;
    foreach u in array coalesce(v_dest, '{}') loop
      insert into public.notificacao (escritorio_id, usuario_id, tipo, titulo, corpo, link)
      values (c.escritorio_id, u, 'atendimento_novo', 'Novo atendimento no WhatsApp',
              left(v_nome, 80) || ' — ' || v_rotulo || '. A recepcionista parou de responder: é com você.',
              '/app/atendimentos/' || v_at);
    end loop;
  end if;

  update public.whatsapp_mensagem set processada_em = now() where id = p_mensagem and direcao = 'entrada' and conversa_id = c.id;

  foreach v_txt in array coalesce(p_respostas, '{}') loop
    insert into public.whatsapp_mensagem (escritorio_id, conversa_id, direcao, autor, tipo, texto, status, criado_em)
    values (c.escritorio_id, c.id, 'saida', 'recepcao', 'texto', v_txt, 'pendente', clock_timestamp())
    returning id into v_id;
    v_saidas := v_saidas || jsonb_build_array(jsonb_build_object('id', v_id, 'texto', v_txt));
  end loop;

  return jsonb_build_object('atendimento_id', v_at, 'saidas', v_saidas,
    'notificados', to_jsonb(coalesce(v_dest, '{}'::uuid[])));
end;
$$;

create or replace function public.recepcao_marcar_processada(p_mensagem uuid)
returns void
language sql security definer
set search_path = ''
as $$ update public.whatsapp_mensagem set processada_em = now() where id = p_mensagem and direcao = 'entrada' and processada_em is null $$;

create or replace function public.recepcao_estado(p_conversa uuid)
returns jsonb
language sql stable security definer
set search_path = ''
as $$ select public._recepcao_estado(p_conversa) $$;

-- Resultado do envio à Meta.
create or replace function public.recepcao_saida_resultado(p_mensagem uuid, p_wamid text, p_ok boolean, p_erro text)
returns void
language sql security definer
set search_path = ''
as $$
  update public.whatsapp_mensagem
    set wamid = coalesce(p_wamid, wamid), status = case when p_ok then 'enviada' else 'falhou' end, erro = left(p_erro, 500)
    where id = p_mensagem and direcao = 'saida' and status = 'pendente';
$$;

-- Recibos de entrega/leitura da Meta. Só avança (enviada < entregue < lida); 'falhou' vale sempre.
create or replace function public.recepcao_status_webhook(p_wamid text, p_status text, p_erro text)
returns void
language sql security definer
set search_path = ''
as $$
  update public.whatsapp_mensagem m
    set status = p_status, erro = case when p_status = 'falhou' then left(p_erro, 500) else m.erro end
    where m.wamid = p_wamid and m.direcao = 'saida'
      and p_status in ('enviada','entregue','lida','falhou')
      and (p_status = 'falhou'
           or array_position(array['pendente','enviada','entregue','lida','falhou'], m.status)
              < array_position(array['pendente','enviada','entregue','lida','falhou'], p_status));
$$;

-- =====================================================================
-- Telas: atendimento (humano)
-- =====================================================================
create or replace function public._atendimento_exigir(p_id uuid)
returns public.atendimento
language plpgsql stable security definer
set search_path = ''
as $$
declare a public.atendimento;
begin
  select * into a from public.atendimento where id = p_id;
  if not found or not public.pode_ver(a.escritorio_id, 'atendimento') then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  return a;
end;
$$;

create or replace function public.atendimento_assumir(p_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare a public.atendimento := public._atendimento_exigir(p_id);
begin
  if a.status = 'encerrado' then raise exception 'atendimento_encerrado' using errcode = '22023'; end if;
  update public.atendimento set status = 'em_andamento', responsavel_id = auth.uid(), ultima_leitura_em = now() where id = p_id;
end;
$$;

create or replace function public.atendimento_marcar_lido(p_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare a public.atendimento := public._atendimento_exigir(p_id);
begin
  update public.atendimento set ultima_leitura_em = now() where id = p_id;
end;
$$;

-- Reserva a mensagem de saída do humano e diz COMO enviar: 'texto' (dentro das 24 h) ou 'modelo' (fora).
create or replace function public.atendimento_preparar_envio(p_id uuid, p_texto text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  a public.atendimento := public._atendimento_exigir(p_id);
  c public.whatsapp_conversa;
  g public.recepcao_config;
  v_aberta boolean;
  v_texto text := nullif(btrim(coalesce(p_texto, '')), '');
  v_modelo boolean;
  v_id uuid;
  v_esc text;
  v_num text;
begin
  if a.status = 'encerrado' then raise exception 'atendimento_encerrado' using errcode = '22023'; end if;
  select * into c from public.whatsapp_conversa where id = a.conversa_id;
  select * into g from public.recepcao_config where escritorio_id = a.escritorio_id;
  -- Só se fala com quem escreveu primeiro (sem disparo em massa).
  if not exists (select 1 from public.whatsapp_mensagem m where m.conversa_id = c.id and m.direcao = 'entrada') then
    raise exception 'sem_conversa_iniciada_pelo_contato' using errcode = '22023';
  end if;
  v_aberta := now() - c.ultima_entrada_em < interval '24 hours';
  v_modelo := v_texto is null;
  if v_texto is not null and not v_aberta then raise exception 'janela_24h_fechada' using errcode = '22023'; end if;
  if v_modelo and g.modelo_retomada is null then raise exception 'modelo_nao_configurado' using errcode = '22023'; end if;
  select nome into v_esc from public.escritorio where id = a.escritorio_id;
  select phone_number_id into v_num from public.whatsapp_numero where id = c.numero_id;

  insert into public.whatsapp_mensagem (escritorio_id, conversa_id, direcao, autor, usuario_id, tipo, texto, status, criado_em)
  values (a.escritorio_id, c.id, 'saida', 'humano', auth.uid(), case when v_modelo then 'modelo' else 'texto' end,
          case when v_modelo then 'Modelo de retomada "' || g.modelo_retomada || '" (a conversa estava fora da janela de 24 h)' else left(v_texto, 4096) end,
          'pendente', clock_timestamp())
  returning id into v_id;
  update public.atendimento set ultima_leitura_em = now(),
    status = case when status = 'aberto' then 'em_andamento' else status end,
    responsavel_id = coalesce(responsavel_id, auth.uid())
  where id = a.id;

  return jsonb_build_object('mensagem_id', v_id, 'modo', case when v_modelo then 'modelo' else 'texto' end,
    'telefone', c.telefone, 'phone_number_id', v_num, 'texto', v_texto,
    'modelo', g.modelo_retomada, 'idioma', g.modelo_idioma, 'escritorio_nome', v_esc);
end;
$$;

-- Resultado do envio de uma mensagem do humano (a tela chama com o login do usuário).
create or replace function public.atendimento_envio_resultado(p_mensagem uuid, p_wamid text, p_ok boolean, p_erro text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare m public.whatsapp_mensagem;
begin
  select * into m from public.whatsapp_mensagem where id = p_mensagem;
  if not found or m.autor <> 'humano' or m.usuario_id is distinct from auth.uid() then raise exception 'sem_permissao' using errcode = '42501'; end if;
  update public.whatsapp_mensagem set wamid = coalesce(p_wamid, wamid), status = case when p_ok then 'enviada' else 'falhou' end, erro = left(p_erro, 500)
    where id = p_mensagem and status = 'pendente';
end;
$$;

-- Encerrar devolve a conversa ao zero: a próxima mensagem do contato abre outra conversa e a recepcionista volta a atender.
create or replace function public.atendimento_encerrar(p_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare a public.atendimento := public._atendimento_exigir(p_id);
begin
  if a.status = 'encerrado' then return; end if;
  update public.atendimento set status = 'encerrado', encerrado_em = now(), encerrado_por = auth.uid() where id = p_id;
  update public.whatsapp_conversa set estado = 'encerrada', versao = versao + 1, atualizado_em = now() where id = a.conversa_id;
end;
$$;

-- =====================================================================
-- Privilégios
-- =====================================================================
revoke execute on function public.recepcao_receber(text, text, text, text, text, text, timestamptz),
  public.recepcao_aplicar(uuid, int, text, text, text, text, int, text[], boolean, uuid),
  public.recepcao_estado(uuid), public._recepcao_estado(uuid), public.recepcao_marcar_processada(uuid),
  public.recepcao_saida_resultado(uuid, text, boolean, text), public.recepcao_status_webhook(text, text, text)
from public, anon, authenticated;
grant execute on function public.recepcao_receber(text, text, text, text, text, text, timestamptz),
  public.recepcao_aplicar(uuid, int, text, text, text, text, int, text[], boolean, uuid),
  public.recepcao_estado(uuid), public._recepcao_estado(uuid), public.recepcao_marcar_processada(uuid),
  public.recepcao_saida_resultado(uuid, text, boolean, text), public.recepcao_status_webhook(text, text, text)
to service_role;

revoke execute on function public.recepcao_config_salvar(uuid, jsonb), public.whatsapp_numero_salvar(uuid, text, text, boolean),
  public._atendimento_exigir(uuid), public.atendimento_assumir(uuid), public.atendimento_marcar_lido(uuid),
  public.atendimento_preparar_envio(uuid, text), public.atendimento_envio_resultado(uuid, text, boolean, text),
  public.atendimento_encerrar(uuid), public.telefone_chave(text)
from public, anon, authenticated;
grant execute on function public.recepcao_config_salvar(uuid, jsonb), public.whatsapp_numero_salvar(uuid, text, text, boolean),
  public.atendimento_assumir(uuid), public.atendimento_marcar_lido(uuid),
  public.atendimento_preparar_envio(uuid, text), public.atendimento_envio_resultado(uuid, text, boolean, text),
  public.atendimento_encerrar(uuid), public.telefone_chave(text)
to authenticated, service_role;
