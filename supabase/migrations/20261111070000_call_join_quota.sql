-- Joins on the hosted demo's calls: every token the call routes mint counts (apps/web/call-hosted.ts), 20 a copy and
-- 300 a day, so a call without Remy, which costs nothing to start, can't be joined again and again either.
--
-- Another migration may add the same row first; either way there is one, and a limit changed in place stays as it is.

insert into public.quota_limits (kind, per_copy, per_day) values
  ('call_join', 20, 300)
on conflict (kind) do nothing;
