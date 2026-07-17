**Status: all 10 items fixed.** Whole workspace (61 tests) passes. See git
history for the commit that applied these.

# Fix plan: reviewer.md findings, whole-project pass

`reviewer.md` now runs as two adversaries (50/50): port-fidelity vs. the JS
reference, and a senior-Rust-dev critique of the Rust itself, independent of
the port. Applied to every module in `crates/geometry` and `crates/nesting`
(Phases 0-3), not just the last diff. Worst first, tagged `[port]`/`[rust]`.

## 1. [HIGH] [port][rust] `place_parts` drops duplicate-id parts silently

Carried over from the previous pass, still open. `nesting::placement::place_parts`
(`placement.rs:504-508`) removes placed parts via
`parts.retain(|p| !placed_id_set.contains(&p.id))`. The JS original removes
by **object identity** (`parts.indexOf(placed[i])` + `splice`) — nothing
requires part ids to be unique, and quantity > 1 of the same part is normal
usage. When one same-id instance places but a sibling instance never gets
attempted in the same sheet-pass (confirmed repro: the dominant-part-area
break skips the rest of the sheet's part list), retain removes *every* part
with that id, including the untried sibling — it vanishes with no fitness
penalty and no record in any `SheetPlacement`.

It's also an API-design problem, not just a translation slip: `id` is a
caller-assigned field being reused as an internal bookkeeping key, and
nothing in the type signature says ids must be unique.

**Fix:** track *which vector slot* got placed this sheet-pass (index at scan
time, stable within one sheet's `while i < parts.len()` scan, same as the
original), not which id. Remove by index after the scan. `id` stays purely
caller-facing identity for the output.

**Verify:** permanent regression test — 2 identical-id 30x30 parts on 2
available 30x30 sheets, assert `unplaced_count == 0` and
`placements.len() == 2`.

## 2. [MEDIUM] [rust] `.partial_cmp(...).unwrap()` panics on non-finite coordinates, and it's a *pattern*, not one call site

Five separate sites sort/compare polygon-derived `f64`s this way, all of
which panic on `NaN`:

- `dxf_import.rs:303` — `build_polygon_tree`'s largest-area-first sort
- `clipper.rs:81` — `clean_polygon`'s `max_by` over resulting loop areas
- `hull_polygon.rs:50-51` — `hull`'s lexicographic point sort
- `simplify_polygon.rs:96,104` — nearest-target-point selection

DXF import is a trust boundary (arbitrary user-supplied files) and nothing
validates coordinate finiteness on the way in. Two concrete paths to a
non-finite value: (a) a DXF literal outside `f64` range (e.g. `1e400`)
parses straight to `Infinity`; (b) `tessellate_bulge` (`dxf_import.rs:139`)
can produce a `NaN` arc center when a near-horizontal or near-vertical
segment has a bulge small enough to underflow `sagitta` to exactly `0.0`
while `nx`/`ny` is also `0.0` (`0.0 * Infinity == NaN` from
`radius = ... / (2.0 * sagitta)` blowing up). Either way, one malformed
entity among possibly thousands currently panics the *whole* import instead
of being skipped or reported.

**Fix:** replace `.partial_cmp(...).unwrap()` with `.total_cmp(...)` (stable
since Rust 1.62, never panics, defines a total order including NaN/Infinity)
at all five sites — a true drop-in, no behavior change for the finite case
that's exercised today. Separately (bigger, not required to fix this
specific panic): decide whether `dxf_import` should reject/skip entities
with non-finite coordinates at the parse boundary rather than only stop the
panic downstream.

## 3. [MEDIUM] [port] Holed-obstacle path in `try_place_part_on_sheet` is untested

Carried over, still open. None of the 5 placement tests give a placed
obstacle a hole, so the batched-pending-clips-then-flush-then-restore logic
(`placement.rs:221-259`) — specifically whether a *later* obstacle correctly
cuts into an *earlier* one's restored hole-interior region — has zero direct
coverage.

