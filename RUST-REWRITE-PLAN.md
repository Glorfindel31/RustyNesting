# Deepnest → Rust/Tauri Rewrite: Master Plan

## Context

Deepnest is currently an Electron app. This session found and fixed several real
bugs that trace back to one root cause: Electron forces multi-process isolation
with no shared memory, so the nesting engine's parallel workers (up to 8 hidden
`BrowserWindow`s) have to coordinate entirely through IPC — a shared NFP geometry
cache had to be manually relayed and batched to avoid flooding the main process,
and a race between two IPC consumers competing for the same fixed window pool
could silently drop work and hang the whole app forever. These aren't bugs in the
nesting algorithm; they're the tax of the process model.

The user wants to eliminate that tax by rewriting the engine in Rust with a Tauri
shell, keeping the existing HTML/CSS/Ractive frontend nearly unchanged (a visual/
feature copy, not a redesign). GPU acceleration was considered and explicitly
dropped — NFP computation is branch-heavy, a poor GPU fit, and would require an
entirely different (rasterized) algorithm, too speculative to bundle into this
project. Estimated at 2-4 months solo-dev for full parity plus the architectural
win of real shared-memory threading (rayon) replacing IPC-coordinated processes.

This plan is the result of three parallel codebase surveys (core engine, UI
layer, vendored/native dependencies) followed by a dedicated design pass. It's
meant to be followed across many future sessions with no memory persistence
between them, which is why a living tracking doc is part of the deliverable, not
an afterthought.

## Decisions already made (do not relitigate)

- Rust + Tauri, existing frontend reused as-is where it has no Electron-API
  dependency (confirmed: Ractive/CSS/vendored JS libs are all Electron-free).
- No GPU/Vulkan work in this project.
- Clipper2's official Rust FFI bindings over reimplementing polygon clipping —
  the current app uses Clipper1 (old JS port), so this is an upgrade.
- New repo lives at a **separate sibling folder**, `F:\04 - DEV FOLDER\deepnest-rust\`
  — not nested inside the Electron repo, which stays clean for potential upstream
  PRs of this session's bug fixes. Claude can still read the Electron repo by
  absolute path for reference throughout.

## Repo structure

```
deepnest-rust/
  Cargo.toml                     # workspace root
  crates/
    geometry/                    # pure geometry math, zero I/O, zero threading
    nesting/                     # NfpCache, GA, placement, rayon dispatch, event abstraction
  src-tauri/                     # Tauri commands, event wiring, window setup — no nesting logic
  frontend/                      # ported main/ui/**, index.html, style.css, vendored libs as-is
  docs/
    PORT_STATUS.md               # the one living tracking doc (see below)
  tests/
    fixtures/                    # SVGs/part-sets from the Electron repo's benchmark sweeps
