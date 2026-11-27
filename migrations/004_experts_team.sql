-- Especialistas e equipes

create table experts (
  id            text primary key,
  workspace_id  text not null references workspaces(id) on delete cascade,
  created_by    text not null references users(id) on delete cascade,
  name          text not null,
  emoji         text not null default '🤖',
  description   text not null default '',
  instructions  text not null,
  model         text not null default 'auto',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index experts_ws on experts (workspace_id, updated_at desc);

-- arquivos da base de conhecimento reaproveitam a tabela de anexos
alter table attachments add column expert_id text references experts(id) on delete cascade;
create index attachments_expert on attachments (expert_id);

alter table conversations add column expert_id text references experts(id) on delete set null;

create table workspace_invites (
  token        text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  created_by   text not null references users(id) on delete cascade,
  role         text not null default 'member' check (role in ('owner','member')),
  expires_at   timestamptz not null,
  used_by      text references users(id),
  used_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index invites_ws on workspace_invites (workspace_id);
