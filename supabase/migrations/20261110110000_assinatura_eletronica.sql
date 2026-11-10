-- =====================================================================
-- Prompt 10: assinatura eletrônica AVANÇADA (Lei 14.063/2020, art. 4º, II), sem certificado ICP-Brasil.
-- NÃO é assinatura qualificada (art. 4º, III): a interface e o PDF dizem isso.
--
--  - O advogado sobe um PDF e cadastra os signatários. O banco calcula o SHA-256 do PDF original (quem manda é o banco,
--    não o navegador) e o arquivo fica CONGELADO: nenhuma regra permite trocar o conteúdo depois.
--  - Cada signatário recebe um link com token aleatório de 32 bytes (só o SHA-256 vai para o banco), válido por 7 dias.
--    Ordem opcional: quem tem ordem maior só recebe o link depois que todos de ordem menor assinaram.
--  - Para assinar o signatário precisa ter VISUALIZADO o documento (o servidor entrega o PDF e o banco registra),
--    informar um CPF com dígitos verificadores válidos e marcar o aceite. O texto do aceite é do banco, não do navegador.
--  - Evidências: tabela APPEND-ONLY. Ninguém (nem service_role) tem UPDATE, DELETE ou TRUNCATE por permissão, e gatilhos
--    barram o dono da tabela também. Cada evidência traz o hash da anterior (cadeia): mexer em uma linha quebra a cadeia.
--  - Retenção de 5 anos: as tabelas NÃO têm chave estrangeira para escritório, processo ou usuário (apagar a conta não
--    apaga o documento) e gatilhos recusam DELETE antes de `retencao_ate`.
--  - Verificação pública: quem tem o PDF final confere o SHA-256 contra o hash registrado (só o servidor consulta).
-- =====================================================================

-- Novo módulo (tela) "assinaturas". Manter igual a src/lib/modulos.ts.
create or replace function public.modulos_validos()
returns text[]
language sql immutable
set search_path = ''
as $$
  select array['agenda','processos','prazos','tarefas','financeiro','calculos','documentos','portal_cliente','assinaturas','configuracoes']::text[]
$$;

-- CPF: 11 dígitos, não todos iguais, dígitos verificadores corretos.
create or replace function public.cpf_valido(cpf text)
returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  k int; i int; s int; r int;
begin
  if cpf is null or cpf !~ '^[0-9]{11}$' then return false; end if;
  if cpf ~ '^(.)\1{10}$' then return false; end if;
  for k in 1..2 loop
    s := 0;
    for i in 1..(8 + k) loop
      s := s + substr(cpf, i, 1)::int * (10 + k - i);
    end loop;
    r := (s * 10) % 11;
    if r = 10 then r := 0; end if;
    if r <> substr(cpf, 9 + k, 1)::int then return false; end if;
  end loop;
  return true;
end;
$$;

-- ---------------------------------------------------------------------
-- Tabelas (sem FK para escritório/processo/usuário: a retenção de 5 anos vale mesmo se a conta for apagada)
-- ---------------------------------------------------------------------
create table public.assinatura_envelope (
  id uuid primary key default gen_random_uuid(),
  escritorio_id uuid not null,
  escritorio_nome text not null,
  processo_id uuid null,
  titulo text not null check (char_length(btrim(titulo)) between 3 and 200),
  nome_arquivo text not null check (char_length(nome_arquivo) between 1 and 200),
  tamanho bigint not null check (tamanho > 0),
  hash_original text not null check (hash_original ~ '^[0-9a-f]{64}$'),
  hash_final text null check (hash_final is null or hash_final ~ '^[0-9a-f]{64}$'),
  status text not null default 'enviado' check (status in ('enviado','assinado','concluido','cancelado')),
  criado_por uuid null,
  criado_em timestamptz not null default now(),
  concluido_em timestamptz null,
  cancelado_em timestamptz null,
  retencao_ate date not null default ((current_date + interval '5 years')::date),
  check ((status = 'concluido') = (hash_final is not null))
);
create index assinatura_envelope_escritorio_idx on public.assinatura_envelope (escritorio_id, criado_em desc);
create index assinatura_envelope_hash_original_idx on public.assinatura_envelope (hash_original);
create index assinatura_envelope_hash_final_idx on public.assinatura_envelope (hash_final) where hash_final is not null;

create table public.assinatura_arquivo (
  envelope_id uuid primary key references public.assinatura_envelope(id) on delete restrict,
  original bytea not null check (octet_length(original) between 100 and 5242880),
  final bytea null check (final is null or octet_length(final) between 100 and 10485760)
);

