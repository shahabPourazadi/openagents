-- Per-thread selected agent (restored when switching chats).
-- Safe to re-run.

alter table public.threads
  add column if not exists agent_slug text not null default 'agent';

-- Existing chats inherit the workspace's current agent so behavior stays familiar.
update public.threads t
set agent_slug = coalesce(nullif(trim(w.agent_slug), ''), 'agent')
from public.workspaces w
where t.workspace_id = w.id
  and (t.agent_slug is null or t.agent_slug = '' or t.agent_slug = 'agent')
  and coalesce(nullif(trim(w.agent_slug), ''), 'agent') <> 'agent';
