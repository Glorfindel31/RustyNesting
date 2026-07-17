# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

**Phase 0 (scaffolding), Phase 1 (geometry core), and Phase 2 (NFP engine)
are done**, including the general-fallback inner-NFP case the plan flagged
as the hardest sub-problem in the project (see `docs/PORT_STATUS.md`'s
Phase 2 table for how - no frame trick, no native addon, composed from
already-ported Phase 1 pieces). **Phase 3's placement engine
(`nesting::placement::place_parts`/`try_place_part_on_sheet`, all three
placement-type scorers, the NaN-fitness gap explicitly resolved via
`Option<f64>`) is done and unit-tested** — single individual, no GA, no
threads, matching `docs/PORT_STATUS.md`'s Phase 3 table. Not yet done:
wiring a result into the Tauri shell for a visual render (that's Phase 6,
once real Tauri commands exist) and `config.mergeLines`'s edge-merge fitness
bonus (deliberately deferred, see the Phase 3 table's last row). **Phase 4
(concurrency model + GA orchestration) is mostly done**: `nesting::cache`
(shared `NfpCache`), `nesting::ga` (`GeneticAlgorithm`/`isBetterNest`), and
`nesting::dispatch` (rayon-based per-generation dispatch, replacing the
Electron app's 100ms-poll + per-window IPC model by construction — see the
Phase 4 table for what that eliminates outright rather than ports). Not yet
done: `widenRotationsIfStalled`/`refineStalledBest` (need a caller that
tracks stagnation across many `dispatch::run` calls — nothing wraps the
dispatch loop that way yet) and progress/log event plumbing (deliberately
deferred until Phase 6 gives it an actual consumer to design against; see
the Phase 4 table's last row for why). **Phase 5 (`nesting::consolidation`
— `refine_consolidation`/`recompute_totals`) is done.** Porting it reused
Phase 3's `try_place_part_on_sheet` as its own doc comment anticipated, and
in doing so surfaced and fixed a real latent panic risk in that function
(the Gravity/Box scoring branch assumed at least one already-placed part on
the target, which a relocation target isn't guaranteed to have). **Phase 6
has a first slice landed**: real `#[tauri::command]`s (`import_dxf`,
`run_nest` in `src-tauri/src/commands.rs`) wired to the actual engine
end-to-end, backed by an explicit DTO/serialization layer
(`src-tauri/src/dto.rs`) rather than putting `Serialize`/`Deserialize` on
`geometry`/`nesting` types directly. This is the "redesign, not port" point
the plan calls out: `run_nest` is one synchronous call running N GA
generations, replacing the original's per-individual `background-start`/
`background-response` IPC round trips to a pool of worker windows (there's
no separate worker process to message - `nesting::dispatch` already
parallelizes a generation in-process via rayon). **The frontend is now
wired too, but via a new minimal UI, not an adaptation of the legacy
one** - `frontend/index.html`/`app.js`/`app.css` were rewritten from
scratch (dark grey/brutalist, no framework) to call
`import_dxf_command`/`run_nest_command` directly; the legacy
`frontend/deepnest.js`/`ui/**` (~4700 lines, all Node/Electron-integrated)
are kept in the tree unreferenced, not deleted, not adapted - see the
"Build/run commands" section below for why that was the right call here.
Verified end-to-end manually against the real `FLAT.dxf` fixture (import →
role assignment → nest → rendered result). **Not done yet**: progress
events, and wiring `refine_consolidation` into `run_nest`. Always check
`docs/PORT_STATUS.md` first — it's the single living tracking doc for
what's ported and what's outstanding; don't re-derive status from
`RUST-REWRITE-PLAN.md` or by guessing from the file tree.

**Scope change partway through Phase 1 (see `docs/PORT_STATUS.md` for
detail): import/export is DXF only, not SVG.** The user's real files are
DXF with meaningful layers (cut/etch/drill), and layer identity must survive
import → nesting → export. SVG import (`svgparser.js`/`domparser.ts`) was
dropped entirely, not deprioritized. DXF import/export is native (the `dxf`
crate), not the old Electron app's remote-conversion-server round trip.
Hole/interior-feature nesting (e.g. drilled holes) stays fully in scope —
nothing about hole handling was simplified away, only the file format changed.

**Read `RUST-REWRITE-PLAN.md` in full before doing any work here.** It is the
master plan for a from-scratch Rust/Tauri rewrite of Deepnest (currently an
Electron app), covering repo structure, phase-by-phase scope, what to
deliberately not port, and the parity/testing strategy. Do not relitigate the
decisions it marks as already made (Rust+Tauri, no GPU, Clipper2 Rust FFI
bindings, rayon for concurrency, the `geometry`/`nesting` two-crate split,
the DXF-only scope change).

## Build/run commands

```
cargo build                        # whole workspace (geometry, nesting, src-tauri)
cargo test -p geometry             # geometry unit tests
cargo test -p nesting               # nesting unit tests
cargo run -p deepnest-tauri        # launch the Tauri shell (plain cargo run works;
                                    # frontendDist is static, no dev server/build step)
```

`tauri-cli` is installed (`cargo install tauri-cli`) for later use
(`cargo tauri build`/`cargo tauri icon`), but isn't required for `dev` —
the frontend has no bundler, so a plain `cargo run` embeds `frontend/` as-is.

**Resolved by replacement, not adaptation**: `frontend/index.html` used to
be the Electron app's original file (inline module script calling
`require("electron")`, which throws in the Tauri webview - no `require`
global there). It's now a small **new** hand-written UI
(`index.html`/`app.js`/`app.css`, dark grey/brutalist/no framework) that
calls `import_dxf_command`/`run_nest_command` directly via
`window.__TAURI__.core.invoke`. This was a deliberate choice, not a
default: adapting the legacy Ractive UI (`frontend/deepnest.js`,
`frontend/ui/**`, ~4700 lines) turned out to need far more than fixing one
`require()` line - `ui/index.js`'s own `initialize()` does 7 more
`require()` calls before anything else runs, several service files take an
`ipcRenderer` directly, and part of what that UI does (SVG file loading)
is for a feature the DXF-only scope change already dropped. Those legacy
files are kept in the tree, unreferenced, as reference only - see
`docs/PORT_STATUS.md`'s Phase 6 table for the full reasoning.

## Reference implementation (read-only)

The current Electron app being ported lives at a sibling path:
`F:\04 - DEV FOLDER\deepnest-main\`. It is **not** part of this repo and
should not be modified from here — Read/Grep/Glob can access it by absolute
path regardless of this session's working directory. Key files to reference
while porting (see the plan's "Critical files" section for the full list):

- `main/deepnest.js` — `DeepNest` class, `GeneticAlgorithm`, `launchWorkers` dispatch
- `main/background.js` — `placeParts`, NFP pipeline, `refineConsolidation`
- `main/util/geometryutil.js` — the NFP-tracing algorithm core
- `main/nfpDb.ts` — NfpCache key format/eviction
- `main.js` — IPC handlers, window pool, single-instance-lock
- `main/ui/**` — service/component inventory for the frontend being ported as-is

## Architecture

```
deepnest-rust/
  Cargo.toml                     # workspace root (geometry, nesting, src-tauri)
  crates/
    geometry/                    # pure geometry math, zero I/O, zero threading - see below
    nesting/                     # NfpCache, GA, placement, rayon dispatch, consolidation
                                  #   - depends on geometry; see module list below
  src-tauri/                     # Tauri v2 shell + commands (import_dxf, run_nest) -
                                  #   see module list below
  frontend/                      # index.html/app.js/app.css: new minimal UI (Phase 6), the
                                  #   only files actually served/referenced. deepnest.js,
                                  #   svgparser.js, ui/**, util/**, style.css are the original
                                  #   Electron app's files, kept unreferenced as reference only
                                  #   (see PORT_STATUS's Phase 6 table for why they weren't
                                  #   adapted instead)
  docs/
    PORT_STATUS.md               # the one living tracking doc — check this first
  tests/
    fixtures/                    # real DXF fixtures (FLAT.dxf, FLAT-struck.dxf) copied from
                                  # the Electron repo's benchmark assets
```

`crates/geometry/src/` modules (all with unit tests, see `docs/PORT_STATUS.md`
Phase 1 table for exactly what each ports from the Electron repo):
- `point.rs` — `Point` primitive
- `polygon.rs` — bounds/area/point-in-polygon/is-rectangle/rotate + the
  `almostEqual`/`onSegment`/`lineIntersect` helpers underneath them
- `nfp.rs` — the orbiting `noFitPolygon`/`noFitPolygonRectangle`/
  `polygonHull`/slide-projection-distance/search-start-point algorithm
- `circular_nfp.rs` — the circular-hole NFP fast-path disk-fit math
- `clipper.rs` — Clipper2 wrapper (`offset`, `clean_polygon`, boolean ops);
  see the module doc for the deliberate ×10^7 `PointScaler` precision choice
- `simplify.rs` — Douglas-Peucker point reduction
- `simplify_polygon.rs` — the bigger orchestration pipeline around it
  (offset-shell re-merge, exterior-point reversal, axis straightening)
- `hull_polygon.rs` — convex hull (Andrew's monotone chain)
- `dxf_import.rs` — DXF entities → layer-tagged polygon tree (replaces SVG
  import entirely, see the scope-change note above). Currently supports
  `LWPOLYLINE` (incl. bulge/arc segments), `CIRCLE`, full-sweep `ARC`. Bare
  `LINE`/partial-`ARC` networks that only form a closed profile once
  endpoints are chained together, the older `POLYLINE` entity, and
  `INSERT`/block expansion are deliberately not supported yet (would need a
  separate edge-graph-joining algorithm, not a smaller version of this one)
- `inner_nfp.rs` — `getInnerNfp`'s three-fast-path dispatch (circular-hole
  disk math, rectangular-container fast path, general fallback). The
  general fallback is the plan's flagged "hardest sub-problem" — see its
  module doc comment and `docs/PORT_STATUS.md`'s Phase 2 table for why the
  Electron app's own version (a buggy native addon reached via an artificial
  "frame trick") isn't what got ported here
- `clipper.rs` also has `outer_nfp` (Minkowski-diff-based outer/collision NFP)

`crates/nesting/src/`:
- `cache_key.rs` — the unified NFP cache-key format (was duplicated between
  `nfpDb.ts` and `main.js`, kept in sync by hand via a code comment)
- `placement.rs` — `placeParts`/`tryPlacePartOnSheet`: the single-threaded
  greedy per-sheet placement loop, all three placement-type scorers
  (gravity/box/convexhull), the NaN-fitness gap resolved via `Option<f64>`.
  Works directly in plain `Point` coordinates throughout (a real
  simplification vs. the original's manual Clipper-coordinate conversion —
  `geometry::clipper`'s boolean-op wrappers already scale internally and
  don't need caller-managed path winding). New composed geometry helper this
  needed: `geometry::obstacle_nfp` (ports `getOuterNfp`'s "A's holes are
  additional opportunities for B" logic). `config.mergeLines`'s edge-merge
  fitness bonus is deliberately not ported yet (optional scoring nicety,
  needs `.exact` point-marking `geometry::Point` doesn't carry)
- `cache.rs` — `NfpCache`: one shared `Mutex<HashMap<String, CachedNfp>>`
  (the original ran one independent, unshared cache per background window —
  a real change, not a 1:1 port) keyed by `cache_key::nfp_cache_key`,
  capped at `MAX_CACHE_ENTRIES = 50000`
- `ga.rs` — `GeneticAlgorithm`/`isBetterNest`. A gene is a part *id*
  (`usize`), not a reference to the part object (real design change —
  cloning full part geometry through hundreds of mutate/mate calls a
  generation would be real, avoidable cost; real part lookup by id is the
  caller's job). New dependency: `rand` (nothing else in the workspace
  needed randomness before this)
- `dispatch.rs` — `run_generation`/`run`: `rayon::par_iter()`-based
  per-generation evaluation, replacing the original's 100ms-poll +
  per-window-IPC dispatch loop by construction (rayon's parallel iteration
  is synchronous, so there's no polling, no `processing` flag, no hand-
  tracked worker-count). Skips re-placing an individual that already has a
  `fitness` (only ever the elitism-carried-over `population[0]`), matching
  the original and avoiding a real redundant placement computation. New
  dependency: `rayon` (already decided in `RUST-REWRITE-PLAN.md`)
- `consolidation.rs` — `refine_consolidation`/`recompute_totals`: relocates
  already-placed parts between already-open sheets after the fact (fixes
  the excess-sheet-usage the dominant-part-area shortcut in `place_parts`
  can cause), sparsest-sheet-first/smallest-part-first, capped by iteration
  count/target-sheets-tried/wall-clock deadline. Reuses
  `placement::try_place_part_on_sheet` for the actual relocation attempt -
  doing so surfaced and fixed a real latent panic risk in that function
  (see its own doc comment)

`src-tauri/src/`:
- `dto.rs` — the serialization boundary (`PointDto`/`PolygonDto`/`PartDto`/
  `NestConfigDto`/...) between Tauri's IPC surface and `geometry`/`nesting`'s
  internal types. Deliberately a separate conversion layer instead of
  deriving `Serialize`/`Deserialize` on the internal types directly - those
  crates are I/O-free by design. `expand_parts` mirrors `launchWorkers`'s
  per-quantity id assignment + decreasing-area seed sort
- `commands.rs` — `import_dxf`/`run_nest`: plain, Tauri-runtime-free
  functions (unit-tested directly, no Tauri harness needed), each wrapped by
  a thin `#[tauri::command]`. `run_nest` is one synchronous call running N
  GA generations - the "redesign, not port" collapse of the original's
  per-individual `background-start`/`background-response` IPC round trips
  to worker windows, since `nesting::dispatch` already parallelizes a
  generation in-process via rayon

Only two lib crates by design: `geometry` is everything fuzzable/unit-testable
in isolation; `nesting` is everything stateful/concurrent. Don't split further
speculatively — the plan explicitly calls this out as a decision to revisit
only if it proves awkward in practice, not up front.

## Load-bearing quirks to preserve when porting

These are easy to "fix" away during a port but are confirmed-correct
behaviors the current app depends on (see plan for full context):

- Rotation-angle-grid quirk: `rotations=6` produces bad angles for
  rectangular parts (confirmed via a 60-run empirical sweep) — keep
  user-facing as config, don't silently correct it.
- The `>=` vs `>` rotation-normalization boundary in NFP cache keys.
- `Arotation:0` hardcoded in inner-NFP cache keys.
- Elitist `population[0]` always kept in the GA.
- The mutation-rate cap on rotation-reroll specifically (not order-mutation)
  — fixed an NFP-cache-thrashing bug found this session.
- The NaN-fitness gap in `placeParts` scoring (0-1 parts on a sheet) needs an
  explicit decision during Phase 3, not a silent type-system patch-over.
- `geometryutil.js`'s `_onSegment` vertical-line branch does a real 3-argument
  `Math.max(B.y, A.y, tolerance)`/`Math.min(...)` (tolerance competes as a
  value, not just an epsilon) while the horizontal-line branch uses a plain
  2-argument version — asymmetric, looks like a typo, preserved exactly.
- `polygonHull`'s backward vertex scan is missing `+Aoffsety` on one
  comparison that the otherwise-identical forward scan includes — preserved
  exactly in `geometry::nfp::polygon_hull`.
- `noFitPolygon`'s `marked`-reset loops start at index 1, never resetting
  index 0 — preserved exactly.

## Verified dead code — do not port

- `applyPlacement()` (`main/deepnest.js:1775`) — zero call sites repo-wide.
- `overlapTolerance` config field — zero references outside its own default.
- The on-disk `./nfpcache` directory and its delete-on-quit logic — no writer
  exists; already in-memory-only in practice.
- `HullPolygon.area`/`centroid`/`contains`/`length` — only `.hull()` has real
  call sites anywhere in the Electron repo.
- `main/util/eval.ts` — live, but only as `main/util/parallel.js`'s
  child-process worker entrypoint; dropped because that whole worker model
  is what Phase 4's rayon dispatcher replaces, not because it's unused.
