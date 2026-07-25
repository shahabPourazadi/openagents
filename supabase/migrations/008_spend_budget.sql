-- Per-user spend budget (USD). Default $5 until payment gateway exists.
alter table public.user_settings
  add column if not exists spend_budget_usd double precision not null default 5.0;

comment on column public.user_settings.spend_budget_usd is
  'Max lifetime OpenRouter cost (USD) before new agent runs are blocked. Admin-editable.';
