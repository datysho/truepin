# CLAUDE.md

TruePin - Chrome MV3 extension that makes pinned tabs trustworthy: pins survive restarts and profile drift, resurrected duplicates heal themselves, a protected tab keeps its page (typed addresses and cross-domain links open beside it). Store package is built from `extension/`.

## Commands

- Test: `cd test && npm test` - run TWICE before any merge or release (flake control); 56 e2e scenarios against real Chrome for Testing.
- Standing red/green repros (chronic bug classes, keep them runnable): `npm run test:canon`, `npm run test:multiply`, `npm run test:resurrect`, `npm run test:crystallize`, `npm run test:pip` - each proven red on the version that had the bug.
- Assets (regenerate from the live extension; exact legal CWS sizes): `node test/shot-store.mjs` (1280x800 listing screenshots -> `store/screenshots/`), `node test/shot-promo.mjs` (440x280 + 1400x560 promo tiles, JPEG/no-alpha -> `store/`), `node test/shot-social.mjs` (social/hero previews). `shot.mjs`/`shot-redesign.mjs` are older eyeballing shots. Re-run the relevant one after any popup/options UI change - a readiness selector that names a since-removed element will break the shot (lesson: shot-social once hard-referenced #lockLabel).
- Package: `./package.sh` - guarded build: strips the dev key, single zip in `dist/`, asserts packaged manifest version matches source. Rebuild after ANY version bump.

## Process

Full pipeline (change classes, gates, release checklist): `~/Clemond/system/dev-process.md`.
Before dev work: read the Дистиллят of `~/Clemond/system/lessons/lessons-dev.md`; grep `~/Clemond/system/lessons/` for the symptom before fixing any bug.
Feature specs go to `docs/specs/` from now on (v3.x predates the spec-first practice); the spec is approved before build and is the single source across the boundary - divergence goes back into the spec.
Version bumps on EVERY landed change - patch for a fix, minor for a feature, major for a break. The version marks the build, not the shipment: waiting for a release day means two different builds answer to one number. A bump runs the package build in the same block of work (a stale zip is a store rejection).
Release: fill the "Submission checklist" in `STORE_LISTING.md`; dogfood and CWS submit are Michael's steps.

## QA invariants (non-negotiable, survive without the vault)

1. Every acceptance behavior has a named automated test; the spec's behavior-test table is the coverage report.
2. Every bugfix ships with a regression test proven to fail on the old code (red/green).
3. Platform limits (store field lengths, asset sizes) live in tests, not memory.
4. Suite runs twice green before merge/release; a flake is a bug, not a re-roll.
5. Test fixtures reach real-user magnitudes.
6. Chronic bug classes get standing repro scripts kept runnable (the four `test:*` repros above).

Plus: no fix without investigation (root cause + tested hypothesis); after 3 failed fixes in a row - stop, the class needs an invariant, not a fourth point-fix.

## Process overrides

None.

## Gotchas

- A recurring symptom is a STOP signal - fix the class with a by-construction invariant plus a circuit breaker, not another point-fix: the "restore 5 pins, get 31 tabs" saga survived four point-fixes until the invariant killed it (lesson recurring-class-needs-invariant).
- URL identity does not survive drift (redirects, params, restarts) - persistent canon records + one convergence engine + circuit breaker; no second mechanism beside it.
- Ownership/session state must survive worker restart for ALL record types, or features degrade invisibly (lesson ownership-must-survive-restart).
- Reconciliation must not react while the world is half-restored - settle-then-adopt behind the readiness gate (lesson mirror-cold-start-cascade).
- Defensive automation must be visible and one-click revocable; a user testing a feature by repetition must not accrue strikes (lesson invisible-safety-reads-as-broken).
- Unpacked extension id differs per machine - the pinned `key` keeps ids stable across devices and `package.sh` strips it for CWS (lesson extension-id-sync).
- When a feature is cut, sweep STORE_LISTING/PRIVACY/locale texts for drift (lesson store-texts-drift).
- No per-pin close button in the popup (decided 2026-07-21, tried and reverted across v3.13.0-3.14.0). Chrome dismisses the action popup on ANY active-tab change. Closing the pinned tab you are viewing forces a new active tab, so the popup always closes with it: "switch to a sibling first, then close" dismisses on the switch (and drops the close mid-await - the tab stayed open), and "close then chrome.action.openPopup" only re-opens a fresh popup (a visible blink). There is no "stays open" outcome, so we do not offer the button rather than ship either the disappear or the blink. To remove a protected pin: unpin it, then close. Closing a NON-active tab keeps the popup only because it does not change the active tab - that is the whole asymmetry.
- Full lesson corpus and registry: `~/Clemond/system/lessons/` (this repo's rows mostly in lessons-dev.md).
