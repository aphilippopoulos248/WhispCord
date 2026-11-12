-- Track when a server's status last changed, so disconnected servers (and their run history)
-- can be purged after a retention period. See docs/discord-policies.md (data deletion).

alter table public.servers
  add column status_changed_at timestamptz not null default now();

create or replace function public.touch_server_status()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end;
$$;

create trigger servers_status_changed
  before update on public.servers
  for each row execute function public.touch_server_status();

create index servers_status_changed_idx on public.servers (status, status_changed_at);
create index runs_profile_created_idx on public.runs (profile_id, created_at desc);
create index connect_attempts_expires_idx on public.connect_attempts (expires_at);
