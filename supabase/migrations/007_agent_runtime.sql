-- Admin-editable deep-agent sandbox / execute runtime (overrides env when set).

alter table public.system_settings
  add column if not exists agent_runtime jsonb not null default '{}'::jsonb;
