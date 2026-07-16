# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

**Phase 0 (scaffolding) is done.** Phase 1 (geometry core) has not started.
Always check `docs/PORT_STATUS.md` first — it's the single living tracking
doc for what's ported and what's outstanding; don't re-derive status from
`RUST-REWRITE-PLAN.md` or by guessing from the file tree.

**Read `RUST-REWRITE-PLAN.md` in full before doing any work here.** It is the
master plan for a from-scratch Rust/Tauri rewrite of Deepnest (currently an
Electron app), covering repo structure, phase-by-phase scope, what to
deliberately not port, and the parity/testing strategy. Do not relitigate the
decisions it marks as already made (Rust+Tauri, no GPU, Clipper2 Rust FFI
bindings, rayon for concurrency, the `geometry`/`nesting` two-crate split).

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

Known Phase 0 limitation: `frontend/index.html`'s inline module script calls
`require("electron")` to construct `window.DeepNest`, which throws in the
Tauri webview (no `require` global there). The static chrome (CSS, nav
sidebar, icons) renders fine; the Ractive-templated main content stays blank
until Phase 6 replaces that IPC wiring with Tauri commands. Don't try to fix
this now — it's tracked in `docs/PORT_STATUS.md` Phase 6.

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
    geometry/                    # pure geometry math, zero I/O, zero threading
                                  #   - clipper2 crate wired in (Clipper2 C++ FFI), smoke-tested
    nesting/                     # NfpCache, GA, placement, rayon dispatch, event abstraction
                                  #   - depends on geometry; still an empty skeleton
  src-tauri/                     # Tauri v2 shell — currently zero real commands
  frontend/                      # Electron main/ui/**, index.html, style.css, vendored libs,
                                  # copied as-is (only path fix: ui bundle import, see PORT_STATUS)
  docs/
    PORT_STATUS.md               # the one living tracking doc — check this first
  tests/
    fixtures/                    # not yet populated — SVGs/part-sets from Electron benchmark sweeps
```

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

## Verified dead code — do not port

- `applyPlacement()` (`main/deepnest.js:1775`) — zero call sites repo-wide.
- `overlapTolerance` config field — zero references outside its own default.
- The on-disk `./nfpcache` directory and its delete-on-quit logic — no writer
  exists; already in-memory-only in practice.
- `main/util/simplify.js` — loaded via script tag but no static call site
  found; do one more dynamic-usage check before dropping.