**Fix:** add a test with a part that has a hole big enough for a second part
to nest inside once placed, plus a third part positioned to clip into that
hole-interior region if the restore/subtract ordering were wrong.

## 4. [MEDIUM] [rust] `find_best_candidate`'s panic safety is a convention, not a guarantee

`placement.rs:160-165` unwraps `cand.width`/`minwidth`/`minarea`/`minx`
inside branches that are only safe because *every* candidate in the slice
was built under the same `config.placement_type`, and
`try_place_part_on_sheet`'s candidate-building code happens to set
`width: Some(..)` for every candidate exactly when `placement_type` is
`Gravity`/`Box`. Nothing in the types enforces that pairing — a future
change to the candidate-building branch (e.g. an early `continue` that skips
setting `width`) would panic here, and no test would catch it unless it
specifically exercised the broken path.

**Fix:** fold `area`/`width` into a placement-type-shaped enum
(`CandidateScore::Gravity { area: f64, width: f64 } | Box { .. } |
ConvexHull { area: f64 }`) so "gravity/box candidates always have a width"
is a compile-time fact instead of a runtime assumption. Lower priority than
1-3; worth doing if `try_place_part_on_sheet` gets touched again for
`mergeLines` or Phase 5's `refineConsolidation` reuse.

## 5. [LOW] [rust] Unnecessary clone on the common "evaluate but skip" path

`placement.rs`'s per-part loop does `let part = parts[i].polygon.clone();`
unconditionally, before knowing whether the part will actually place. Every
rejected candidate (no room, overlaps, wrong rotation) still pays for a full
`LayeredPolygon` clone (points + recursive hole children) that's immediately
discarded. Could borrow `&parts[i].polygon` for the NFP/scoring calls and
only clone once a placement is confirmed.

## 6. [LOW] [rust] `SheetPlacement.parts: Vec<(usize, Placement, f64)>` should be a named struct

A positional tuple on a `pub` type meant for later phases (export, UI) to
consume. Own test code already had to destructure as
`result.placements[0].parts[0].0` — a `PlacedPart { id, placement, rotation
}` struct would read at call sites instead of requiring readers to remember
field order.

## 7. [LOW] [rust] Inconsistent `.unwrap()`/`.expect()` messages

`placement.rs:306`, `get_polygon_bounds(&rect_corners).unwrap()`, has no
message; the two `.expect("...")` calls immediately above it do. Free to fix
while in the area.

## 8. [LOW] [rust] Empty-`sheets` call produces `fitness == Infinity`, silently

`place_parts(&[], parts, ..)` with non-empty `parts` leaves
`total_sheet_area == 0.0`; the unplaced-part penalty loop
(`placement.rs:533-535`) then divides by that zero. Not a crash (IEEE754
gives `+Infinity`, not a panic or NaN), but undocumented and easy to
mistake for "it worked" if a caller doesn't check for it. Worth a doc note
or an explicit `unplaced_count == parts.len() && placements.is_empty()`
early return.

## 9. [LOW] [rust] `Touch.kind: u8` in `nfp.rs` should be an enum

`nfp.rs:539-543`, matched via `match t.kind { 0 => .., 1 => .., _ => .. }`.
Nothing stops constructing an invalid discriminant, and the match arms read
as magic numbers rather than named cases (`VertexRef` right above it already
shows the idiomatic version of this same pattern).

## 10. [LOW] [rust] `shift_layered_polygon` carries `is_circle`, JS's `shiftPolygon` doesn't

Carried over, still open, still harmless (nothing downstream reads
`is_circle` post-shift today) — just needs the one-line doc-comment
disclosure other intentional deviations in this codebase get.

## Order of work

Fix #1 and #2 before Phase 4 (GA) wiring touches `place_parts`/DXF import
with real data — #1 is a silent-data-loss bug the moment a real part list
has duplicate ids (which a GA will produce constantly), #2 is a
one-line-per-site fix (`total_cmp`) that closes a crash-on-malformed-file
gap essentially for free. #3-4 before `try_place_part_on_sheet` gets reused
by Phase 5. #5-10 are cheap, do them in the same pass.
