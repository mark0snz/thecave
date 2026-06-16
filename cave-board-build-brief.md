# The Cave — Player Board: Production Build Brief

Take the existing prototype (`cave-player-board.jsx`) and turn it into a deployed app
backed by Supabase Realtime, hosted on Vercel. **The UI is done and approved — do not
redesign it.** The only real change is swapping the sync layer: out goes `window.storage`
+ polling, in comes the Supabase client + Realtime subscriptions.

---

## Stack
- **Frontend:** Vite + React (the existing component, unchanged in look/behaviour)
- **Backend:** Supabase (Postgres + Realtime)
- **Host:** Vercel (Vite preset)

---

## Data model

The board is 3 arenas × 4 player slots = 12 cells. Use one table, one row per cell.

Keep the keys identical to the prototype so the UI needs no changes:
- arena keys: `red`, `green`, `blue`
- slots: `1`–`4` (the UI maps these into the quadrant order 2-TL, 3-TR, 1-BL, 4-BR)
- board shape in app state stays: `{ arenas: { red:[s1,s2,s3,s4], green:[...], blue:[...] } }`
  (array index `i` = slot `i+1`)

---

## Step 1 — Supabase (run in the SQL editor)

```sql
-- Table: one row per arena/slot cell
create table public.players (
  arena      text not null check (arena in ('red','green','blue')),
  slot       int  not null check (slot between 1 and 4),
  name       text not null default '',
  updated_at timestamptz not null default now(),
  primary key (arena, slot)
);

-- Pre-seed all 12 cells so the board always has a full set of rows
insert into public.players (arena, slot, name)
select a, s, ''
from unnest(array['red','green','blue']) as a,
     generate_series(1,4) as s;

-- Realtime: broadcast changes, and include full row in UPDATE payloads
alter table public.players replica identity full;
alter publication supabase_realtime add table public.players;

-- RLS: no user accounts, so allow the anon (browser) key to read + update.
-- Rows are pre-seeded, so we only need SELECT + UPDATE (no INSERT/DELETE).
alter table public.players enable row level security;

create policy "anon read"   on public.players
  for select to anon using (true);

create policy "anon update" on public.players
  for update to anon using (true) with check (true);
```

Then grab from **Project Settings → API**:
- Project URL
- `anon` public key

---

## Step 2 — App changes (Claude Code)

1. **Scaffold** a Vite React app and drop the existing component in as `src/App.jsx`
   (it already has a default export). Keep all JSX/CSS as-is.

2. **Install** the client:
   ```bash
   npm install @supabase/supabase-js
   ```

3. **Create `src/supabase.js`:**
   ```js
   import { createClient } from "@supabase/supabase-js";
   export const supabase = createClient(
     import.meta.env.VITE_SUPABASE_URL,
     import.meta.env.VITE_SUPABASE_ANON_KEY
   );
   ```

4. **Rewrite the `useBoard` hook** — same return contract
   (`{ board, setPlayer, clearArena, status, lastSynced }`), Supabase underneath:

   - **Initial load:**
     ```js
     const { data } = await supabase.from("players").select("arena,slot,name");
     // fold rows into { arenas: { red:[..4], green:[..4], blue:[..4] } }
     ```
   - **Realtime subscription** (drives the TV + the controller's mini-board, and the
     existing flash-on-change still works):
     ```js
     const channel = supabase
       .channel("players")
       .on("postgres_changes",
         { event: "*", schema: "public", table: "players" },
         ({ new: row }) => {
           setBoard(prev => ({
             arenas: {
               ...prev.arenas,
               [row.arena]: prev.arenas[row.arena].map(
                 (v, i) => (i === row.slot - 1 ? row.name : v)
               ),
             },
           }));
         })
       .subscribe((s) => setStatus(s === "SUBSCRIBED" ? "live" : "connecting"));
     // remember to supabase.removeChannel(channel) on cleanup
     ```
   - **Writes (controller `setPlayer`)** — debounce as now (~350ms), then:
     ```js
     await supabase.from("players")
       .update({ name, updated_at: new Date().toISOString() })
       .eq("arena", arena).eq("slot", slot);
     ```
   - **`clearArena`** — set `name=''` for that arena's 4 slots (don't delete rows).
   - **Drop** all `window.storage`, the polling interval, and the `local`/`hasStorage`
     fallback path. Map subscription/write outcomes to the existing `status` chip
     states (`live` / `saving` / `connecting` / `error`).

5. **Controller typing guard:** ignore an incoming realtime update for the exact cell
   the operator currently has focused, so a write echo can't overwrite mid-typing.
   (Track the focused `arena+slot`; skip applying that one cell.)

6. **Env file** `.env.local` (also add `.env*` to `.gitignore`):
   ```
   VITE_SUPABASE_URL=...
   VITE_SUPABASE_ANON_KEY=...
   ```

---

## Step 3 — Deploy to Vercel

1. Push the repo to GitHub.
2. Vercel → **New Project** → import the repo. Framework preset auto-detects **Vite**.
3. Add the two env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) under
   **Settings → Environment Variables** (Production + Preview).
4. Deploy. Open the URL on the TV (pick **Display**) and on a phone (pick **Controller**).

---

## Verification checklist (must all pass)

- [ ] Prod URL loads; role picker appears.
- [ ] TV in Display mode, phone in Controller mode.
- [ ] Type a name on the phone → it appears on the TV in ~1s, in the correct quadrant.
- [ ] Refresh the TV → names persist (loaded from the database).
- [ ] Clear an arena on the phone → those four cells empty on both screens.
- [ ] Supabase **Table editor** shows the live names in `players`.
- [ ] Status chip reads **Live** when connected; shows an error state if the network drops.

---

## Notes / decisions to record

- **Anon write access is open by design.** Anyone with the site URL can change names —
  acceptable for an internal venue board. If you ever want to lock it, the simplest path
  is a short passcode gate on the Controller, or move writes behind a Supabase Edge
  Function with a shared secret. (Reads/writes are scoped to this one harmless table.)
- **Supabase free tier pauses after ~7 days of no DB activity.** Regular venue use keeps
  it awake; for guaranteed uptime add a daily ping (cron/uptime monitor hitting the URL).
- **Vercel Hobby is non-commercial.** Since The Cave is a business, the compliant options
  are Vercel Pro ($20/mo) or hosting the static build on Cloudflare Pages (free, commercial
  use allowed) — same Supabase backend either way. Flagging so it's a conscious choice.
