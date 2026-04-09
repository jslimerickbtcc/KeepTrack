-- KeepTrack initial schema — tasks, tags, task_tags, integrations, with RLS.
-- Run this in the Supabase SQL editor (or via `supabase db push` with the CLI).

-- ============================================================
-- Extensions
-- ============================================================
create extension if not exists "pgcrypto";

-- ============================================================
-- Tables
-- ============================================================

create table if not exists public.tasks (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  title              text not null,
  notes              text,
  due_at             timestamptz,
  priority           text not null default 'med' check (priority in ('low','med','high')),
  completed_at       timestamptz,
  source_url         text,
  gmail_message_id   text,
  slack_message_ts   text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists tasks_user_id_idx       on public.tasks (user_id);
create index if not exists tasks_user_due_idx      on public.tasks (user_id, due_at);
create index if not exists tasks_user_completed_idx on public.tasks (user_id, completed_at);
create unique index if not exists tasks_user_gmail_msg_idx
  on public.tasks (user_id, gmail_message_id)
  where gmail_message_id is not null;
create unique index if not exists tasks_user_slack_msg_idx
  on public.tasks (user_id, slack_message_ts)
  where slack_message_ts is not null;

create table if not exists public.tags (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.task_tags (
  task_id uuid not null references public.tasks(id) on delete cascade,
  tag_id  uuid not null references public.tags(id)  on delete cascade,
  primary key (task_id, tag_id)
);

create index if not exists task_tags_tag_id_idx on public.task_tags (tag_id);

create table if not exists public.integrations (
  user_id       uuid not null references auth.users(id) on delete cascade,
  provider      text not null check (provider in ('gmail','slack')),
  access_token  text,
  refresh_token text,
  scope         text,
  metadata      jsonb not null default '{}'::jsonb,
  installed_at  timestamptz not null default now(),
  primary key (user_id, provider)
);

-- ============================================================
-- updated_at trigger for tasks
-- ============================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at
before update on public.tasks
for each row execute function public.set_updated_at();

-- ============================================================
-- Row Level Security
-- Every table is user-scoped: users can only see/modify their own rows.
-- ============================================================
alter table public.tasks        enable row level security;
alter table public.tags         enable row level security;
alter table public.task_tags    enable row level security;
alter table public.integrations enable row level security;

-- tasks
drop policy if exists "tasks are owner-visible"  on public.tasks;
drop policy if exists "tasks are owner-writable" on public.tasks;

create policy "tasks are owner-visible"
  on public.tasks for select
  using (auth.uid() = user_id);

create policy "tasks are owner-writable"
  on public.tasks for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- tags
drop policy if exists "tags are owner-visible"  on public.tags;
drop policy if exists "tags are owner-writable" on public.tags;

create policy "tags are owner-visible"
  on public.tags for select
  using (auth.uid() = user_id);

create policy "tags are owner-writable"
  on public.tags for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- task_tags — access follows the parent task's owner
drop policy if exists "task_tags are owner-visible"  on public.task_tags;
drop policy if exists "task_tags are owner-writable" on public.task_tags;

create policy "task_tags are owner-visible"
  on public.task_tags for select
  using (
    exists (
      select 1 from public.tasks t
      where t.id = task_tags.task_id
        and t.user_id = auth.uid()
    )
  );

create policy "task_tags are owner-writable"
  on public.task_tags for all
  using (
    exists (
      select 1 from public.tasks t
      where t.id = task_tags.task_id
        and t.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.tasks t
      where t.id = task_tags.task_id
        and t.user_id = auth.uid()
    )
  );

-- integrations — owner-only
drop policy if exists "integrations are owner-visible"  on public.integrations;
drop policy if exists "integrations are owner-writable" on public.integrations;

create policy "integrations are owner-visible"
  on public.integrations for select
  using (auth.uid() = user_id);

create policy "integrations are owner-writable"
  on public.integrations for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- Default user_id trigger for tasks/tags
-- So the frontend can `.insert({ title })` without passing user_id.
-- ============================================================
create or replace function public.default_user_id()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.user_id is null then
    new.user_id := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_default_user_id on public.tasks;
create trigger tasks_default_user_id
before insert on public.tasks
for each row execute function public.default_user_id();

drop trigger if exists tags_default_user_id on public.tags;
create trigger tags_default_user_id
before insert on public.tags
for each row execute function public.default_user_id();
