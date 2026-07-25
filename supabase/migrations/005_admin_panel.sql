-- Admin control panel: platform roles, signup approval, company agent config.

-- ---------------------------------------------------------------------------
-- system_settings (singleton)
-- ---------------------------------------------------------------------------

create table if not exists public.system_settings (
  id int primary key default 1 check (id = 1),
  signup_mode text not null default 'admin_approve'
    check (signup_mode in ('admin_approve', 'auto_approve')),
  tool_groups jsonb not null default '{
    "hitl": true,
    "firecrawl": true,
    "document_parse": true,
    "deep_builtins": true
  }'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into public.system_settings (id) values (1)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- profiles: role + signup status
-- ---------------------------------------------------------------------------

-- Add role/status as nullable first so we can grandfather existing rows once,
-- then set defaults for new signups (pending + user).
alter table public.profiles add column if not exists role text;
alter table public.profiles add column if not exists status text;
alter table public.profiles add column if not exists approved_at timestamptz;
alter table public.profiles add column if not exists approved_by text;
alter table public.profiles add column if not exists rejected_at timestamptz;
alter table public.profiles add column if not exists pending_notified_at timestamptz;

-- Grandfather: only rows that never had a status (first migrate). Re-runs skip.
update public.profiles
set role = coalesce(role, 'user'),
    status = coalesce(status, 'active')
where role is null or status is null;

alter table public.profiles alter column role set default 'user';
alter table public.profiles alter column status set default 'pending';
update public.profiles set role = 'user' where role is null;
update public.profiles set status = 'active' where status is null;
alter table public.profiles alter column role set not null;
alter table public.profiles alter column status set not null;

do $$
begin
  alter table public.profiles drop constraint if exists profiles_role_check;
  alter table public.profiles
    add constraint profiles_role_check check (role in ('user', 'admin'));
  alter table public.profiles drop constraint if exists profiles_status_check;
  alter table public.profiles
    add constraint profiles_status_check
    check (status in ('pending', 'active', 'rejected', 'disabled'));
exception
  when others then null;
end $$;
-- ---------------------------------------------------------------------------
-- Signup trigger: display name + status from signup_mode
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  mode text;
  initial_status text;
  display text;
begin
  select signup_mode into mode from public.system_settings where id = 1;
  if coalesce(mode, 'admin_approve') = 'auto_approve' then
    initial_status := 'active';
  else
    initial_status := 'pending';
  end if;

  display := coalesce(
    nullif(new.raw_user_meta_data->>'full_name', ''),
    nullif(new.raw_user_meta_data->>'display_name', ''),
    split_part(new.email, '@', 1)
  );

  insert into public.profiles (id, email, display_name, role, status)
  values (new.id, new.email, display, 'user', initial_status)
  on conflict (id) do update
    set email = excluded.email,
        display_name = coalesce(nullif(excluded.display_name, ''), public.profiles.display_name),
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Prevent PostgREST authenticated/anon clients from changing admin fields.
-- API connects as postgres/supabase_admin (auth.uid() is null) and is allowed.
create or replace function public.protect_profile_admin_fields()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if old.role is distinct from new.role
       or old.status is distinct from new.status
       or old.approved_at is distinct from new.approved_at
       or old.approved_by is distinct from new.approved_by
       or old.rejected_at is distinct from new.rejected_at
       or old.pending_notified_at is distinct from new.pending_notified_at then
      if auth.uid() is not null then
        raise exception 'role and status can only be changed by the service';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect_admin_fields on public.profiles;
create trigger profiles_protect_admin_fields
  before update on public.profiles
  for each row execute function public.protect_profile_admin_fields();

-- ---------------------------------------------------------------------------
-- Company proprietary prompts (draft / published)
-- Content seeded by API on startup from templates/.
-- ---------------------------------------------------------------------------

create table if not exists public.company_prompt_docs (
  key text primary key check (key in ('system_prompt', 'agent_md', 'soul_md')),
  draft_content text not null default '',
  published_content text not null default '',
  draft_updated_at timestamptz,
  published_at timestamptz,
  published_by text,
  updated_at timestamptz not null default now()
);

insert into public.company_prompt_docs (key) values
  ('system_prompt'),
  ('agent_md'),
  ('soul_md')
on conflict (key) do nothing;

create table if not exists public.company_skills (
  slug text primary key,
  title text not null,
  enabled boolean not null default true,
  draft_content text not null default '',
  published_content text not null default '',
  draft_updated_at timestamptz,
  published_at timestamptz,
  published_by text,
  updated_at timestamptz not null default now()
);

-- Company skills are seeded at runtime / admin UI (no built-in product skills).

-- ---------------------------------------------------------------------------
-- Admin audit log
-- ---------------------------------------------------------------------------

create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id text not null,
  action text not null,
  target_type text,
  target_id text,
  meta jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_log_created_at_idx
  on public.admin_audit_log (created_at desc);

-- ---------------------------------------------------------------------------
-- RLS: company config + settings + audit are API-only (no anon/auth policies)
-- ---------------------------------------------------------------------------

alter table public.system_settings enable row level security;
alter table public.company_prompt_docs enable row level security;
alter table public.company_skills enable row level security;
alter table public.admin_audit_log enable row level security;

-- No policies for authenticated/anon → denied. service_role / postgres bypass RLS.

grant all on public.system_settings to postgres, service_role;
grant all on public.company_prompt_docs to postgres, service_role;
grant all on public.company_skills to postgres, service_role;
grant all on public.admin_audit_log to postgres, service_role;

drop trigger if exists system_settings_set_updated_at on public.system_settings;
create trigger system_settings_set_updated_at
  before update on public.system_settings
  for each row execute function public.set_updated_at();

drop trigger if exists company_prompt_docs_set_updated_at on public.company_prompt_docs;
create trigger company_prompt_docs_set_updated_at
  before update on public.company_prompt_docs
  for each row execute function public.set_updated_at();

drop trigger if exists company_skills_set_updated_at on public.company_skills;
create trigger company_skills_set_updated_at
  before update on public.company_skills
  for each row execute function public.set_updated_at();
