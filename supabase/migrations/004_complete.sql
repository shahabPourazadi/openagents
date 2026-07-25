-- OpenAgents complete schema sync + RLS for Supabase (Postgres).
-- Safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
--
-- Apply on the VPS:
--   docker exec -i supabase-db-glo1gawg6xw938zvqnhpd7nj \
--     psql -U supabase_admin -d postgres < 004_complete.sql
--
-- Or paste into Supabase Studio → SQL Editor.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  name text not null,
  agent_md text,
  soul_md text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workspaces_owner_id_idx on public.workspaces (owner_id);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id text not null,
  role text not null default 'member',
  primary key (workspace_id, user_id)
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  path text not null,
  title text not null,
  content_md text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists documents_workspace_id_idx on public.documents (workspace_id);

create table if not exists public.document_revisions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  content_md text not null,
  summary text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists document_revisions_document_id_idx on public.document_revisions (document_id);

create table if not exists public.threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null default 'New chat',
  model text not null default 'openrouter:z-ai/glm-5.2',
  agent_slug text not null default 'agent',
  agent_kind text not null default 'classic',
  active_document_id uuid references public.documents(id) on delete set null,
  usage jsonb,
  todos jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists threads_workspace_id_idx on public.threads (workspace_id);

-- Backfill columns if an older migration created threads without them
alter table public.threads add column if not exists agent_kind text not null default 'classic';
alter table public.threads add column if not exists agent_slug text not null default 'agent';
alter table public.threads add column if not exists usage jsonb;
alter table public.threads add column if not exists todos jsonb;

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  role text not null,
  content text not null default '',
  meta jsonb,
  created_at timestamptz not null default now()
);

create index if not exists messages_thread_id_idx on public.messages (thread_id);

create table if not exists public.suggestions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  thread_id uuid references public.threads(id) on delete set null,
  kind text not null,
  old_text text not null default '',
  new_text text not null default '',
  section_heading text,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists suggestions_document_id_idx on public.suggestions (document_id);

create table if not exists public.workspace_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  path text not null,
  kind text not null default 'other',
  content_md text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, path)
);

create index if not exists workspace_files_workspace_id_idx on public.workspace_files (workspace_id);

create table if not exists public.user_settings (
  user_id text primary key,
  openrouter_api_key_enc text,
  preferred_model text,
  spend_totals jsonb
);

alter table public.user_settings add column if not exists spend_totals jsonb;

-- Optional: profiles mirror for auth.users (handy in Studio)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Auto-create profile on signup
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do update
    set email = excluded.email,
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists workspaces_set_updated_at on public.workspaces;
create trigger workspaces_set_updated_at
  before update on public.workspaces
  for each row execute function public.set_updated_at();

drop trigger if exists documents_set_updated_at on public.documents;
create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

drop trigger if exists workspace_files_set_updated_at on public.workspace_files;
create trigger workspace_files_set_updated_at
  before update on public.workspace_files
  for each row execute function public.set_updated_at();

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- API uses the Postgres role (bypasses RLS). RLS protects Studio / PostgREST
-- / any direct anon-key client access.
-- ---------------------------------------------------------------------------

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.documents enable row level security;
alter table public.document_revisions enable row level security;
alter table public.threads enable row level security;
alter table public.messages enable row level security;
alter table public.suggestions enable row level security;
alter table public.workspace_files enable row level security;
alter table public.user_settings enable row level security;
alter table public.profiles enable row level security;

-- Helper: workspace owned by current auth user
create or replace function public.is_workspace_owner(ws_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspaces w
    where w.id = ws_id and w.owner_id = auth.uid()::text
  );
$$;

-- workspaces
drop policy if exists workspaces_select_own on public.workspaces;
create policy workspaces_select_own on public.workspaces
  for select using (owner_id = auth.uid()::text);

drop policy if exists workspaces_insert_own on public.workspaces;
create policy workspaces_insert_own on public.workspaces
  for insert with check (owner_id = auth.uid()::text);

drop policy if exists workspaces_update_own on public.workspaces;
create policy workspaces_update_own on public.workspaces
  for update using (owner_id = auth.uid()::text);

drop policy if exists workspaces_delete_own on public.workspaces;
create policy workspaces_delete_own on public.workspaces
  for delete using (owner_id = auth.uid()::text);

-- workspace_members
drop policy if exists workspace_members_owner on public.workspace_members;
create policy workspace_members_owner on public.workspace_members
  for all using (public.is_workspace_owner(workspace_id))
  with check (public.is_workspace_owner(workspace_id));

-- documents
drop policy if exists documents_owner on public.documents;
create policy documents_owner on public.documents
  for all using (public.is_workspace_owner(workspace_id))
  with check (public.is_workspace_owner(workspace_id));

-- document_revisions
drop policy if exists document_revisions_owner on public.document_revisions;
create policy document_revisions_owner on public.document_revisions
  for all using (
    exists (
      select 1 from public.documents d
      where d.id = document_id and public.is_workspace_owner(d.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from public.documents d
      where d.id = document_id and public.is_workspace_owner(d.workspace_id)
    )
  );

-- threads
drop policy if exists threads_owner on public.threads;
create policy threads_owner on public.threads
  for all using (public.is_workspace_owner(workspace_id))
  with check (public.is_workspace_owner(workspace_id));

-- messages
drop policy if exists messages_owner on public.messages;
create policy messages_owner on public.messages
  for all using (
    exists (
      select 1 from public.threads t
      where t.id = thread_id and public.is_workspace_owner(t.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from public.threads t
      where t.id = thread_id and public.is_workspace_owner(t.workspace_id)
    )
  );

-- suggestions
drop policy if exists suggestions_owner on public.suggestions;
create policy suggestions_owner on public.suggestions
  for all using (
    exists (
      select 1 from public.documents d
      where d.id = document_id and public.is_workspace_owner(d.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from public.documents d
      where d.id = document_id and public.is_workspace_owner(d.workspace_id)
    )
  );

-- workspace_files
drop policy if exists workspace_files_owner on public.workspace_files;
create policy workspace_files_owner on public.workspace_files
  for all using (public.is_workspace_owner(workspace_id))
  with check (public.is_workspace_owner(workspace_id));

-- user_settings
drop policy if exists user_settings_own on public.user_settings;
create policy user_settings_own on public.user_settings
  for all using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

-- profiles
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (id = auth.uid());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (id = auth.uid());

-- ---------------------------------------------------------------------------
-- Grants (PostgREST roles)
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;

grant all on all tables in schema public to postgres, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;

grant usage, select on all sequences in schema public to authenticated, service_role;

-- Storage bucket for uploads (optional; API still uses local disk today)
insert into storage.buckets (id, name, public)
values ('artifacts', 'artifacts', true)
on conflict (id) do nothing;
