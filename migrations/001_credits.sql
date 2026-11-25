-- Dohko IA — créditos
-- O saldo é a soma dos buckets; o ledger é append-only e precisa fechar com eles.

create table workspaces (
  id                 text primary key,
  name               text not null,
  plan_id            text not null default 'free',
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  created_at         timestamptz not null default now()
);

create type grant_kind  as enum ('daily_chat','daily_build','plan','topup','bonus');
create type ledger_type as enum ('grant','debit','hold','release','expire','writeoff');

create table credit_buckets (
  id           uuid primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  kind         grant_kind not null,
  balance      numeric(12,2) not null check (balance >= 0),
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);
create index credit_buckets_live on credit_buckets (workspace_id, expires_at) where balance > 0;

create table credit_ledger (
  id           uuid primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  bucket_id    uuid references credit_buckets(id),
  type         ledger_type not null,
  amount       numeric(12,2) not null,
  action_id    text,
  meta         jsonb,
  created_at   timestamptz not null default now()
);
create index credit_ledger_ws on credit_ledger (workspace_id, created_at desc);
create index credit_ledger_action on credit_ledger (action_id);

create table credit_holds (
  action_id    text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  mode         text not null,
  movements    jsonb not null,
  total        numeric(12,2) not null,
  created_at   timestamptz not null default now()
);

create table idempotency_keys (
  key        text primary key,
  created_at timestamptz not null default now()
);

create table action_usage (
  action_id      text primary key,
  workspace_id   text not null references workspaces(id) on delete cascade,
  mode           text not null,
  task_type      text,
  input_tokens   int not null,
  output_tokens  int not null,
  cached_tokens  int not null default 0,
  tool_cost_usd  numeric(12,6) not null default 0,
  real_cost_brl  numeric(12,6) not null,
  credits        numeric(12,2) not null,
  writeoff       numeric(12,2) not null default 0,
  created_at     timestamptz not null default now()
);
create index action_usage_task on action_usage (task_type, created_at desc);
