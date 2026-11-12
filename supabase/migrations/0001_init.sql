-- Whispcord initial schema.
-- The orchestrator uses the service-role key (bypasses RLS) and enforces checks in code.
-- The web app uses the anon key + the user's session, so RLS below is what protects the data.

create extension if not exists pgcrypto;

-- ---------- profiles ----------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  discord_user_id text unique,
  username text,
  avatar_url text,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  manageable_guilds jsonb not null default '[]'::jsonb,
  guilds_synced_at timestamptz,
  created_at timestamptz not null default now()
);

-- Create a profile when someone signs in with Discord. Discord's user id is the provider id.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, discord_user_id, username, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'provider_id', new.raw_user_meta_data ->> 'sub'),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- servers ----------
create table public.servers (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null unique check (guild_id ~ '^\d{17,20}$'),
  name text not null,
  icon text,
  owner_profile_id uuid not null references public.profiles (id),
  status text not null default 'pending' check (status in ('pending', 'connected', 'disconnected')),
  enabled_tiers text[] not null default array['read', 'build', 'destructive'],
  bot_role_ok boolean not null default false,
  connected_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.server_members (
  server_id uuid not null references public.servers (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'editor')),
  created_at timestamptz not null default now(),
  primary key (server_id, profile_id)
);

create table public.connect_attempts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  guild_id text not null,
  state text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------- runs ----------
create table public.runs (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers (id) on delete cascade,
  profile_id uuid not null references public.profiles (id),
  kind text not null default 'prompt' check (kind in ('prompt', 'undo', 'fix')),
  parent_run_id uuid references public.runs (id),
  prompt text not null,
  status text not null default 'planning'
    check (status in ('planning', 'needs_input', 'awaiting_approval', 'running', 'done', 'failed', 'undone', 'cancelled')),
  plan_json jsonb,
  conversation_json jsonb,          -- Claude message history; never exposed to the browser
  pending_question_json jsonb,
  approved_step_ids text[],
  error text,
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index runs_server_created_idx on public.runs (server_id, created_at desc);

create table public.run_actions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs (id) on delete cascade,
  step_id text not null,
  step_index integer not null,
  tool text not null,
  args_json jsonb not null default '{}'::jsonb,
  result_text text,
  status text not null check (status in ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  error text,
  created_object_id text,
  created_object_type text,
  before_snapshot text,
  inverse_action_json jsonb,
  duration_ms integer,
  created_at timestamptz not null default now(),
  unique (run_id, step_id)
);

-- ---------- usage ----------
create table public.usage (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  period text not null, -- YYYY-MM
  runs_count integer not null default 0,
  actions_count integer not null default 0,
  tokens bigint not null default 0,
  primary key (profile_id, period)
);

create or replace function public.increment_usage(
  p_profile_id uuid, p_period text, p_runs integer, p_actions integer, p_tokens bigint
) returns void
language sql
security definer set search_path = public
as $$
  insert into public.usage (profile_id, period, runs_count, actions_count, tokens)
  values (p_profile_id, p_period, p_runs, p_actions, p_tokens)
  on conflict (profile_id, period) do update set
    runs_count = usage.runs_count + excluded.runs_count,
    actions_count = usage.actions_count + excluded.actions_count,
    tokens = usage.tokens + excluded.tokens;
$$;
revoke execute on function public.increment_usage from public, anon, authenticated;

-- ---------- row level security ----------
alter table public.profiles enable row level security;
alter table public.servers enable row level security;
alter table public.server_members enable row level security;
alter table public.connect_attempts enable row level security;
alter table public.runs enable row level security;
alter table public.run_actions enable row level security;
alter table public.usage enable row level security;

-- Helper: is the current user a member of this server?
create or replace function public.is_server_member(p_server_id uuid)
returns boolean
language sql stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.server_members
    where server_id = p_server_id and profile_id = auth.uid()
  );
$$;

-- Read-only for users; all writes go through the orchestrator (service role).
create policy "read own profile" on public.profiles
  for select using (id = auth.uid());

create policy "read member servers" on public.servers
  for select using (public.is_server_member(id));

create policy "read own memberships" on public.server_members
  for select using (profile_id = auth.uid());

create policy "read member runs" on public.runs
  for select using (public.is_server_member(server_id));

create policy "read member run actions" on public.run_actions
  for select using (
    exists (select 1 from public.runs r where r.id = run_id and public.is_server_member(r.server_id))
  );

create policy "read own usage" on public.usage
  for select using (profile_id = auth.uid());

-- connect_attempts: no user policies (orchestrator only).

-- The Claude conversation is internal; hide it from the browser even for members.
-- (A column-level revoke doesn't override a table-level grant, so grant an explicit column list.)
revoke select on public.runs from anon, authenticated;
grant select (
  id, server_id, profile_id, kind, parent_run_id, prompt, status, plan_json, approved_step_ids,
  error, model, input_tokens, output_tokens, created_at, updated_at
) on public.runs to authenticated;

-- Internal snapshots/inverses aren't needed by the browser either.
revoke select on public.run_actions from anon, authenticated;
grant select (
  id, run_id, step_id, step_index, tool, args_json, result_text, status, error,
  created_object_id, created_object_type, duration_ms, created_at
) on public.run_actions to authenticated;

revoke select on public.profiles from anon;
revoke all on public.connect_attempts from anon, authenticated;
