# Port Status

The one living tracking doc for the Electron → Rust/Tauri rewrite. See
`RUST-REWRITE-PLAN.md` at the repo root for phase scope/ordering and the
full rationale behind each decision below. Update a row's status the moment
its corresponding Rust module lands and its ported spec (if any) passes —
don't batch updates to the end of a phase.

**Scope change, mid-Phase-1:** the user's actual files are DXF with
meaningful layers (cut/etch/drill/etc.), not SVG. Import/export is now DXF
only, native (the `dxf` crate), with layer identity preserved end-to-end and
DXF export added as new scope the Electron app never had. SVG import
(`svgparser.js`/`domparser.ts`) is dropped from this project entirely — see
the "Dropped from scope" section below instead of "not started." Hole/
interior-feature nesting (e.g. drilled holes) stays fully in scope — nothing
about hole handling was simplified away, only the file format changed.

## Known gotchas to preserve (do not silently "fix" away during the port)

- Rotation-angle-grid quirk: `rotations=6` produces bad angles for
  rectangular parts (confirmed via a 60-run empirical sweep this session) —
  keep user-facing as config, add a warning for non-90-degree-friendly
  rotation counts (Phase 4).
- The `>=` vs `>` rotation-normalization boundary in NFP cache keys.
- `Arotation:0` hardcoded in inner-NFP cache keys.
- Elitist `population[0]` always kept in the GA.
- The mutation-rate cap on rotation-reroll specifically (not order-mutation)
  — fixed an NFP-cache-thrashing bug found this session.
- The NaN-fitness gap in `placeParts` scoring (`fitness += minwidth/sheetarea
  + minarea` only assigned in the ≥2-parts branch) — Phase 3 must make an
  explicit, documented scoring decision here, not paper over it.
- `geometryutil.js`'s `_onSegment` vertical-line branch calls
  `Math.max(B.y, A.y, tolerance)`/`Math.min(B.y, A.y, tolerance)` — a real
  3-argument max/min that includes `tolerance` (~1e-9) as a competing value,
  unlike the horizontal-line branch's plain 2-argument
  `Math.max(B.x, A.x)`/`Math.min(B.x, A.x)`. This asymmetry looks like a typo
  but changes behavior (e.g. `min(5, 10, 1e-9) = 1e-9`, not `5`) and is
  preserved exactly in `geometry::polygon::on_segment`.
- `polygonHull`'s backward vertex scan compares
  `_almostEqual(A[current].y, B[j].y+Boffsety)` — missing `+Aoffsety` on the
  A side, unlike the otherwise-identical forward scan just above it. Almost
  certainly an unintentional asymmetry in the original; preserved exactly in
  `geometry::nfp::polygon_hull` (see the `NB:` comment at that call site).
- `noFitPolygon`'s per-call `marked`-reset loops start at index 1, not 0
  (`for (i=1; i<A.length; i++) A[i].marked=false`) — index 0's `marked` flag
  is never reset by this function, only ever set. Preserved exactly in
  `geometry::nfp::no_fit_polygon`.

## Phase 0 — Scaffolding

| Item | Status | Notes / gotchas |
|---|---|---|
| Cargo workspace (`Cargo.toml`, `crates/geometry`, `crates/nesting`) | done | two-crate split per plan; geometry = pure/testable, nesting = stateful/concurrent |
| Clipper2 Rust FFI binding builds/links on Windows | done | `clipper2` crate (wraps `clipper2c-sys`, C++17 via MSVC) added to `geometry`; smoke-tested with a real boolean union |
| Bare Tauri shell serving copied frontend | done | Tauri v2 shell (`src-tauri/`), `frontendDist` points at `frontend/`, zero commands. Launched and screenshotted: static CSS/nav/icons render correctly; main content area is blank as expected since Ractive population depends on `window.DeepNest`, which never constructs — see Phase 6 note re: `require("electron")` in `index.html` |
| `docs/PORT_STATUS.md` seeded | done | this file |

## Phase 1 — Geometry core

