-- Allow multiple integrations per provider per user.
--
-- Before: (user_id, provider) was the PK → one Gmail, one Slack per user.
-- After:  uuid id PK, with a unique constraint on (user_id, provider, label)
--         so the same user can have "Work Gmail" and "Personal Gmail".

-- 1. Drop the old composite primary key.
ALTER TABLE public.integrations DROP CONSTRAINT integrations_pkey;

-- 2. Add a proper id column as PK.
ALTER TABLE public.integrations
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE public.integrations
  ADD PRIMARY KEY (id);

-- 3. Add a human-readable label (e.g. "Work Gmail", "Personal Slack").
ALTER TABLE public.integrations
  ADD COLUMN label text NOT NULL DEFAULT 'Default';

-- 4. Prevent exact duplicate connections for the same user+provider+label.
CREATE UNIQUE INDEX integrations_user_provider_label_idx
  ON public.integrations (user_id, provider, label);

-- 5. Index for efficient lookup by provider (used by Edge Functions).
CREATE INDEX IF NOT EXISTS integrations_provider_idx
  ON public.integrations (provider);

-- 6. Update RLS policies to use the new id column.
--    (Existing policies reference user_id which is still present, so they
--     continue to work. No policy changes needed.)
