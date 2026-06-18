# The Cave — Groups (Reconfigure: Arenas / Groups toggle) — Design

**Date:** 2026-06-18
**Status:** Approved, ready to build (grouping only; session timers are a follow-up)

## Problem

An arena is sometimes shared by separate bookings — one group may take a whole
arena (4 pods) or just a couple of pods, and two groups may share one arena.
Looking ahead, play-session times are tracked **per group**, so we need a way to
mark which pods form a group.

## Approach

Reuse the existing tap-to-select Reconfigure tool. The button is renamed
**"Reconfigure"** and gains a top toggle:

- **`Arenas`** — unchanged: tap pods to lend them between arena-teams (overflow).
- **`Groups`** — tap pods to assign them to the **active group**.

A pod belongs to at most one group. Grouping is independent of arena ownership.

### Group chips (Groups mode)

- A row of group chips, each its own color, plus an **Add group** affordance.
- One chip is **active**; tapping a pod toggles it into/out of the active group.
- The active chip has a small **×** to disband (clears that group from its pods).
- Visible chips = groups currently in use ∪ the active group. "Add group" makes
  the next unused group active (cap 6).

### Colors

Groups use a palette **distinct** from the Blue/Red/Green arenas:
`#f59e0b, #a855f7, #ec4899, #06b6d4, #84cc16, #f97316` (Group 1–6).

## Data model

Add a nullable column to `public.players`:

```sql
alter table public.players add column if not exists group_id int
  check (group_id is null or group_id between 1 and 6);
```

- `group_id = null` → ungrouped. `1..6` → that group.
- Synced like `owner`: covered by existing replica-identity-full + anon policies.
- Board state gains `groups: { red:[gid|null ×4], green:[…], blue:[…] }`.
- Graceful fallback: if the column is missing (migration not yet run), grouping
  works locally (optimistic) and is skipped on writes — same pattern as `owner`.

## Sync layer (`useBoard`)

- Load selects `…,owner,group_id`; layered fallback (owner-only, then name-only).
- Realtime patches `group_id` alongside name/owner.
- New `setGroup(arena, slot, groupId)` — immediate update, optimistic, skipped if
  the column is absent.
- `clearArena` unchanged (clears names by effective owner; leaves groups).
- Contract: `{ board, setPlayer, setOwner, setGroup, clearArena, status, lastSynced }`.

## Display

Each pod in a group shows a **small colored `G#` tag** (group color) in a corner,
so staff can see bookings at a glance. (The session countdown will attach to the
group in the next phase.) Arena/owner visuals are unchanged.

## Out of scope (next phase)

- Session start/duration + countdown timer per group.
- Showing groups on the controller's normal arena tabs (kept clean; managed in
  Reconfigure for now).
