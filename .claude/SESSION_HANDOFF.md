# KeepTrack Session Handoff — 2026-04-14

## What Exists

### Frontend (GitHub Pages — auto-deploys on push to main)
- Static PWA: `index.html`, `app.js`, `styles.css`, `manifest.webmanifest`, `sw.js`
- Live at: https://jslimerickbtcc.github.io/KeepTrack/
- No build step, vanilla JS + Supabase JS SDK via ESM CDN
- Features: task CRUD, tags with colors, filters/sort, grouped due-date view, keyboard shortcuts, confetti on completion, in-memory mock mode

### Supabase Backend
- **Project ref**: `dzdizortbzvfeiksfylp`
- **Dashboard API keys**: https://supabase.com/dashboard/project/dzdizortbzvfeiksfylp/settings/api-keys/legacy (NOT /settings/api)
- **Edge Function secrets page**: https://supabase.com/dashboard/project/dzdizortbzvfeiksfylp/settings/functions
- **Anon key** (public, in app.js): `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR6ZGl6b3J0Ynp2ZmVpa3NmeWxwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2Njc4MDAsImV4cCI6MjA5MTI0MzgwMH0.VxmK_7aXWLrROKFMBs7liQqqb3oAhOkdELxWaPVJbp4`

### Database Schema (4 migrations)
- `0001_init.sql` — tasks, tags, task_tags, integrations + RLS
- `0002_tag_colors.sql` — tags.color column
- `0003_multi_integrations.sql` — uuid id PK, label column, supports multiple accounts per provider
- All migrations have been run against the live DB

### Edge Functions (all deployed, all use `--no-verify-jwt`)
- `gmail-auth-start` — builds Google OAuth URL for popup flow, verifies user JWT internally
- `gmail-auth-callback` — exchanges code for tokens, inserts into integrations, redirects to gmail-connected.html
- `gmail-poll` — cron every 5 min, polls Gmail for threads labeled "todo", thread-based dedup, stores email body (last message) in notes
- `gmail-complete` — GET returns user's Gmail labels, POST removes "todo" label + optionally archives + applies another label
- `slack-events` — webhook for Slack reaction_added events, creates tasks on :todo: emoji (deployed but no Slack app configured yet)

### Gmail Integration (fully working)
- Multi-account support via standalone OAuth popup (not tied to sign-in account)
- Google Cloud project ID: 657407009245
- OAuth client ID: `657407009245-8a003ln18pqiqg610dnt46j29hdvba9q.apps.googleusercontent.com`
- Gmail API enabled, test users must be manually added in Google Cloud Console
- Redirect URI registered: `https://dzdizortbzvfeiksfylp.supabase.co/functions/v1/gmail-auth-callback`
- pg_cron + pg_net enabled, cron job `gmail-poll-every-5min` is active
- Completion modal: asks to archive + apply Gmail label when completing a Gmail task

### Slack Integration (Edge Function deployed, NO Slack app created yet)
- `slack-events/index.ts` handles url_verification + reaction_added
- `slack-app-manifest.yaml` exists in repo root — ready to paste into Slack's "Create from manifest"
- Multi-workspace support works (same as Gmail multi-account)
- Frontend has "Add Slack workspace" form in Integrations modal

### Supabase CLI
- Installed via `brew install supabase/tap/supabase`
- Project linked: `supabase link --project-ref dzdizortbzvfeiksfylp`
- Deploy command: `SUPABASE_ACCESS_TOKEN=<token> supabase functions deploy <name> --no-verify-jwt --project-ref dzdizortbzvfeiksfylp`
- Access tokens must be generated at https://supabase.com/dashboard/account/tokens (they get revoked between sessions)

### App Icon
- Glossy 3D indigo checkmark circle
- SVG source + PNGs at 128, 180, 192, 512
- Maskable variants for PWA home screen
- Inline checkmark SVG in the topbar next to "KeepTrack"
- `icon-emoji.svg` / `icon-128.png` — transparent background version for Slack emoji

## What's NOT Done

### Slack App Setup (next priority)
- Need to create the Slack app using the manifest at `slack-app-manifest.yaml`
- Update the manifest's `request_url` to point to the live Edge Function URL
- Install the app in Jordan's workspace(s)
- Test the :todo: emoji reaction flow end-to-end

### Phase 4: Polish & Ship v1
- 4.1 Onboarding flow (sign in → connect Gmail → connect Slack → done)
- 4.2 PWA polish: icons done, need offline shell caching tested on iPhone
- 4.3 README with setup instructions

### Deferred
- AI task extraction from email body (needs Anthropic API key)
- Custom domain
- Phase 5: multi-user shared lists

## Key Patterns / Gotchas
- Edge Functions MUST be deployed with `--no-verify-jwt` — Supabase gateway rejects requests otherwise since functions do their own auth
- The Google Cloud app is in "testing" mode — new Gmail accounts must be added as test users
- `gmail-poll` uses thread-based dedup (not message-based) to avoid duplicates from conversation chains
- Email body in task notes comes from the LAST message in the thread (most recent reply)
- The `config.js` is gitignored; `app.js` has production defaults hardcoded