create table public.assinatura_signatario (
  id uuid primary key default gen_random_uuid(),
  envelope_id uuid not null references public.assinatura_envelope(id) on delete restrict,
  escritorio_id uuid not null,
  ordem int not null default 1 check (ordem between 1 and 20),
  nome text not null check (char_length(btrim(nome)) between 2 and 120),
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  status text not null default 'pendente' check (status in ('pendente','assinado')),
  token_hash text null unique check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  token_expira_em timestamptz null,
  link_enviado_em timestamptz null,
  cpf text null check (cpf is null or public.cpf_valido(cpf)),
  aceite_texto text null,
  assinado_em timestamptz null,
  ip inet null,
  user_agent text null,
  unique (envelope_id, email),
  check ((status = 'assinado') = (assinado_em is not null and cpf is not null and aceite_texto is not null))
);
create index assinatura_signatario_envelope_idx on public.assinatura_signatario (envelope_id, ordem);

create table public.assinatura_evidencia (
  id bigint generated always as identity primary key,
  envelope_id uuid not null references public.assinatura_envelope(id) on delete restrict,
  signatario_id uuid null references public.assinatura_signatario(id) on delete restrict,
  escritorio_id uuid not null,
  tipo text not null check (tipo in ('envelope_criado','envio_email','abertura_link','visualizacao','aceite','assinatura','conclusao_envelope','envelope_cancelado')),
  ip inet null,
  user_agent text null,
  dados jsonb not null default '{}'::jsonb,
  hash_anterior text null,
  hash text not null default '',
  criado_em timestamptz not null default clock_timestamp()
);
create index assinatura_evidencia_envelope_idx on public.assinatura_evidencia (envelope_id, id);

-- ---------------------------------------------------------------------
-- Gatilhos de proteção (valem para QUALQUER papel, inclusive o dono das tabelas)
-- ---------------------------------------------------------------------
create or replace function public._assinatura_evidencia_imutavel()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'evidencia_imutavel' using errcode = '42501';
end;
$$;
create trigger assinatura_evidencia_sem_update before update or delete on public.assinatura_evidencia
  for each row execute function public._assinatura_evidencia_imutavel();
create trigger assinatura_evidencia_sem_truncate before truncate on public.assinatura_evidencia
  for each statement execute function public._assinatura_evidencia_imutavel();

-- Cadeia: cada evidência guarda o hash da anterior do mesmo envelope.
create or replace function public._assinatura_hash_evidencia(p_ant text, p_env uuid, p_sig uuid, p_tipo text, p_ip inet, p_ua text, p_dados jsonb, p_quando timestamptz)
returns text
language sql immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(concat_ws('|', coalesce(p_ant, ''), p_env::text, coalesce(p_sig::text, ''), p_tipo,
    coalesce(host(p_ip), ''), coalesce(p_ua, ''), p_dados::text, to_char(p_quando at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')), 'UTF8')), 'hex')
$$;

create or replace function public._assinatura_evidencia_encadear()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_ant text;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.envelope_id::text, 0));
  select e.hash into v_ant from public.assinatura_evidencia e where e.envelope_id = new.envelope_id order by e.id desc limit 1;
  new.criado_em := clock_timestamp();
  new.hash_anterior := v_ant;
  new.hash := public._assinatura_hash_evidencia(v_ant, new.envelope_id, new.signatario_id, new.tipo, new.ip, new.user_agent, new.dados, new.criado_em);
  return new;
end;
$$;
create trigger assinatura_evidencia_cadeia before insert on public.assinatura_evidencia
  for each row execute function public._assinatura_evidencia_encadear();

-- Envelope: campos do documento nunca mudam; o status só anda para frente.
create or replace function public._assinatura_envelope_protege()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.retencao_ate >= current_date then raise exception 'retencao_5_anos' using errcode = '42501'; end if;
    return old;
  end if;
  if old.status in ('concluido','cancelado') then raise exception 'envelope_encerrado' using errcode = '42501'; end if;
  if new.id <> old.id or new.escritorio_id <> old.escritorio_id or new.processo_id is distinct from old.processo_id
     or new.titulo <> old.titulo or new.nome_arquivo <> old.nome_arquivo or new.tamanho <> old.tamanho
     or new.hash_original <> old.hash_original or new.criado_em <> old.criado_em or new.criado_por is distinct from old.criado_por then
    raise exception 'envelope_congelado' using errcode = '42501';
  end if;
  if new.status <> old.status and not (
       (old.status = 'enviado' and new.status in ('assinado','cancelado')) or (old.status = 'assinado' and new.status = 'concluido')) then
    raise exception 'status_invalido' using errcode = '22023';
  end if;
  if new.retencao_ate < old.retencao_ate then raise exception 'retencao_5_anos' using errcode = '42501'; end if;
  return new;
end;
$$;
create trigger assinatura_envelope_protege before update or delete on public.assinatura_envelope
  for each row execute function public._assinatura_envelope_protege();

-- Arquivo: o original nunca muda; o final entra uma vez só.
create or replace function public._assinatura_arquivo_protege()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.assinatura_envelope e where e.id = old.envelope_id and e.retencao_ate >= current_date) then
      raise exception 'retencao_5_anos' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.envelope_id <> old.envelope_id or new.original <> old.original then raise exception 'envelope_congelado' using errcode = '42501'; end if;
  if old.final is not null and new.final is distinct from old.final then raise exception 'envelope_congelado' using errcode = '42501'; end if;
  return new;
