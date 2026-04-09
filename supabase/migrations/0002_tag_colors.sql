-- KeepTrack: add color to tags
-- Run in Supabase SQL editor.
alter table public.tags
  add column if not exists color text not null default '#6366f1';
