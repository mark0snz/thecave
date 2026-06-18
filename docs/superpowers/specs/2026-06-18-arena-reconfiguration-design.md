# The Cave — Arena Reconfiguration (Pod Lending) — Design

**Date:** 2026-06-18
**Status:** Approved, ready to build

## Problem

A team can have more players than its arena has pods (e.g. 6 players, 4 pods).
Overflow players must physically occupy spare pods in another arena, while still
being shown as members of their own team.

## Core concept: pod ownership

Every physical pod (`arena` + `slot`) gains an **owner** — the team it belongs to.

- `owner = null` → pod belongs to its native arena (normal case).
- `owner = '<team>'` → pod is claimed by that team (e.g. `'blue'`).
- **Effective owner** of a pod = `owner ?? arena`.

Ownership is a colored indicator only. It never moves or clears names; names and
ownership are independent.

## Data model

Add one nullable column to `public.players`:

```sql
alter table public.players add column if not exists owner text
  check (owner is null or owner in ('red','green','blue'));
```

No backfill, no RLS change, no realtime change: `replica identity full` + the
table-level anon SELECT/UPDATE policies already cover the new column, and full-row
realtime payloads will include it.

Board state grows a parallel map:

```js
board = {
  arenas: { red:[name×4], green:[…], blue:[…] },   // unchanged
  owners: { red:[owner|null ×4], green:[…], blue:[…] }, // new
}
```

## Sync layer (`useBoard`)

- Initial load selects `arena,slot,name,owner`; fold `owner` into `owners`.
- Realtime handler patches both `name` and `owner` for the changed cell. The
  existing typing guard applies to `name` only; `owner` always applies immediately.
- New `setOwner(arena, slot, owner)` → immediate (non-debounced) `update({owner})`.
- `setPlayer` unchanged (writes `name` to the physical cell).
- `clearArena(team)` clears the **names** of every pod whose effective owner is
  `team` (native pods + claimed pods). Ownership is left unchanged.
- Return contract becomes `{ board, setPlayer, setOwner, clearArena, status, lastSynced }`.

## Controller — Reconfigure mode

- A **"Reconfigure"** button sits next to "Clear arena" on the current arena's tab.
- Tapping it (while on team T) opens a screen titled **"Assigning pods to <T>"**,
  showing all three arenas stacked, each as its 4-pod grid.
- **Every pod is tappable** (no disabled states). Tapping toggles ownership:
  - if effective owner == T → set `owner = null` (release to native);
  - else → set `owner = T` (claim).
- Pods render colored by effective owner so the operator sees the live picture.
- A **Done** button returns to the normal controller.

## Controller — arena tabs after claiming

- **Team T's tab** shows its 4 native pods, **plus an extra editable square for each
  pod it has claimed elsewhere**, labelled with the pod's physical home (e.g. `RED · 2`).
- A native pod that has been **claimed by another team** shows **tinted in that team's
  color** (e.g. a Blue-tinted pod on the Red tab). It stays **editable** — nothing is
  locked. The extra square and the tinted square edit the same underlying pod.

## TV (Display) + controller mini-board — visual

**Outline only** (matches the mockup): a claimed pod renders in its physical arena,
keeps its physical-arena number color, and gains the **owning team's colored border**.
Name shows as normal text. Same treatment in the controller mini-board.

## Edge cases / rules (kept simple)

- Claiming/releasing only changes color; names are never moved or cleared.
- Claiming a pod that already has a name is allowed (that name becomes the claiming
  team's player). Releasing leaves the name with the now-native pod.
- "Clear arena" clears names of all pods belonging to the team (native + claimed);
  ownership unchanged.

## Out of scope

- No disabling/validation of which pods can be claimed.
- No locking of fields.
- No per-team capacity limits beyond the 12 physical pods.