end;
$$;
create trigger assinatura_arquivo_protege before update or delete on public.assinatura_arquivo
  for each row execute function public._assinatura_arquivo_protege();

-- Signatário: quem já assinou não muda mais; nome, e-mail e ordem nunca mudam.
create or replace function public._assinatura_signatario_protege()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.assinatura_envelope e where e.id = old.envelope_id and e.retencao_ate >= current_date) then
      raise exception 'retencao_5_anos' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.status = 'assinado' then raise exception 'ja_assinado' using errcode = '42501'; end if;
  if new.id <> old.id or new.envelope_id <> old.envelope_id or new.nome <> old.nome or new.email <> old.email or new.ordem <> old.ordem then
    raise exception 'signatario_congelado' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger assinatura_signatario_protege before update or delete on public.assinatura_signatario
  for each row execute function public._assinatura_signatario_protege();

create trigger auditoria_assinatura_envelope after insert or update on public.assinatura_envelope
  for each row execute function public.registrar_auditoria();

-- ---------------------------------------------------------------------
-- Permissões por papel e RLS. Escrita: só pelas funções abaixo.
-- ---------------------------------------------------------------------
revoke all on public.assinatura_envelope, public.assinatura_arquivo, public.assinatura_signatario, public.assinatura_evidencia
  from public, anon, authenticated, service_role;
grant select on public.assinatura_envelope, public.assinatura_evidencia to authenticated;
-- O app nunca lê o hash do token nem o conteúdo do PDF por tabela.
grant select (id, envelope_id, escritorio_id, ordem, nome, email, status, token_expira_em, link_enviado_em, cpf, aceite_texto, assinado_em, ip, user_agent)
  on public.assinatura_signatario to authenticated;

alter table public.assinatura_envelope enable row level security;
alter table public.assinatura_arquivo enable row level security;
alter table public.assinatura_signatario enable row level security;
alter table public.assinatura_evidencia enable row level security;

create policy assinatura_envelope_ler on public.assinatura_envelope for select to authenticated
  using (public.pode_ver(escritorio_id, 'assinaturas'));
create policy assinatura_signatario_ler on public.assinatura_signatario for select to authenticated
  using (public.pode_ver(escritorio_id, 'assinaturas'));
create policy assinatura_evidencia_ler on public.assinatura_evidencia for select to authenticated
  using (public.pode_ver(escritorio_id, 'assinaturas'));

-- ---------------------------------------------------------------------
-- Funções internas
-- ---------------------------------------------------------------------
create or replace function public._exigir_assinaturas(p_escritorio uuid)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'nao_autenticado' using errcode = '28000'; end if;
  if not public.pode_ver(p_escritorio, 'assinaturas') then raise exception 'sem_permissao' using errcode = '42501'; end if;
end;
$$;

