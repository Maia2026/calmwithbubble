# Bubble — Adelyn's Anger App

A deployable PWA built on the four Core Systems (sync, points, PIN parent zone,
therapist reports) from the Blob Battle handoff. The anger-specific core loop
is the reskin: four doors, before/after rating, Bubble buddy + anger monster,
chip-based reflection, coping-tool bank. 

## Files
- `index.html` — structure, registers the service worker
- `app.js` — core loop, points (`calcPoints`), PIN zone, report generator
- `sync.js` — local-first + Supabase smart-merge sync
- `styles.css` — all styling (phone frame; fills screen when installed)
- `sw.js` — service worker, network-first for HTML
- `manifest.json` — PWA config

## BEFORE IT WORKS — 3 things you must do

### 1. Supabase
Run this once in the Supabase SQL Editor:
```sql
create table app_data (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
alter table app_data enable row level security;
create policy "Allow all access with anon key"
  on app_data for all using (true) with check (true);
```

### 2. Paste your keys into `sync.js` (top of file, marked CONFIGURE THIS)
- `SUPABASE_URL` — your project URL, no `/rest/v1`
- `SUPABASE_ANON_KEY` — the anon public key (safe in client code; never the service_role key)
- `FAMILY_ID` — any unique string for this household

### 3. Deploy
```
git add . && git commit -m "Bubble anger app" && git push
```
Vercel auto-deploys from `main`. After ~30s, force-close and reopen the app
on devices (Lesson 16 — browser cache is stubborn).

## Notes
- Parent PIN default is `1234`; change it in Parent Zone → Settings. The PIN
  lives in its own localStorage key, survives data resets, and is per-device.
- Points are fully parent-tunable in the Parent Zone with a live preview.
- Add `icon-192.png` and `icon-512.png` for the installed-app icon (optional).
- The app works offline and syncs when back online. If `sync.js` still has the
  placeholder keys, it runs fine as a local-only app (no cloud).

## Still recommended
Have Adelyn's clinician validate the reflection prompts, the "result" framing
(thoughtful vs. impulsive), and the coping-tool list — same as the handoff
advises for the OCD logic.
