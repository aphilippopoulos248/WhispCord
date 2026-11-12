-- Message search: a run can end in a report (no changes) and keep the messages it found.
-- message_search_json holds excerpts of members' messages, so:
--   * it is NOT readable by the browser directly (the orchestrator returns it to server members);
--   * the orchestrator clears it after FINDINGS_RETENTION_DAYS (default 30).

alter table public.runs
  add column report text,
  add column message_search_json jsonb;

-- The summary is fine for members to read; the findings stay server-side.
grant select (report) on public.runs to authenticated;