```

Two lib crates, not four — `geometry` is everything fuzzable/unit-testable in
isolation (Clipper2 wrapper, NFP-tracing algorithm, SVG polygonify); `nesting` is
everything stateful/concurrent (cache, GA, placement, rayon, progress events).
Splitting further is speculative structure with no current consumer — merge
tighter or split further only if this proves awkward in practice.

## Phases

Each phase lists what gets built and why that order — later phases depend on
earlier ones being real, not just planned.

**Phase 0 — Scaffolding (2-4 days).** Cargo workspace; verify the Clipper2 Rust
binding actually builds/links on Windows (fail fast if not); bare Tauri shell
serving the copied frontend with zero real commands, to confirm it renders
unmodified in a webview; seed `docs/PORT_STATUS.md` with the full file inventory
below, every row "not started."

**Phase 1 — Geometry core (1.5-2 weeks).** Point/polygon primitives, the
Clipper2 wrapper (offset, boolean ops, `SimplifyPolygon`+`CleanPolygon`, `Area`),
the custom RDP-simplify post-process (offset-shell re-merge, exterior-point
reversal, axis straightening, `.exact` marking), SVG import (DOM → polygon tree,
parent/hole detection, `.isCircle` metadata, oversized-part bbox check), and
`geometryutil.js`'s NFP-tracing primitives (`noFitPolygon`, `noFitPolygonRectangle`,
slide/projection distance, search-start-point, polygon hull). Port
`tests/geometry.spec.ts` cases as Rust unit tests *as each function lands*, not
in a batch at the end — they're the correctness oracle.

**Phase 2 — NFP engine, including the hardest sub-problem (1.5-2 weeks,
budget slack expected).** Outer NFP via Clipper2 Minkowski sum; ONE unified
cache-key implementation (today it's duplicated between `nfpDb.ts` and
`main.js` — collapse to one function), preserving the exact `%360` / `>=`
rotation-normalization boundary. Inner NFP's three fast paths in the same
priority order as today: circular-hole exact disk math (port
`verifyCircularHoleNfp.js`'s brute-force check alongside it), rectangular-
container fast path, then the general fallback — **the general fallback
(containment NFP against a container with holes) is the one piece of the whole
project with no existing correct reference to copy**, since the current native
addon it replaces is confirmed buggy. Do this now, not deferred, while there's
still schedule slack to absorb a surprise. If the timebox runs out, the interim
option is shelling out to the existing (buggy-but-shipping) native addon only
for this one case, tracked explicitly in `PORT_STATUS.md` as temporary debt —
not silently permanent scope creep.

**Phase 3 — Single-threaded placement + first end-to-end milestone (3-5
days).** Port `placeParts`'s greedy per-sheet loop, `tryPlacePartOnSheet`
(batched-holeless-obstacle subtraction, deferred-validation scoring), the three
placement-type scorers. **Explicitly resolve the NaN-fitness gap**: today
`fitness += minwidth/sheetarea + minarea` silently becomes `NaN` when 0-1 parts
land on a sheet (those variables are only assigned in the ≥2-parts branch) —
decide and document what that contribution should actually be; this is a real
scoring decision the GA depends on, not a type-system accident to paper over.
**Milestone: one rectangle placed on one sheet, single individual, no GA, no
threads, rendered in the Tauri shell.** This is the earliest point the whole
stack (geometry → NFP → placement → visible output) is provably correct
end-to-end, before betting the GA/concurrency architecture on top of it.

**Phase 4 — Concurrency model + GA orchestration (1.5-2 weeks).** This is the
second hardest sub-problem: replacing Electron's multi-`BrowserWindow` worker
model. Recommendation: **rayon for compute, nothing else** — the per-individual
placement work is CPU-bound and embarrassingly parallel, exactly rayon's design
target. Concretely: `NfpCache` becomes one shared structure behind a lock
(sharded map or plain mutex — verify contention before reaching for anything
fancier), which also makes the old IPC-flood problem (~7500 buffered inserts per
individual) simply not exist anymore, not something needing its own workaround.
The 100ms-poll dispatch loop becomes one task dispatching a `rayon::scope` per
generation and blocking on completion — a real improvement, not just a
mechanical port. The window-pool-starvation race and its two different failure-
recovery paths don't get ported as code — a proper thread pool doesn't have that
failure mode by construction — but the *invariant* they protected (every
individual always reaches a terminal outcome) gets a new test against the rayon
dispatcher. Progress/log events cross from rayon closures into Tauri's tokio
event loop via a plain channel (`crossbeam`/`std::sync::mpsc`) — the one
genuinely new piece of plumbing in the project, design it deliberately. Also
port the `GeneticAlgorithm` class (elite-seed `population[0]`, the three
mutate operators including the rotation-reroll rate cap that fixed this
session's NFP-cache-thrashing bug, OX crossover, roulette selection),
`widenRotationsIfStalled`/`refineStalledBest`, `isBetterNest`. Preserve the
rotation-angle-grid quirk (rotations=6 producing bad angles for rectangular
parts — confirmed this session via a 60-run empirical sweep) as a user-facing
config, and add a warning for non-90-degree-friendly rotation counts while the
finding is fresh. Port `ga-seeding.spec.ts`/`refine-stagnation.spec.ts`.

**Phase 5 — Shared cache + consolidation (1 week).** `NfpCache` as the single
shared structure from Phase 4 (no more per-window/buffered-flush design).
`refineConsolidation` (sparsest-sheet-first ranking, smallest-part-first
ordering fix, 15-target-sheet cap, the 2000ms deadline — keep hardcoded, don't
add a speculative config surface for it yet). Port `refine-consolidation.spec.ts`.

**Phase 6 — Tauri command layer + frontend wiring (1-1.5 weeks).** Replace the
BACKGROUND_* IPC channels with Tauri commands + `emit()` events — the one
"redesign, not port" point in the UI layer, treat it as such. Config/preset
services are near-mechanical (already thin IPC wrappers). Extract and re-test
`dispatch-recovery.spec.ts`'s invariant (every dispatch always terminates)
against the new dispatcher rather than porting the Electron-specific test code.

**Phase 7 — Import/export, dialogs, DXF, crash recovery (1 week).** Tauri
dialog/fs commands replacing `@electron/remote`. DXF conversion keeps using the
existing remote HTTP service (`converter.deepnest.app`) via `reqwest` — no
local DXF parsing needed, same as today. Port the crash-recovery mechanism
(serialize/deserialize SVG elements to strings, same pattern already built and
tested this session) and `export-recovery.spec.ts`.

**Phase 8 — Remaining UI wiring + benchmark logging (3-5 days).** Parts-view,
sheet-dialog, nest-view. Port `benchmarkLogger.js` (git-tagged, dual-file,
5MB-rotated CSV logging) — it's what produced this session's four empirical
tuning sweeps and stays useful for tuning the Rust engine the same way.

**Phase 9 — Parity verification, perf, packaging (1-2 weeks).** Differential
runs against the still-running Electron app on the same benchmark SVGs (see
Verification below). Confirm rayon actually saturates cores better than the
8-window Electron cap — verify, don't assume. Tauri packaging/icons/installer.

Total: ~9-13 weeks within the 2-4 month (8-17 week) budget, leaving slack for
Phase 2 overrunning.

## What to deliberately not port (verified dead this session)

- `applyPlacement()` (main/deepnest.js:1775) — zero call sites repo-wide.
- `overlapTolerance` config field — zero references outside its own default.
- The on-disk `./nfpcache` directory and its delete-on-quit logic — no writer
  exists anywhere; it's already in-memory-only in practice.
- `main/util/simplify.js` — loaded via a script tag but no static call site
  found; do one more dynamic-usage check before dropping, since a script-tag
  load without an obvious call site could still be invoked reflectively.

Record each as an explicit "will not port — verified dead" row in
`PORT_STATUS.md` with the check that proved it, so a future session doesn't
waste time rediscovering the decision.

## Testing / parity strategy

- **Direct-port specs** (survive the rewrite unchanged): `geometry.spec.ts`,
  `ga-seeding.spec.ts`, `refine-consolidation.spec.ts`, `refine-stagnation.spec.ts`.
  Port each as its corresponding Rust module lands, not as a batch at the end —
  a module isn't "done" in `PORT_STATUS.md` until its ported spec passes.
- **Invariant-not-literal-port specs**: `dispatch-recovery.spec.ts`,
  `export-recovery.spec.ts` encode Electron-multi-window-specific bugs. Don't
  port the test code; extract and re-test the invariant each protects (always-
  terminates dispatch; always-round-trips recovery snapshot) against the new
  architecture.
- **Differential testing**: keep the Electron app running (not deleted, just
  superseded) and build one small headless CLI (`nest-cli --fixture X --seed N`)
  reusing `benchmarkLogger.js`'s existing CSV format, so both engines' runs land
  in directly diffable rows on the same fixtures. Compare unplaced-count/sheet-
  count/utilization statistically (the GA is stochastic, not bit-exact). One
  CLI, shared CSV format — no heavier framework, there's no second consumer that
  justifies one.

## Port-status tracking doc

One file, `docs/PORT_STATUS.md` — not one per subsystem, so a solo dev across
memoryless sessions has one place to search, not a directory to remember the
shape of. A markdown table per phase:

```
## Phase N — <name>
| Electron file/function | Rust module | Status | Notes / gotchas |
|---|---|---|---|
| main/deepnest.js: widenRotationsIfStalled | nesting::ga::widen_rotations | done | doubling preserves angle-grid subset property |
```

Seed it in Phase 0 with every file in the inventory below (status: not
started), plus the "will not port" rows and their verification. Add a "known
gotchas to preserve" section at the top listing the load-bearing quirks that
are easy to silently fix away during a port: the rotation-grid quirk kept
user-facing, the `>=` vs `>` rotation-normalization boundary, `Arotation:0`
hardcoded in inner-NFP cache keys, elitist `population[0]` always kept, the
mutation-rate cap on rotation-reroll specifically (not order-mutation) that
fixed this session's cache-thrashing bug.

## Critical files (Electron side, for reference throughout)

- `main/deepnest.js` — DeepNest class, GeneticAlgorithm, launchWorkers dispatch
- `main/background.js` — placeParts, NFP pipeline, refineConsolidation
- `main/util/geometryutil.js` — the NFP-tracing algorithm core
- `main/nfpDb.ts` — NfpCache key format/eviction
- `main.js` — IPC handlers, window pool, single-instance-lock
- `main/ui/**` — full service/component inventory already gathered this session

## Verification

- Phase 0: Tauri shell renders the copied frontend unmodified; Clipper2 binding
  builds on Windows.
- Phase 1-2: ported `geometry.spec.ts` cases pass as Rust unit tests; new
  brute-force containment-with-holes tests pass (no existing oracle for this
  one — write it fresh, same style as `verifyCircularHoleNfp.js`).
- Phase 3: the one-rectangle-one-sheet milestone actually renders in the Tauri
  window, not just passes a headless assertion.
- Phase 4-5: ported GA/refine specs pass; new dispatcher-invariant tests pass.
- Phase 9: differential CLI runs against Electron on real benchmark fixtures
  (the four sweep files already produced this session are ready-made fixtures)
  show comparable sheet counts/utilization, and a rayon perf run shows real
  core saturation versus the 8-window Electron cap.

## Handoff

This plan is delivered as a standalone file, `RUST-REWRITE-PLAN.md`, at the
root of the Electron repo (`F:\04 - DEV FOLDER\deepnest-main\`), for the user
to copy into the new `deepnest-rust` sibling repo once scaffolded.

**Letting a new Claude Code session (rooted in `deepnest-rust`) read the
Electron repo for reference:** no special setup is required for Claude itself —
Read/Grep/Glob take absolute paths and aren't sandboxed to the session's
starting directory, so a new session can `Read`/`Grep` anything under
`F:\04 - DEV FOLDER\deepnest-main\...` by full path regardless of where it was
launched. Two things worth doing to make this frictionless in practice:
1. Add a line to the new repo's `CLAUDE.md` naming the Electron repo's absolute
   path and noting it's the read-only reference implementation for this port
   (this plan file's "Critical files" section is a ready-made starting list).
2. If the new session's permission mode prompts on first access to a path
   outside its project root, approve it once — or pre-approve it by adding a
   read-access rule for that path in the new repo's `.claude/settings.json` if
   prompts should be avoided entirely.
