# KeepTrack

A lightweight personal task manager. Static HTML + Supabase backend. Installs as a PWA on iPhone and desktop.

## Run locally (zero setup)

Open `index.html` in a browser, or serve the folder with any static server. With no `config.js` present, the app runs in **local demo mode** — tasks live in memory so you can see the UI work immediately.

```bash
# Any static server works, e.g.:
python3 -m http.server 5173
# then open http://localhost:5173
```

## Go live

1. Create a free Supabase project at https://supabase.com
2. Enable the Google auth provider (Authentication → Providers → Google)
3. Copy your project URL and anon key
4. `cp config.example.js config.js` and paste them in
5. Run the SQL migrations in `supabase/migrations/` (coming next)
6. Reload — the app now uses Supabase

`config.js` is git-ignored so your keys stay local.

## Deploy to GitHub Pages

1. Push this repo to GitHub
2. Settings → Pages → Source: `main` branch, `/` root
3. Done — your URL is `https://<user>.github.io/<repo>`
4. On iPhone: open the URL in Safari → Share → **Add to Home Screen**

## Project layout

```
index.html              # App shell
app.js                  # Frontend logic (vanilla JS + Supabase SDK)
styles.css              # Styles
manifest.webmanifest    # PWA manifest
sw.js                   # Service worker (offline shell cache)
icons/icon.svg          # App icon
config.example.js       # Template for your Supabase keys
SPECIFICATION.md        # Full product spec
PROJECT.md              # Project-level rules
```

## Status

Phase 1 — Foundation. See `SPECIFICATION.md` for the full plan.