| Electron file/function | Rust module | Status | Notes / gotchas |
|---|---|---|---|
| `main/util/point.ts` | `geometry::point::Point` | done | `marked: bool` added directly on `Point` (matches the JS field, used by NFP tracing) instead of a wrapper type |
| `main/util/vector.ts` | — | not started, deferred | not a dependency of anything ported so far (geometryutil.js uses plain `{x,y}` pairs, not the `Vector` class) |
| `main/util/matrix.ts` | — | dropped, see scope change | was deferred pending SVG-transform-string parsing; SVG import is now out of scope entirely, so this has no remaining consumer. DXF entities carry their own transforms (INSERT/block transforms) — revisit only if block-reference support is needed |
| `main/util/clipper.js` (Clipper1, JS port) | `geometry::clipper` (via `clipper2` crate) | not started | upgrade from Clipper1 → Clipper2, not a literal port; Phase 0 only proved the binding builds/links, no real offset/boolean-op wiring yet |
| Offset/boolean ops, `SimplifyPolygon`+`CleanPolygon`, `Area` | `geometry::clipper` | not started | |
| Custom RDP-simplify post-process (offset-shell re-merge, exterior-point reversal, axis straightening, `.exact` marking) | `geometry::simplify` | partially done | ported `main/util/simplify.js`'s actual Douglas-Peucker algorithm (`geometry::simplify::simplify`, both `geometry.spec.ts` cases passing) — but the larger "offset-shell re-merge/exterior-point reversal/axis straightening/`.exact` marking" pipeline this row describes is a separate, bigger post-process (likely in `deepnest.js`/`background.js`) not yet located or ported |
| **DXF import** (new scope, not a port — replaces SVG import): entities → polygon tree, layer tag preserved per polygon, parent/hole detection via containment, `.isCircle` metadata for `CIRCLE`/full-sweep `ARC`, oversized-part bbox check | `geometry::dxf_import` (via the `dxf` crate) | not started | native local parsing, not the old remote-conversion-server approach; see "Dropped from scope" for what this replaces |
| **DXF export** (new scope, Electron app never had this): write nested layout back out as DXF, reproducing each part's original layer | `geometry::dxf_export` or `nesting`/`src-tauri` (TBD when reached) | not started | Phase 7 scope, noted here since it's directly coupled to the import format decision |
| `main/util/geometryutil.js`: `noFitPolygon`, `noFitPolygonRectangle`, slide/projection distance, search-start-point, polygon hull | `geometry::nfp` | done | ported with unit tests (`crates/geometry/src/nfp.rs`); also ported the transitive dependencies `intersect`, `segmentDistance`, `pointDistance`, `pointInPolygon`, `onSegment`, `lineIntersect`, `almostEqual`, `polygonArea`, `getPolygonBounds`, `isRectangle`, `rotatePolygon` (`crates/geometry/src/polygon.rs`). Preserved quirks: `pointInPolygon`'s bolted-on-offset semantics reproduced via explicit `Point` offset params instead of JS's mutable array properties; `onSegment`'s asymmetric `Math.max(B,A,tolerance)` (vertical branch includes tolerance as a 3rd max/min candidate) vs `Math.max(B,A)` (horizontal branch, no tolerance) preserved exactly; `polygonHull`'s backward-scan y-comparison missing `+Aoffsety` (asymmetric vs. the forward scan) preserved exactly; `noFitPolygon`'s `marked` reset loops starting at index 1 (never resetting index 0) preserved. Deliberately **not** ported yet: `pointLineDistance`, `polygonEdge` — not a dependency of anything Phase 1 requires; deferred to Phase 3 (their only callers are placement-scoring code in `background.js`) |
| `main/util/HullPolygon.ts` | — | not started | still needed — hole/interior nesting stays in scope regardless of DXF-vs-SVG |
| `main/util/eval.ts` | TBD | not started | check for live call sites before porting (dynamic eval usage is a smell) |
| `main/util/verifyCircularHoleNfp.js` (disk-fit math only) | `geometry::circular_nfp` | done | ported `fastFitDisk`/`fitsAt` and all 4 brute-force `check()` cases as Rust tests (`crates/geometry/src/circular_nfp.rs`). The *production* `getInnerNfp` circular-hole fast path this verifies (`background.js:1886-1894` — DB cache lookup, `A.isCircle`/`B.isCircle` gating, `tessellateCircle` to turn the disk into an actual NFP polygon) is Phase 2 material, not ported yet — this row is only the exact disk-fit math the self-check exists to verify |
| `tests/geometry.spec.ts` | `geometry` unit tests | done | ported: `polygonArea`, `getPolygonBounds`, `almostEqual`, `polygonHull` (all 3 cases), `simplify` (both cases), and the `verifyCircularHoleNfp` self-check (as 4 separate Rust tests instead of one script-style run, since Rust has no direct equivalent of "require and let it throw") |

## Phase 2 — NFP engine

| Electron file/function | Rust module | Status | Notes / gotchas |
|---|---|---|---|
| Outer NFP via Minkowski sum | `geometry::nfp::outer` | not started | via Clipper2 Minkowski sum |
| NFP cache-key format (currently duplicated between `main/nfpDb.ts` and `main/main.js`) | `nesting::cache::key` | not started | collapse to ONE function; preserve `%360`/`>=` rotation-normalization boundary |
| Inner NFP: circular-hole exact disk math | `geometry::nfp::inner_circular` | not started | port `main/util/verifyCircularHoleNfp.js`'s brute-force check alongside it as a test oracle |
| Inner NFP: rectangular-container fast path | `geometry::nfp::inner_rect` | not started | |
| Inner NFP: general fallback (containment NFP, container with holes) | `geometry::nfp::inner_general` | not started | **no existing correct reference** — current native addon is confirmed buggy. Do this now per plan, not deferred. Interim fallback if timeboxed: shell out to the existing buggy addon, tracked here as explicit temporary debt |
| `main/nfpDb.ts` (NfpCache key format/eviction) | `nesting::cache` | not started | |