create or replace function public._assinatura_registrar(p_env uuid, p_sig uuid, p_tipo text, p_ip inet, p_ua text, p_dados jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.assinatura_evidencia (envelope_id, signatario_id, escritorio_id, tipo, ip, user_agent, dados)
  select e.id, p_sig, e.escritorio_id, p_tipo, p_ip, left(p_ua, 500), coalesce(p_dados, '{}'::jsonb)
  from public.assinatura_envelope e where e.id = p_env;
end;
$$;

-- Texto do aceite: fica no banco para o navegador não poder trocá-lo.
create or replace function public.assinatura_texto_aceite()
returns text
language sql immutable
set search_path = ''
as $$
  select 'Li o documento e concordo com o seu conteúdo. Declaro que o CPF informado é o meu e que assino por meio de assinatura eletrônica avançada (Lei 14.063/2020, art. 4º, II), e não por assinatura qualificada com certificado ICP-Brasil.'::text
$$;

-- É a vez deste signatário? (todos de ordem menor já assinaram)
create or replace function public._assinatura_vez(p_sig uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.assinatura_signatario s
    where s.id = p_sig and s.status = 'pendente'
      and not exists (
        select 1 from public.assinatura_signatario o
        where o.envelope_id = s.envelope_id and o.ordem < s.ordem and o.status <> 'assinado'
      )
  )
$$;

create or replace function public._assinatura_emitir(p_sig uuid, p_token_hash text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  s public.assinatura_signatario;
  e public.assinatura_envelope;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'token_invalido' using errcode = '22023'; end if;
  select * into s from public.assinatura_signatario where id = p_sig for update;
  if not found then raise exception 'signatario_invalido' using errcode = '22023'; end if;
  select * into e from public.assinatura_envelope where id = s.envelope_id;
  if e.status <> 'enviado' then raise exception 'envelope_encerrado' using errcode = '22023'; end if;
  if s.status <> 'pendente' then raise exception 'ja_assinou' using errcode = '22023'; end if;
  if not public._assinatura_vez(s.id) then raise exception 'fora_da_vez' using errcode = '22023'; end if;
  update public.assinatura_signatario
     set token_hash = p_token_hash, token_expira_em = now() + interval '7 days', link_enviado_em = now()
   where id = s.id;
  return jsonb_build_object('nome', s.nome, 'email', s.email, 'titulo', e.titulo, 'escritorio', e.escritorio_nome,
                            'expira_em', now() + interval '7 days');
end;
$$;

-- ---------------------------------------------------------------------
-- Telas do advogado
-- ---------------------------------------------------------------------
create or replace function public.assinatura_criar(
  p_escritorio uuid, p_titulo text, p_nome_arquivo text, p_pdf bytea, p_processo uuid, p_signatarios jsonb
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_hash text;
  v_nome text;
  v_menor int;
  v_n int;
  v_distintos int;
  v_saida jsonb;
begin
  perform public._exigir_assinaturas(p_escritorio);
  if p_pdf is null or octet_length(p_pdf) < 100 or octet_length(p_pdf) > 5242880 or substring(p_pdf from 1 for 5) <> '\x255044462d'::bytea then
    raise exception 'pdf_invalido' using errcode = '22023';
  end if;
  if p_signatarios is null or jsonb_typeof(p_signatarios) <> 'array' or jsonb_array_length(p_signatarios) not between 1 and 20 then
    raise exception 'signatarios_invalidos' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_signatarios) x
    where jsonb_typeof(x) <> 'object' or char_length(btrim(coalesce(x->>'nome', ''))) < 2
       or lower(btrim(coalesce(x->>'email', ''))) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
       or (x ? 'ordem' and (x->>'ordem') !~ '^[0-9]{1,2}$')
  ) then
    raise exception 'signatarios_invalidos' using errcode = '22023';
  end if;
  select count(*), count(distinct lower(btrim(x->>'email'))) into v_n, v_distintos from jsonb_array_elements(p_signatarios) x;
  if v_n <> v_distintos then raise exception 'signatarios_invalidos' using errcode = '22023'; end if;
  if p_processo is not null and not exists (select 1 from public.processo p where p.id = p_processo and p.escritorio_id = p_escritorio) then
    raise exception 'processo_invalido' using errcode = '22023';
  end if;

  select e.nome into v_nome from public.escritorio e where e.id = p_escritorio;
  v_hash := encode(sha256(p_pdf), 'hex');
  insert into public.assinatura_envelope (escritorio_id, escritorio_nome, processo_id, titulo, nome_arquivo, tamanho, hash_original, criado_por)
  values (p_escritorio, v_nome, p_processo, btrim(p_titulo), left(btrim(p_nome_arquivo), 200), octet_length(p_pdf), v_hash, auth.uid())
  returning id into v_id;
  insert into public.assinatura_arquivo (envelope_id, original) values (v_id, p_pdf);
  insert into public.assinatura_signatario (envelope_id, escritorio_id, ordem, nome, email)
  select v_id, p_escritorio, coalesce((x->>'ordem')::int, 1), btrim(x->>'nome'), lower(btrim(x->>'email'))
  from jsonb_array_elements(p_signatarios) x;

  perform public._assinatura_registrar(v_id, null, 'envelope_criado', null, null,
    jsonb_build_object('hash_original', v_hash, 'titulo', btrim(p_titulo), 'tamanho', octet_length(p_pdf), 'signatarios', v_n, 'criado_por', auth.uid()));

  select min(ordem) into v_menor from public.assinatura_signatario where envelope_id = v_id;
  select jsonb_build_object('id', v_id, 'hash_original', v_hash, 'signatarios', jsonb_agg(
           jsonb_build_object('id', s.id, 'nome', s.nome, 'email', s.email, 'ordem', s.ordem, 'vez', s.ordem = v_menor) order by s.ordem, s.nome))
    into v_saida from public.assinatura_signatario s where s.envelope_id = v_id;
  return v_saida;
end;
$$;

create or replace function public.assinatura_emitir_link(p_signatario uuid, p_token_hash text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_esc uuid;
begin
  select s.escritorio_id into v_esc from public.assinatura_signatario s where s.id = p_signatario;
  if v_esc is null then raise exception 'signatario_invalido' using errcode = '22023'; end if;
  perform public._exigir_assinaturas(v_esc);
  return public._assinatura_emitir(p_signatario, p_token_hash);
end;
$$;

create or replace function public.assinatura_cancelar(p_envelope uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  e public.assinatura_envelope;
begin
  select * into e from public.assinatura_envelope where id = p_envelope for update;
  if not found then raise exception 'envelope_invalido' using errcode = '22023'; end if;
  perform public._exigir_assinaturas(e.escritorio_id);
  if e.status <> 'enviado' then raise exception 'envelope_encerrado' using errcode = '22023'; end if;
  update public.assinatura_envelope
     set status = 'cancelado', cancelado_em = now(), retencao_ate = greatest(retencao_ate, (current_date + interval '5 years')::date)
   where id = e.id;
  perform public._assinatura_registrar(e.id, null, 'envelope_cancelado', null, null, jsonb_build_object('cancelado_por', auth.uid()));
end;
$$;

-- Baixar o PDF (original ou, depois de concluído, o final).
create or replace function public.assinatura_baixar(p_envelope uuid, p_qual text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  e public.assinatura_envelope;
  a public.assinatura_arquivo;
begin
  select * into e from public.assinatura_envelope where id = p_envelope;
  if not found then raise exception 'envelope_invalido' using errcode = '22023'; end if;
  perform public._exigir_assinaturas(e.escritorio_id);
  select * into a from public.assinatura_arquivo where envelope_id = e.id;
  if p_qual = 'final' then
    if a.final is null then return jsonb_build_object('ok', false); end if;
    return jsonb_build_object('ok', true, 'nome_arquivo', e.nome_arquivo, 'pdf', a.final);
  elsif p_qual = 'original' then
    return jsonb_build_object('ok', true, 'nome_arquivo', e.nome_arquivo, 'pdf', a.original);
  end if;
  raise exception 'pedido_invalido' using errcode = '22023';
end;
$$;

-- Pasta do processo no Drive, para escolher o PDF de lá.
create or replace function public.assinatura_pasta_processo(p_processo uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_esc uuid;
  v_drive text;
begin
  select p.escritorio_id into v_esc from public.processo p where p.id = p_processo;
  if v_esc is null then raise exception 'processo_invalido' using errcode = '22023'; end if;
  perform public._exigir_assinaturas(v_esc);
  select d.drive_id into v_drive from public.drive_pasta d where d.tipo = 'processo' and d.ref_id = p_processo and d.status = 'ativa';
  if v_drive is null then return null; end if;
  return jsonb_build_object('escritorio_id', v_esc, 'drive_id', v_drive);
end;
$$;

-- Processos do escritório para o formulário (quem só tem "Assinaturas" não abre a tabela de processos).
create or replace function public.assinatura_processos(p_escritorio uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform public._exigir_assinaturas(p_escritorio);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'numero_cnj', p.numero_cnj) order by p.numero_cnj)
    from (select id, numero_cnj from public.processo where escritorio_id = p_escritorio and status = 'confirmado' order by numero_cnj limit 2000) p
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------
-- Servidor (service_role): fluxo público do signatário e verificação
-- ---------------------------------------------------------------------
create or replace function public.assinatura_emitir_link_servico(p_signatario uuid, p_token_hash text)
returns jsonb
language sql security definer
set search_path = ''
as $$ select public._assinatura_emitir(p_signatario, p_token_hash) $$;

create or replace function public.assinatura_registrar_envio(p_signatario uuid, p_enviado boolean, p_motivo text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  s public.assinatura_signatario;
begin
  select * into s from public.assinatura_signatario where id = p_signatario;
  if not found then raise exception 'signatario_invalido' using errcode = '22023'; end if;
  perform public._assinatura_registrar(s.envelope_id, s.id, 'envio_email', null, null,
    jsonb_build_object('email', s.email, 'enviado', p_enviado, 'motivo', left(p_motivo, 300)));
end;
$$;

-- Abre o link: confere o token e registra a abertura.
create or replace function public.assinatura_abrir(p_token_hash text, p_ip inet, p_user_agent text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  s public.assinatura_signatario;
  e public.assinatura_envelope;
  v_motivo text;
begin
  select * into s from public.assinatura_signatario where token_hash = p_token_hash;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'invalido'); end if;
  select * into e from public.assinatura_envelope where id = s.envelope_id;
  v_motivo := case
    when e.status = 'cancelado' then 'cancelado'
    when s.status = 'assinado' then 'assinado'
    when s.token_expira_em is null or s.token_expira_em <= now() then 'expirado'
    else null end;
  perform public._assinatura_registrar(e.id, s.id, 'abertura_link', p_ip, p_user_agent, jsonb_build_object('resultado', coalesce(v_motivo, 'ok')));
  if v_motivo is not null then return jsonb_build_object('ok', false, 'motivo', v_motivo); end if;
  return jsonb_build_object(
    'ok', true,
    'signatario', jsonb_build_object('id', s.id, 'nome', s.nome, 'email', s.email),
    'envelope', jsonb_build_object('id', e.id, 'titulo', e.titulo, 'nome_arquivo', e.nome_arquivo, 'tamanho', e.tamanho,
                                   'hash_original', e.hash_original, 'escritorio_nome', e.escritorio_nome),
    'ja_visualizou', exists (select 1 from public.assinatura_evidencia v where v.signatario_id = s.id and v.tipo = 'visualizacao'),
    'aceite_texto', public.assinatura_texto_aceite(),
    'expira_em', s.token_expira_em
  );
end;
$$;

-- Entrega o PDF para leitura e registra a visualização.
create or replace function public.assinatura_documento_para_assinar(p_token_hash text, p_ip inet, p_user_agent text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  s public.assinatura_signatario;
  e public.assinatura_envelope;
  a public.assinatura_arquivo;
begin
  select * into s from public.assinatura_signatario where token_hash = p_token_hash;
  if not found then return jsonb_build_object('ok', false); end if;
  select * into e from public.assinatura_envelope where id = s.envelope_id;
  if e.status = 'cancelado' or s.status = 'assinado' or s.token_expira_em is null or s.token_expira_em <= now() then
    return jsonb_build_object('ok', false);
  end if;
  select * into a from public.assinatura_arquivo where envelope_id = e.id;
  perform public._assinatura_registrar(e.id, s.id, 'visualizacao', p_ip, p_user_agent, jsonb_build_object('hash_original', e.hash_original));
  return jsonb_build_object('ok', true, 'nome_arquivo', e.nome_arquivo, 'pdf', a.original);
end;
$$;

-- Assina. Devolve motivo (sem gravar nada) quando algo está errado.
create or replace function public.assinatura_assinar(p_token_hash text, p_cpf text, p_aceite boolean, p_ip inet, p_user_agent text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_env uuid;
  s public.assinatura_signatario;
  e public.assinatura_envelope;
  v_cpf text := regexp_replace(coalesce(p_cpf, ''), '[^0-9]', '', 'g');
  v_aceite text := public.assinatura_texto_aceite();
  v_faltam int;
  v_liberados jsonb;
begin
  select envelope_id into v_env from public.assinatura_signatario where token_hash = p_token_hash;
  if v_env is null then return jsonb_build_object('ok', false, 'motivo', 'invalido'); end if;
  -- Trava o envelope: duas últimas assinaturas ao mesmo tempo se enfileiram.
  select * into e from public.assinatura_envelope where id = v_env for update;
  select * into s from public.assinatura_signatario where token_hash = p_token_hash for update;
  if e.status = 'cancelado' then return jsonb_build_object('ok', false, 'motivo', 'cancelado'); end if;
  if s.status = 'assinado' then return jsonb_build_object('ok', false, 'motivo', 'assinado'); end if;
  if e.status <> 'enviado' then return jsonb_build_object('ok', false, 'motivo', 'cancelado'); end if;
  if s.token_expira_em is null or s.token_expira_em <= now() then return jsonb_build_object('ok', false, 'motivo', 'expirado'); end if;
  if not public._assinatura_vez(s.id) then return jsonb_build_object('ok', false, 'motivo', 'aguardando_vez'); end if;
  if not public.cpf_valido(v_cpf) then return jsonb_build_object('ok', false, 'motivo', 'cpf_invalido'); end if;
  if p_aceite is distinct from true then return jsonb_build_object('ok', false, 'motivo', 'aceite_obrigatorio'); end if;
  if not exists (select 1 from public.assinatura_evidencia v where v.signatario_id = s.id and v.tipo = 'visualizacao') then
    return jsonb_build_object('ok', false, 'motivo', 'nao_visualizou');
  end if;

  perform public._assinatura_registrar(e.id, s.id, 'aceite', p_ip, p_user_agent, jsonb_build_object('aceite_texto', v_aceite, 'hash_original', e.hash_original));
  update public.assinatura_signatario
     set status = 'assinado', cpf = v_cpf, aceite_texto = v_aceite, assinado_em = now(), ip = p_ip, user_agent = left(p_user_agent, 500)
   where id = s.id;
  perform public._assinatura_registrar(e.id, s.id, 'assinatura', p_ip, p_user_agent,
    jsonb_build_object('nome', s.nome, 'email', s.email,
                       'cpf_final', right(v_cpf, 2), 'hash_original', e.hash_original));

  select count(*) into v_faltam from public.assinatura_signatario where envelope_id = e.id and status <> 'assinado';
  if v_faltam = 0 then
    update public.assinatura_envelope set status = 'assinado' where id = e.id;
    return jsonb_build_object('ok', true, 'todos', true, 'envelope_id', e.id, 'liberados', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'nome', x.nome, 'email', x.email) order by x.nome), '[]'::jsonb)
    into v_liberados
    from public.assinatura_signatario x
   where x.envelope_id = e.id and x.status = 'pendente' and x.token_hash is null and public._assinatura_vez(x.id);
  return jsonb_build_object('ok', true, 'todos', false, 'envelope_id', e.id, 'liberados', v_liberados);
end;
$$;

-- Dados para montar o PDF final.
create or replace function public.assinatura_dados_finais(p_envelope uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  e public.assinatura_envelope;
  a public.assinatura_arquivo;
begin
  select * into e from public.assinatura_envelope where id = p_envelope;
  if not found or e.status <> 'assinado' then return jsonb_build_object('ok', false); end if;
  select * into a from public.assinatura_arquivo where envelope_id = e.id;
  return jsonb_build_object(
    'ok', true, 'titulo', e.titulo, 'nome_arquivo', e.nome_arquivo, 'hash_original', e.hash_original,
    'escritorio_nome', e.escritorio_nome, 'criado_em', e.criado_em, 'original', a.original,
    'signatarios', (
      select jsonb_agg(jsonb_build_object('ordem', s.ordem, 'nome', s.nome, 'email', s.email, 'cpf', s.cpf, 'assinado_em', s.assinado_em,
                                          'ip', host(s.ip), 'user_agent', s.user_agent) order by s.assinado_em, s.nome)
      from public.assinatura_signatario s where s.envelope_id = e.id)
  );
end;
$$;

-- Guarda o PDF final. O hash é calculado AQUI, sobre os bytes guardados.
create or replace function public.assinatura_concluir(p_envelope uuid, p_pdf_final bytea)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  e public.assinatura_envelope;
  v_hash text;
begin
  select * into e from public.assinatura_envelope where id = p_envelope for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'invalido'); end if;
  if e.status = 'concluido' then return jsonb_build_object('ok', true, 'hash_final', e.hash_final, 'ja_concluido', true); end if;
  if e.status <> 'assinado' then return jsonb_build_object('ok', false, 'motivo', 'faltam_assinaturas'); end if;
  if p_pdf_final is null or octet_length(p_pdf_final) < 100 or octet_length(p_pdf_final) > 10485760
     or substring(p_pdf_final from 1 for 5) <> '\x255044462d'::bytea then
    return jsonb_build_object('ok', false, 'motivo', 'pdf_invalido');
  end if;
  v_hash := encode(sha256(p_pdf_final), 'hex');
  update public.assinatura_arquivo set final = p_pdf_final where envelope_id = e.id;
  update public.assinatura_envelope
     set status = 'concluido', hash_final = v_hash, concluido_em = now(), retencao_ate = greatest(retencao_ate, (current_date + interval '5 years')::date)
   where id = e.id;
  perform public._assinatura_registrar(e.id, null, 'conclusao_envelope', null, null,
    jsonb_build_object('hash_original', e.hash_original, 'hash_final', v_hash, 'tamanho_final', octet_length(p_pdf_final)));
  return jsonb_build_object('ok', true, 'hash_final', v_hash);
end;
$$;

create or replace function public.assinatura_pendentes_finalizacao(p_limite int)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(x.id), '[]'::jsonb)
  from (select id from public.assinatura_envelope where status = 'assinado' order by criado_em limit greatest(1, least(coalesce(p_limite, 20), 100))) x
$$;

-- Verificação pública: o servidor manda o SHA-256 do arquivo enviado.
create or replace function public.assinatura_verificar(p_hash text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  e public.assinatura_envelope;
  v_tipo text;
begin
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('encontrado', false); end if;
  select * into e from public.assinatura_envelope where hash_final = p_hash limit 1;
  if found then v_tipo := 'final';
  else
    select * into e from public.assinatura_envelope where hash_original = p_hash order by criado_em limit 1;
    if not found then return jsonb_build_object('encontrado', false); end if;
    v_tipo := 'original';
  end if;
  return jsonb_build_object(
    'encontrado', true, 'tipo', v_tipo, 'status', e.status, 'titulo', e.titulo, 'escritorio_nome', e.escritorio_nome,
    'criado_em', e.criado_em, 'concluido_em', e.concluido_em, 'hash_original', e.hash_original, 'hash_final', e.hash_final,
    'signatarios', (
      select coalesce(jsonb_agg(jsonb_build_object('nome', s.nome, 'assinado_em', s.assinado_em,
               'cpf', case when s.cpf is null then null else '***.' || substr(s.cpf, 4, 3) || '.' || substr(s.cpf, 7, 3) || '-**' end) order by s.ordem, s.nome), '[]'::jsonb)
      from public.assinatura_signatario s where s.envelope_id = e.id)
  );
end;
$$;

-- Confere a cadeia de evidências de um envelope.
create or replace function public.assinatura_verificar_cadeia(p_envelope uuid)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  r public.assinatura_evidencia;
  v_ant text := null;
  v_n int := 0;
begin
  for r in select * from public.assinatura_evidencia where envelope_id = p_envelope order by id loop
    if r.hash_anterior is distinct from v_ant then return false; end if;
    if r.hash <> public._assinatura_hash_evidencia(r.hash_anterior, r.envelope_id, r.signatario_id, r.tipo, r.ip, r.user_agent, r.dados, r.criado_em) then
      return false;
    end if;
    v_ant := r.hash;
    v_n := v_n + 1;
  end loop;
  return v_n > 0;
end;
$$;

-- ---------------------------------------------------------------------
-- Quem pode executar o quê
-- ---------------------------------------------------------------------
revoke execute on function public.cpf_valido(text) from public, anon;
revoke execute on function public.assinatura_texto_aceite() from public, anon;
-- Só o servidor (service_role):
revoke execute on function public.assinatura_emitir_link_servico(uuid, text) from public, anon, authenticated;
revoke execute on function public.assinatura_registrar_envio(uuid, boolean, text) from public, anon, authenticated;
revoke execute on function public.assinatura_abrir(text, inet, text) from public, anon, authenticated;
revoke execute on function public.assinatura_documento_para_assinar(text, inet, text) from public, anon, authenticated;
revoke execute on function public.assinatura_assinar(text, text, boolean, inet, text) from public, anon, authenticated;
revoke execute on function public.assinatura_dados_finais(uuid) from public, anon, authenticated;
revoke execute on function public.assinatura_concluir(uuid, bytea) from public, anon, authenticated;
revoke execute on function public.assinatura_pendentes_finalizacao(int) from public, anon, authenticated;
revoke execute on function public.assinatura_verificar(text) from public, anon, authenticated;
revoke execute on function public.assinatura_verificar_cadeia(uuid) from public, anon, authenticated;
revoke execute on function public._assinatura_registrar(uuid, uuid, text, inet, text, jsonb) from public, anon, authenticated;
revoke execute on function public._assinatura_emitir(uuid, text) from public, anon, authenticated;
revoke execute on function public._assinatura_vez(uuid) from public, anon, authenticated;
revoke execute on function public._assinatura_hash_evidencia(text, uuid, uuid, text, inet, text, jsonb, timestamptz) from public, anon, authenticated;
-- Usuário logado (cada função confere a permissão por dentro):
revoke execute on function public._exigir_assinaturas(uuid) from public, anon;
revoke execute on function public.assinatura_criar(uuid, text, text, bytea, uuid, jsonb) from public, anon;
revoke execute on function public.assinatura_emitir_link(uuid, text) from public, anon;
revoke execute on function public.assinatura_cancelar(uuid) from public, anon;
revoke execute on function public.assinatura_baixar(uuid, text) from public, anon;
revoke execute on function public.assinatura_pasta_processo(uuid) from public, anon;
revoke execute on function public.assinatura_processos(uuid) from public, anon;
