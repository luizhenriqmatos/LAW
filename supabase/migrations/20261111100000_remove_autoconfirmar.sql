-- P-094: remove o gatilho de teste que confirmava e-mail sozinho. A partir daqui o cadastro exige o link do e-mail.
drop trigger if exists law_autoconfirmar on auth.users;
drop function if exists public.law_autoconfirmar_email();