## Phase 3 — Single-threaded placement (first end-to-end milestone)

| Electron file/function | Rust module | Status | Notes / gotchas |
|---|---|---|---|
| `placeParts` greedy per-sheet loop (`main/background.js`) | `nesting::placement` | not started | |
| `tryPlacePartOnSheet` (batched-holeless-obstacle subtraction, deferred-validation scoring) | `nesting::placement` | not started | |
| Three placement-type scorers | `nesting::placement::score` | not started | NaN-fitness gap must be explicitly resolved here — see gotchas above |
| Milestone: one rectangle placed on one sheet, single individual, no GA, no threads, rendered in Tauri shell | — | not started | earliest point the full stack is provably correct end-to-end |

## Phase 4 — Concurrency model + GA orchestration

| Electron file/function | Rust module | Status | Notes / gotchas |
|---|---|---|---|
| `NfpCache` as one shared structure behind a lock | `nesting::cache` | not started | sharded map or plain mutex — verify contention before reaching for anything fancier |
| 100ms-poll dispatch loop → `rayon::scope` per generation | `nesting::dispatch` | not started | eliminates the ~7500-buffered-insert IPC flood by construction |
| Window-pool-starvation race + failure-recovery paths | — (not ported as code) | not started | invariant (every individual reaches a terminal outcome) gets a new test against the rayon dispatcher instead |
| Progress/log events: rayon closures → Tauri/tokio event loop | `nesting::events` | not started | via `crossbeam`/`std::sync::mpsc` — the one genuinely new piece of plumbing, design deliberately |
| `GeneticAlgorithm` class (elite-seed `population[0]`, three mutate operators incl. rotation-reroll rate cap, OX crossover, roulette selection) | `nesting::ga` | not started | `main/deepnest.js` |
| `widenRotationsIfStalled` / `refineStalledBest` | `nesting::ga::widen_rotations` | not started | `main/deepnest.js` |
| `isBetterNest` | `nesting::ga` | not started | |
| Rotation-angle-grid quirk as user-facing config + warning | `nesting::ga::config` | not started | see gotchas above |
| `tests/ga-seeding.spec.ts` | `nesting::ga` unit tests | not started | |
| `tests/refine-stagnation.spec.ts` | `nesting::ga` unit tests | not started | |

## Phase 5 — Shared cache + consolidation

| Electron file/function | Rust module | Status | Notes / gotchas |
|---|---|---|---|
| `refineConsolidation` (sparsest-sheet-first ranking, smallest-part-first ordering fix, 15-target-sheet cap, 2000ms deadline) | `nesting::consolidation` | not started | `main/background.js`; keep deadline/caps hardcoded, no speculative config surface yet |
| `tests/refine-consolidation.spec.ts` | `nesting::consolidation` unit tests | not started | |

## Phase 6 — Tauri command layer + frontend wiring

| Electron file/function | Rust module | Status | Notes / gotchas |
|---|---|---|---|
| `BACKGROUND_*` IPC channels → Tauri commands + `emit()` events | `src-tauri` commands | not started | the one "redesign, not port" point in the UI layer |
| `frontend/index.html`'s `require("electron").ipcRenderer` (`DeepNest` construction) | `src-tauri` command wiring | not started | currently throws in the bare Tauri webview (Phase 0) since `require` doesn't exist there — expected until this phase |
| `main/ui/services/config.service.ts` | Tauri command wrapper | not started | near-mechanical, already a thin IPC wrapper |
| `main/ui/services/preset.service.ts` | Tauri command wrapper | not started | near-mechanical, already a thin IPC wrapper |
| `tests/dispatch-recovery.spec.ts` | re-tested invariant, not ported | not started | extract "every dispatch always terminates" against the new dispatcher |

## Phase 7 — Import/export, dialogs, DXF, crash recovery

