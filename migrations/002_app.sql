-- Dohko IA — contas, conversas e construtor

create table users (
  id            text primary key,
  name          text not null,
  email         text not null unique,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

create table memberships (
  user_id      text not null references users(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  role         text not null default 'owner',
  created_at   timestamptz not null default now(),
  primary key (user_id, workspace_id)
);

create table conversations (
  id            text primary key,
  workspace_id  text not null references workspaces(id) on delete cascade,
  user_id       text not null references users(id) on delete cascade,
  kind          text not null check (kind in ('chat','build')),
  title         text not null default 'Nova conversa',
  artifact_html text,                 -- construtor: versão atual do app
  artifact_version int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index conversations_user on conversations (user_id, updated_at desc);

create table messages (
  id              text primary key,
  conversation_id text not null references conversations(id) on delete cascade,
  role            text not null check (role in ('user','assistant')),
  content         text not null,
  model           text,
  credits         numeric(12,2),
  created_at      timestamptz not null default now()
);
create index messages_conv on messages (conversation_id, created_at);
