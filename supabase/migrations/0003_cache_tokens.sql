-- Prompt caching: the API's input_tokens excludes cached tokens, which are billed differently
-- (reads ~0.05x, 5-minute writes 1.25x on Claude Sonnet 5.5). Track them per run so the real
-- cost per prompt can be computed. See apps/orchestrator/src/agent/planner.ts.

alter table public.runs
  add column cache_read_tokens integer not null default 0,
  add column cache_write_tokens integer not null default 0;

-- Browser-visible columns are an explicit list (0001), so extend it.
grant select (cache_read_tokens, cache_write_tokens) on public.runs to authenticated;
