# Spec: Settings platform (TruePin) - schema normalization, sync hardening, export/import, silent update applier

Class: feature · Advisor score: 8/10 - mirrors the TrueTabs settings-platform + update-applier design (customer's answers there carry over verbatim); TruePin additionally lacks schema normalization entirely, the exact bug class that produced TrueTabs' broken-options incident (lesson update-stale-state) · Approval: pending (batch 2026-07-19)

Design lineage: `~/Projects/truetabs/docs/specs/settings-platform.md` and `update-applier.md`. This spec is self-sufficient for the TruePin builder; shared decisions are restated, not referenced.

## Current facts (verified 2026-07-19)
- `settings` live in `storage.sync`, read as `{...DEFAULTS, ...settings}` - unknown keys survive reads by accident of the spread, but nothing validates types/enums, and there is no rename map.
- Named snapshot sets: `storage.sync` (cross-device by design); autosave ring (last 10): `storage.local`; canonical pinned set: `storage.local` (per-device working state); per-tab/group state: `storage.session`.
- `onInstalled(details)` exists with a version-gated canon heal (`canonHealVersion`) - a migration hook already in place.
- No `onUpdateAvailable`, no `runtime.reload`, no export/import. No secrets anywhere (no API keys) - export is clean by construction.

## Goal block
- What must exist: (1) every settings read passes schema normalization (types, enums, rename map - idempotent); writes preserve unknown future keys (a newer version's keys survive an older version's write on another machine); (2) options page offers Export/Import of a JSON file covering settings + named sets; (3) a pending CWS update applies at the first quiet moment, silently - no "update ready" UI; (4) README states what syncs (settings, named sets) and what stays local (autosaves, canonical pinned set, per-tab state).
- How we verify: e2e - unknown-keys survival through a settings write; export-wipe-import round-trip restores settings + sets exactly; simulated `onUpdateAvailable` reloads only when quiet; state survives worker reload byte-identical.
- Do not touch: what lives where (sets sync, autosaves and canon stay local - the per-device split is deliberate); mirror/restore engines; lock semantics.
- Stop/pause when: any update-notification UI temptation (rejected in the shared decision); any pressure to sync the canonical pinned set (per-device by design - different machines legitimately pin different sets).

## Question round
| Question | Customer answer |
|---|---|
| - | No new questions: the customer answered these forks in the TrueTabs round (2026-07-19) - silent background update without a button; export/import as a file; "safe sync" = secrets never sync (TruePin has none; the principle still guards future keys). Recorded explicitly: вопросов нет. |

## Scope and non-goals
- In scope: `normalizeSettings` for TruePin (DEFAULTS-driven validation + rename map, called on every read, write-back on install); forward-compat `writeSettings` merge helper as the single write path; export/import UI in options; update applier with quiet-moment gates; README sync section.
- Non-goals: exporting autosaves or the canonical set (device-local working state; restoring another machine's canon is exactly the mass-duplication class v3.8.0 killed - never); any second settings writer; update UI.

## Design
- Normalization: `normalizeSettings(raw)` validates each DEFAULTS key (booleans boolean, enums in range, strings capped), maps renamed keys (empty map today - the hook matters), passes unknown keys through untouched. Called in `getSettings`; `writeSettings(patch)` = raw read, overlay normalized known keys, preserve unknowns, single serialized write. Options save path routes through it.
- Export: `truepin-settings-<version>-<date>.json` - `{format:"truepin-settings", schema:1, version, exportedAt, settings, sets}` (named sets from sync; no secrets exist so no opt-in machinery). Import: format-marker check, normalize, confirm summary (N settings, M sets, K urls), single serialized apply; oversize cap 256 KB (sets carry urls); readable rejects.
- Update applier: `onUpdateAvailable` sets a session flag and tries `tryApplyUpdate()`: no restore/mirror convergence in flight (`mirrorReady` true and no pending creates), no open extension pages (`runtime.getContexts`), then `runtime.reload()`; otherwise the existing periodic paths retry while the flag lives. Post-reload safety exists (cold bootstrap + session rebuild); the survival test makes it proven, not assumed.
- Sets import merge rule: imported sets REPLACE same-named sets, add new ones, never delete unmentioned ones (import is additive-by-name, stated in the confirm dialog) - the trap "import wiped my other machine's sets" is designed out.

## Interaction matrix
| Existing feature | Intersection | Resolution |
|---|---|---|
| Chrome sync of `settings`/sets | Import writes propagate to other devices | By design; confirm dialog says so |
| Autosave ring | Import could be undoable? | Untouched by import (local, device-own); no interaction |
| Canon heal on install | Update applier reload triggers onInstalled path | Heal is version-gated - idempotent; no double-heal |
| Mirror cold start | Reload mid-restore would cascade | `mirrorReady` gate blocks apply during convergence (mirror-cold-start lesson) |
| Family interop (sibling spec) | Broadcast channel during reload | Messages during the gap are lost by design; TrueTabs re-queries on its side - contract already tolerates absence |
| lockToFront enforcement | Reload mid-enforce | Debounced enforcement re-arms on bootstrap; no persisted in-flight state |

## Data deltas
- No new persisted keys; format doc `schema:1` inside the export file; `storage.session.updatePending`.

## Edge cases (with resolutions)
- Import from a newer TruePin: unknown settings keys preserved dormant; `schema>1` - "importing what this version understands".
- Import while restore is converging: serialized behind the same queue; applier gates independently.
- Set name collision differing only by case: exact-name match (case-sensitive, as sets are today).
- Corrupt file: readable reject, nothing partial (single atomic apply).

## Behavior-test table
| Behavior | Test name |
|---|---|
| Unknown future keys survive a settings write | platform: forward-compat merge |
| Type/enum garbage in stored settings normalizes on read | platform: normalize on read |
| Export-wipe-import restores settings + sets exactly | platform: export-import round-trip |
| Import replaces same-named set, keeps unmentioned sets | platform: import additive by name |
| Import rejects wrong format marker readably | platform: import rejects foreign json |
| Quiet moment: simulated onUpdateAvailable reloads | platform: update applies when quiet |
| Mid-restore: apply deferred until mirrorReady | platform: update waits for mirror |
| Settings + sets + canon survive worker reload byte-identical | platform: state survives reload |

## Build order
1. normalizeSettings + writeSettings + rewire writers, tests 1-2 - done when: suite green x2.
2. Export/import UI + engine op, tests 3-5 - done when: suite green x2.
3. Update applier + gates, tests 6-8 - done when: suite green x2.
4. Docs: README "Sync between browsers" section (what syncs / what stays local), locale strings, store-texts sweep - done when: sweep clean.

## Risks and open questions
- None material; pre-mortem: a normalization bug could "correct" a legitimate stored value - countered by test 2 fixtures drawn from every DEFAULTS key and the round-trip test.
