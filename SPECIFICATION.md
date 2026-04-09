# KeepTrack SPECIFICATION

**Status**: approved
**Date**: 2026-04-08
**Strategy**: interview (Light path)

## Overview

KeepTrack is a lightweight personal task manager delivered as a static web app (single-page, installable as a PWA) backed by Supabase. It lets a user capture, categorize, and track to-dos with tags and due dates, and auto-imports tasks from Gmail (labeled messages) and Slack (emoji reaction). v1 ships as a GitHub Pages site that users install on iPhone via "Add to Home Screen" and use on any desktop browser. A later phase introduces multi-user personal accounts with optional shared lists.

## Requirements

### Functional

- **FR-1**: Users sign in with Google OAuth via Supabase; a valid session is required for all data access.
- **FR-2**: Users can create, read, update, delete, and complete tasks. A task has: title, notes, due_at, priority (low/med/high), completed_at, source_url, created_at.
- **FR-3**: Users can create tags and attach multiple tags to any task. Tags are reusable across tasks.
- **FR-4**: The main task list supports filtering by tag/priority/completion and sorting by due date, priority, or created date; overdue tasks are visually distinct.
- **FR-5**: A Gmail integration (Supabase Edge Function, cron) polls the user's inbox for messages with the label `todo` and creates one task per new message, storing the Gmail message id for deduplication and the message URL as source_url.
- **FR-6**: A Slack app (Supabase Edge Function webhook) creates a task when a configured trigger emoji (`:todo:`) is added to any message in a workspace the user has installed it in; the Slack permalink is stored as source_url.
- **FR-7**: First-run onboarding walks the user through sign-in, Gmail connect, and Slack connect.
- **FR-8** *(phase 5)*: Users can create shared lists, invite other users by email, and collaborate on tasks within those lists.

### Non-Functional

- **NFR-1**: v1 ships as a static site on GitHub Pages; installable as a PWA (manifest + service worker) so iPhone users can "Add to Home Screen".
- **NFR-2**: Gmail polling runs on a schedule (≤5 min) without exceeding Gmail API rate limits.
- **NFR-3**: All user data is isolated via Supabase Row Level Security; no query path can return another user's rows. Secrets live in `secrets/` with `.example` templates; no secrets are shipped to the browser beyond the public anon key.
- **NFR-4**: Keep the frontend dependency-light — vanilla JS + Supabase JS SDK, no build step, single `index.html` + `app.js` + `styles.css`.

## Architecture

**Frontend** — a single static site (`index.html` + `app.js` + `styles.css` + `manifest.webmanifest` + `sw.js`) hosted on GitHub Pages. No build step, no framework. Uses the official `@supabase/supabase-js` SDK (loaded via ESM CDN) to talk directly to Supabase for auth and data.

**Backend** — Supabase provides:
- Google OAuth auth
- Postgres (tasks, tags, task_tags, integrations tables) with Row Level Security
- Two Edge Functions (Deno):
  - `gmail-poll` — cron-triggered, pulls Gmail messages labeled `todo` for each connected user and inserts tasks
  - `slack-events` — HTTP endpoint registered with Slack; receives `reaction_added` events and inserts tasks when the trigger emoji matches

**Install experience:**
- Desktop: open the GitHub Pages URL, sign in — works like any web app
- iPhone: Safari → Share → Add to Home Screen — icon on the home screen, opens full-screen, feels native

**Data model (v1):**

- `tasks(id, user_id, title, notes, due_at, priority, completed_at, source_url, gmail_message_id, slack_message_ts, created_at)`
- `tags(id, user_id, name)`
- `task_tags(task_id, tag_id)`
- `integrations(user_id, provider, access_token, refresh_token, scope, installed_at)`

**Phase 5 additions:**

- `lists(id, owner_id, name, created_at)`
- `list_members(list_id, user_id, role)`
- `tasks.list_id` (nullable)

## Implementation Plan

### Phase 1: Foundation
- 1.1 Static site scaffold: `index.html`, `app.js`, `styles.css`, `manifest.webmanifest`, `sw.js`, `README.md` *(traces: NFR-1, NFR-4)*
- 1.2 Supabase project + schema: migrations for tasks/tags/task_tags/integrations + RLS policies *(traces: FR-2, NFR-3)*
- 1.3 Google OAuth via Supabase: provider config + sign-in/sign-out flow in the frontend *(traces: FR-1)*
- 1.4 GitHub Pages deploy: repo + Pages enabled + working URL *(traces: NFR-1)*

### Phase 2: Core Tasks
- 2.1 Task CRUD: Supabase queries, create/edit/delete UI, mark complete *(traces: FR-2)*
- 2.2 Tags: tag CRUD, inline picker, multi-tag on tasks *(traces: FR-3)*
- 2.3 List/filter/sort: overdue highlight, tag/priority/completion filter, sort by due/priority/created *(traces: FR-4)*

### Phase 3: Integrations
- 3.1 Gmail label import: Gmail scope on Google OAuth, `gmail-poll` Edge Function, message-id dedupe *(traces: FR-5, NFR-2)*
- 3.2 Slack emoji trigger: Slack app + manifest, `slack-events` Edge Function, workspace→user linking *(traces: FR-6)*

### Phase 4: Polish & Ship v1
- 4.1 Onboarding flow (sign in → connect Gmail → connect Slack → done) *(traces: FR-7)*
- 4.2 PWA polish: icons, offline shell caching, "Add to Home Screen" tested on iPhone *(traces: NFR-1)*
- 4.3 README with setup instructions *(traces: NFR-4)*

### Phase 5: Multi-user (later)
- 5.1 Shared lists table + RLS *(traces: FR-8)*
- 5.2 Invite flow *(traces: FR-8)*
- 5.3 Per-list activity visibility *(traces: FR-8)*

**Dependencies:**
Phase 2 depends on Phase 1. Phase 3 depends on Phase 2 (needs task model). Phase 4 depends on Phase 3. Phase 5 is gated on v1 ship and user demand.

## Testing Strategy

- Manual smoke tests during Phase 1–2 (it's a UI, fast feedback loop).
- SQL tests for RLS: confirm user A can't read/write user B's rows using Supabase test helpers.
- Contract tests for Edge Functions: fixture Gmail responses and Slack event payloads, run via `deno test`.
- No framework heavy unit-test suite for the HTML/JS — prefer integration tests against a local Supabase instance.

## Deployment

- **Frontend**: GitHub Pages from `main` branch (`/` or `/docs`) — push to deploy.
- **Supabase**: project managed via Supabase CLI; migrations in `supabase/migrations/`; Edge Functions in `supabase/functions/`.
- **Secrets**: `secrets/supabase.env`, `secrets/google.env`, `secrets/slack.env`, each with `.example` templates. Only the Supabase project URL and anon key are embedded in the frontend.

---

**Generated by**: deft-setup skill (Phase 3, interview strategy, Light path) — revised for static HTML + Supabase hybrid
