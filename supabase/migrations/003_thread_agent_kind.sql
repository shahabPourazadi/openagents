-- Dual agent stacks: classic (/agent) vs deep (/v2/agent).
alter table threads
  add column if not exists agent_kind text not null default 'classic';
