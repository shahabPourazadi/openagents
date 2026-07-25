-- Workspace files for memory and research scratch (non-document).

create table if not exists workspace_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  path text not null,
  kind text not null default 'other',
  content_md text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, path)
);

create index if not exists workspace_files_workspace_id_idx on workspace_files (workspace_id);
