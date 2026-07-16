# Port Status

The one living tracking doc for the Electron → Rust/Tauri rewrite. See
`RUST-REWRITE-PLAN.md` at the repo root for phase scope/ordering and the
full rationale behind each decision below. Update a row's status the moment
its corresponding Rust module lands and its ported spec (if any) passes —
don't batch updates to the end of a phase.

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

## Phase 0 — Scaffolding

| Item | Status | Notes / gotchas |
|---|---|---|
| Cargo workspace (`Cargo.toml`, `crates/geometry`, `crates/nesting`) | done | two-crate split per plan; geometry = pure/testable, nesting = stateful/concurrent |
| Clipper2 Rust FFI binding builds/links on Windows | done | `clipper2` crate (wraps `clipper2c-sys`, C++17 via MSVC) added to `geometry`; smoke-tested with a real boolean union |
| Bare Tauri shell serving copied frontend | in progress | see Phase 6 note below re: `require("electron")` in `index.html` |
| `docs/PORT_STATUS.md` seeded | done | this file |

## Phase 1 — Geometry core

| Electron file/function | Rust module | Status | Notes / gotchas |
|---|---|---|---|
| `main/util/point.ts`, `vector.ts`, `matrix.ts` | `geometry::primitives` | not started | |
| `main/util/clipper.js` (Clipper1, JS port) | `geometry::clipper` (via `clipper2` crate) | not started | upgrade from Clipper1 → Clipper2, not a literal port |
| Offset/boolean ops, `SimplifyPolygon`+`CleanPolygon`, `Area` | `geometry::clipper` | not started | |
| Custom RDP-simplify post-process (offset-shell re-merge, exterior-point reversal, axis straightening, `.exact` marking) | `geometry::simplify` | not started | source: `main/util/simplify.js` is itself possibly dead code, see "will not port" below — the *algorithm* still needs porting if any live caller is found |
| `main/svgparser.js` (SVG import: DOM → polygon tree, parent/hole detection, `.isCircle` metadata, oversized-part bbox check) | `geometry::svg_import` | not started | |
| `main/util/domparser.ts` | `geometry::svg_import` | not started | |
| `main/util/geometryutil.js`: `noFitPolygon`, `noFitPolygonRectangle`, slide/projection distance, search-start-point, polygon hull | `geometry::nfp_trace` | not started | the NFP-tracing algorithm core |
| `main/util/HullPolygon.ts` | `geometry::nfp_trace` | not started | |
| `main/util/eval.ts` | TBD | not started | check for live call sites before porting (dynamic eval usage is a smell) |
| `tests/geometry.spec.ts` | `geometry` unit tests | not started | port cases as each function lands, not in a batch |

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
| DXF conversion (`converter.deepnest.app` remote service) | `reqwest` client | not started | no local DXF parsing needed, same as today |
| `main/ui/services/import.service.ts` | Tauri command wrapper | not started | |
| `main/ui/services/export.service.ts` | Tauri command wrapper | not started | |
| Crash recovery (serialize/deserialize SVG elements to strings) | TBD | not started | pattern already built and tested this session in the Electron repo |
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

## Reference-only files (Electron side, not ported, kept for lookup)

- `main.js` — IPC handlers, window pool, single-instance-lock (superseded by Phase 6's Tauri command layer, not ported 1:1)
- `main/util/interact.js`, `ractive.js`, `svgpanzoom.js`, `pathsegpolyfill.js`, `parallel.js` — vendored JS libs, ported to `frontend/util/` as-is (no Rust port; frontend is reused, not rewritten)
- `main/font/**`, `main/img/**`, `main/style.css` — static assets, ported to `frontend/` as-is
- `tests/index.spec.ts` — general test harness scaffolding, not a spec to port 1:1; revisit once `nest-cli` exists
