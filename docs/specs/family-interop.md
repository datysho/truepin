# Spec: Family interop - TruePin side (locked-front protocol + group respect)

Class: feature · Ships together with TrueTabs (canonical joint spec with full contract, diagnosis, matrices: `~/Projects/truetabs/docs/specs/family-interop.md` - single source across the boundary; this file carries only TruePin's own build slice) · Approval: pending (batch 2026-07-19)

## Goal block
- What must exist: TruePin answers the family protocol (who is locked-front, in which mode), broadcasts changes, and stops yanking locked tabs out of groups the user placed them in. `lockToFront` semantics otherwise unchanged.
- How we verify: TruePin suite - responder answers the contract shape; a locked tab inside a user group is not re-moved by "always" enforcement; TrueTabs' dual-extension suite passes the no-oscillation contract.
- Do not touch: mirror engine, restore/canonical converge, snapshots, lock semantics, split-view handling.
- Stop/pause when: protocol pressure beyond the single `family:lockedFront` message family.

## Protocol v1 (contract, mirrored from the canonical spec - keep in sync)
- `onMessageExternal` accepts ONLY sender ids in `FAMILY_IDS` (TrueTabs CWS id + dev-key id) and ONLY `family:*` types; everything else ignored silently.
- `{v:1, type:"family:lockedFront:get"}` - reply `{v:1, tabIds:number[], mode:"off"|"onLock"|"always"}` (ids only in "always").
- Broadcast `{v:1, type:"family:lockedFront:changed", tabIds, mode}` on lock/unlock, mode change, post-debounce enforced move, startup.
- Unknown `v`/`type`: ignore. Send failures: swallow (sibling absent).

## Changes
1. Responder + broadcaster in `background.js` (piggyback on the existing 200 ms enforce debounce for storm coalescing).
2. Group respect: `enforceLockedFront` and `moveLockedToFront` skip tabs with `groupId !== -1` (user grouped a locked tab = page protection stays, front-pull stops; re-enters the zone when ungrouped). Same exemption pattern as split-view tabs.
3. `FAMILY_IDS` constant; release-checklist line: fill TrueTabs' CWS id after its publication.

## Behavior-test table
| Behavior | Test name |
|---|---|
| Responder returns contract shape with correct ids/mode | family: responder shape |
| Broadcast fires on lock, unlock, mode change | family: broadcasts on change |
| Locked tab inside a user group is not re-moved in "always" | family: group respected |
| Alien sender / alien type ignored | family: router allowlist |

## Build order
1. Group-respect fix + test 3 (red on old code) - done when: suite green x2.
2. Responder/broadcaster + tests 1-2, 4 - done when: suite green x2 (42 existing + 4 new).
3. Joint verify against TrueTabs dual-extension suite - done when: no-oscillation contract green there.
4. Release as v3.12.0 together with the TrueTabs side.

## Risks
- Covered in the canonical spec (id drift, third movers). Nothing TruePin-specific beyond keeping the mirrored contract block in sync - a checklist line guards it.
