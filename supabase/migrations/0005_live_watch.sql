-- Live moderation: a server owner approves a plan that starts a watch ("flag hurtful messages").
-- New messages in watched channels go to the same tool-less classifier as message search.
--
-- live_flags holds excerpts of members' messages, so (like message search findings):
--   * it is NOT readable by the browser directly; the orchestrator returns flags to server members;
--   * the orchestrator deletes flags after FINDINGS_RETENTION_DAYS (default 30).

create table public.live_watches (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers (id) on delete cascade,
  run_id uuid references public.runs (id) on delete set null,
  created_by uuid not null references public.profiles (id) on delete cascade,
  created_by_discord_id text not null check (created_by_discord_id ~ '^\d{17,20}$'),
  criteria text not null check (char_length(criteria) between 3 and 500),
  channel_ids text[] not null default '{}',
  -- Delete high-severity matches automatically. Needs the Deletions tier and typed confirmation.
  auto_delete boolean not null default false,
  status text not null default 'active' check (status in ('active', 'stopped')),
  created_at timestamptz not null default now(),
  stopped_at timestamptz
);

create index live_watches_server_idx on public.live_watches (server_id, created_at desc);
create index live_watches_active_idx on public.live_watches (status) where status = 'active';

create table public.live_flags (
  id uuid primary key default gen_random_uuid(),
  watch_id uuid not null references public.live_watches (id) on delete cascade,
  server_id uuid not null references public.servers (id) on delete cascade,
  message_id text not null check (message_id ~ '^\d{17,20}$'),
  channel_id text not null check (channel_id ~ '^\d{17,20}$'),
  channel_name text not null default '',
  author_id text not null,
  author_name text not null default '',
  posted_at timestamptz not null,
  severity text not null check (severity in ('low', 'medium', 'high')),
  reason text not null,
  excerpt text,
  jump_url text not null,
  action text not null default 'none' check (action in ('none', 'dismissed', 'auto_deleted', 'auto_delete_failed')),
  action_error text,
  flagged_at timestamptz not null default now(),
  unique (watch_id, message_id)
);

create index live_flags_server_idx on public.live_flags (server_id, flagged_at desc);
create index live_flags_flagged_idx on public.live_flags (flagged_at);

alter table public.live_watches enable row level security;
alter table public.live_flags enable row level security;

-- Members may read their servers' watches (no message content in them).
create policy "read member live watches" on public.live_watches
  for select using (public.is_server_member(server_id));

-- Flags contain message excerpts: no browser access at all (orchestrator only).
revoke all on public.live_flags from anon, authenticated;
