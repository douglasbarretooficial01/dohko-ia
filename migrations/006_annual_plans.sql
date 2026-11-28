-- Planos anuais: cobrados uma vez por ano, créditos liberados todo mês

alter table workspaces
  add column plan_period_end    timestamptz,   -- fim do período pago (anual)
  add column next_plan_grant_at timestamptz;   -- próxima liberação mensal de créditos
create index workspaces_next_grant on workspaces (next_plan_grant_at) where next_plan_grant_at is not null;
