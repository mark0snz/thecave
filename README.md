# The Cave — Player Board

Two-screen VR-arcade player board. The **phone** (Controller) types player names; the
**TV** (Display) shows them live. Sync runs through **Supabase Realtime** (one row per
arena/slot cell in the `players` table).

- **Frontend:** Vite + React
- **Backend:** Supabase (Postgres + Realtime)

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in the two values below
npm run dev
```

### Environment variables

Both are read at build time by Vite (must be prefixed `VITE_`):

| Variable                 | Where to find it                          |
| ------------------------ | ----------------------------------------- |
| `VITE_SUPABASE_URL`      | Supabase → Project Settings → API → URL   |
| `VITE_SUPABASE_ANON_KEY` | Supabase → Project Settings → API → anon  |

`.env.local` is gitignored and never committed. The `anon` key is a public,
browser-safe key by design.

## Deploy

Set the same two environment variables in the host's dashboard (Production + Preview),
then deploy. Framework preset: **Vite**.

### Hosting note

Vercel **Hobby** is non-commercial. Since The Cave is a business, the compliant options
are **Vercel Pro** ($20/mo) or **Cloudflare Pages** (free, commercial use allowed) —
same Supabase backend either way.

### Keeping Supabase awake

The Supabase free tier pauses after ~7 days of no DB activity. Regular venue use keeps
it awake; for guaranteed uptime, add a daily ping (cron / uptime monitor).