| Electron file/function | Rust module | Status | Notes / gotchas |
|---|---|---|---|
| `@electron/remote` dialog/fs calls | Tauri dialog/fs commands | not started | |
| ~~DXF conversion (`converter.deepnest.app` remote service)~~ | — | superseded | scope change: DXF import/export is native via the `dxf` crate (Phase 1/7), not a remote-conversion round-trip. No `reqwest` dependency needed for this |
| DXF export: write nested layout back out, reproducing each part's original layer | `geometry::dxf_export` or `src-tauri` (TBD) | not started | new scope vs. the original plan — the Electron app never wrote DXF locally |
| `main/ui/services/import.service.ts` | Tauri command wrapper | not started | needs rework beyond a mechanical port — it's built entirely around the remote-conversion-server flow (`convertAndImport`), which no longer exists |
| `main/ui/services/export.service.ts` | Tauri command wrapper | not started | |
| Crash recovery (serialize/deserialize imported part geometry to strings) | TBD | not started | pattern already built and tested this session in the Electron repo, for SVG elements — needs adapting to the DXF entity/polygon tree instead |
| `tests/export-recovery.spec.ts` | re-tested invariant, not ported | not started | "always round-trips recovery snapshot" |

## Phase 8 — Remaining UI wiring + benchmark logging

| Electron file/function | Rust module | Status | Notes / gotchas |
|---|---|---|---|
| `main/ui/components/parts-view.ts` | frontend (ported as-is) + Tauri wiring | not started | |
| `main/ui/components/sheet-dialog.ts` | frontend (ported as-is) + Tauri wiring | not started | |
| `main/ui/components/nest-view.ts` | frontend (ported as-is) + Tauri wiring | not started | |
| `main/ui/components/navigation.ts` | frontend (ported as-is) + Tauri wiring | not started | |
| `main/ui/components/nesting-console.ts` | frontend (ported as-is) + Tauri wiring | not started | |
| `main/benchmarkLogger.js` (git-tagged, dual-file, 5MB-rotated CSV logging) | `nesting::benchmark_log` | not started | produced this session's four empirical tuning sweeps; stays useful for tuning the Rust engine |

## Phase 9 — Parity verification, perf, packaging

| Item | Status | Notes / gotchas |
|---|---|---|
| `nest-cli --fixture X --seed N` headless differential CLI | not started | reuses `benchmarkLogger.js`'s CSV format so both engines land in diffable rows |
| Differential runs vs. Electron app on benchmark fixtures | not started | compare unplaced-count/sheet-count/utilization statistically (GA is stochastic) |
| Rayon core-saturation check vs. 8-window Electron cap | not started | verify, don't assume |
| Tauri packaging/icons/installer | not started | |

## Will not port (verified dead this session)

| Item | Verification |
|---|---|
| `applyPlacement()` (`main/deepnest.js:1775`) | zero call sites repo-wide |
| `overlapTolerance` config field | zero references outside its own default |
| On-disk `./nfpcache` directory + delete-on-quit logic | no writer exists anywhere; already in-memory-only in practice |
| `main/util/simplify.js` | loaded via a `<script>` tag but no static call site found — **do one more dynamic-usage check before dropping**, since a script-tag load without an obvious call site could still be invoked reflectively |

## Dropped from scope (mid-project decision — these are live/used code in the
## Electron app, unlike "will not port" above; they're cut because the input/
## output format changed to DXF-only, not because they're dead)

| Item | Why dropped |
|---|---|
| `main/svgparser.js` (SVG import: DOM → polygon tree, parent/hole detection, `.isCircle`, oversized-part bbox check) | Replaced entirely by DXF import (`geometry::dxf_import`). The same *shape* of work (entities → polygon tree with hole/circle detection) is still being built, just against DXF entities instead of an SVG DOM — see the Phase 1 table above |
| `main/util/domparser.ts` | SVG-DOM-specific helper for `svgparser.js`; no DXF equivalent needed (the `dxf` crate provides a structured entity tree directly, no DOM parsing step) |
| `main/util/matrix.ts` (SVG transform-string parsing) | Only needed for SVG's `transform="matrix(...)"` attribute strings; DXF has no equivalent surface in scope right now |
| DXF-via-remote-conversion-server flow (`converter.deepnest.app`, `main/ui/services/import.service.ts`'s `convertAndImport`) | Replaced by native local DXF parsing (`dxf` crate) — the whole reason for this scope change is that the remote-conversion approach only ever produced SVG output and had no way to preserve DXF layers |

## Reference-only files (Electron side, not ported, kept for lookup)

- `main.js` — IPC handlers, window pool, single-instance-lock (superseded by Phase 6's Tauri command layer, not ported 1:1)
- `main/util/interact.js`, `ractive.js`, `svgpanzoom.js`, `pathsegpolyfill.js`, `parallel.js` — vendored JS libs, ported to `frontend/util/` as-is (no Rust port; frontend is reused, not rewritten)
- `main/font/**`, `main/img/**`, `main/style.css` — static assets, ported to `frontend/` as-is
- `tests/index.spec.ts` — general test harness scaffolding, not a spec to port 1:1; revisit once `nest-cli` exists
