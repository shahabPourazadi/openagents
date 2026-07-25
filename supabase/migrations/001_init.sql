-- OpenAgents schema (Postgres / Supabase)
-- Owner-only workspaces in v1; membership table reserved for invites later.

create extension if not exists "pgcrypto";

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  name text not null,
  agent_md text,
  soul_md text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists workspace_members (
  workspace_id uuid references workspaces(id) on delete cascade,
  user_id text not null,
  role text not null default 'member',
  primary key (workspace_id, user_id)
);

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  path text not null,
  title text not null,
  content_md text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists document_revisions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  content_md text not null,
  summary text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null default 'New chat',
  model text not null default 'openrouter:anthropic/claude-sonnet-4',
  active_document_id uuid references documents(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references threads(id) on delete cascade,
  role text not null,
  content text not null default '',
  meta jsonb,
  created_at timestamptz not null default now()
);

create table if not exists suggestions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  thread_id uuid references threads(id) on delete set null,
  kind text not null,
  old_text text not null default '',
  new_text text not null default '',
  section_heading text,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists user_settings (
  user_id text primary key,
  openrouter_api_key_enc text,
  preferred_model text
);

-- Storage bucket for images/plots (create via Supabase dashboard or storage API):
-- insert into storage.buckets (id, name, public) values ('artifacts', 'artifacts', true);
