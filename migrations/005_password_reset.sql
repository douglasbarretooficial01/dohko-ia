-- Recuperação de senha

alter table users add column password_changed_at timestamptz;

create table password_resets (
  token_hash  text primary key,          -- sha256 do token; o token em si só vai no e-mail
  user_id     text not null references users(id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index password_resets_user on password_resets (user_id, created_at desc);
