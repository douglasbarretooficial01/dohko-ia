-- Publicação de apps, anexos e administração

alter table conversations
  add column published_slug    text unique,
  add column published_html    text,
  add column published_version int,
  add column published_at      timestamptz;

create table attachments (
  id              text primary key,
  workspace_id    text not null references workspaces(id) on delete cascade,
  user_id         text not null references users(id) on delete cascade,
  message_id      text references messages(id) on delete cascade,
  name            text not null,
  mime            text not null,
  kind            text not null check (kind in ('text','image')),
  size_bytes      int not null,
  text_content    text,          -- texto extraído (PDF, DOCX, CSV…)
  data            bytea,         -- imagem original
  truncated       boolean not null default false,
  created_at      timestamptz not null default now()
);
create index attachments_message on attachments (message_id);
