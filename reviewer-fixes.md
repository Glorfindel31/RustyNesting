# Fix plan: reviewer.md findings

**Round 1 (Phase 0-3): resolved.** All 10 items fixed, see git log
(`total_cmp` swaps, index-based part removal, `CandidateScore` enum, etc.).
This file now tracks Round 2.

**Round 2: mostly resolved.** #1, #2, #3, #5, #6, #7 fixed. #4 is split:
the cheap, mechanical part (`.lock().unwrap()` poisoning risk) is fixed;
actually wiring `NfpCache` into the placement pipeline is a real feature
addition (needs id/rotation threaded through `try_place_part_on_sheet`'s
signature, plus a decision about shape- vs. instance-identity caching -
see `docs/PORT_STATUS.md`'s `NfpCache` row) and is deliberately not rushed
into this pass. Findings kept below for the record.

## 1. [HIGH] [rust] Unvalidated `rotations`/`population_size` panic deep inside the engine, reachable from the Tauri IPC boundary

**Status: fixed.** `run_nest` now validates both up front and returns a
descriptive `Err`; 3 new tests cover it.

`src-tauri/src/dto.rs`'s `NestConfigDto.rotations: u32` and
`.population_size: usize` flow straight into `GaConfig` with zero
validation, then straight into `GeneticAlgorithm::new()`
(`crates/nesting/src/ga.rs`):

- `rotations: 0` → `random_angles`'s `rng.gen_range(0..rotations)` panics
  (`rand` panics on an empty range) the moment any part exists - and
  `run_nest` already guarantees at least one part exists before this runs.
- `population_size: 0` **or** `1` → `GeneticAlgorithm::new()` always seeds
  exactly one individual before checking `population_size` at all, so both
  values leave the population at size 1. The first `dispatch::run_generation`
  call then calls `GeneticAlgorithm::generation()`, which calls
  `random_weighted_individual(Some(male_idx))` to pick a second, distinct
  parent - with only one individual, excluding it leaves `indices` empty,
  and `indices[0]` panics on an empty `Vec`.

Both are one bad request away (a UI bug, a malformed request, a future
caller that doesn't know to guard these) from crashing the command handler,
on a Tauri command that's the actual documented trust boundary here (see
this project's own "only validate at system boundaries" guidance). Neither
field has a doc comment, a `Result`-returning check, or a clamp anywhere -
`run_nest` (`commands.rs`) already validates "sheets non-empty"/"parts
non-empty"/"adam non-empty" but not these two.

**Fix:** validate `rotations >= 1` and `population_size >= 2` in `run_nest`
(or in `NestConfigDto`/`GaConfig` construction) and return a descriptive
`Err` instead of letting the panic happen three call frames later where it's
much harder to diagnose.

## 2. [HIGH] [port] `expand_parts` forces quantity 0 to mean 1 copy - the original excludes the part entirely, and the port's own comment misattributes the justification

**Status: fixed.** Dropped the `.max(1)`; the misleadingly-named test is
renamed (`run_nest_excludes_zero_quantity_parts`) and its assertion flipped
to match reality, plus a new mixed-quantity test.

`src-tauri/src/dto.rs::expand_parts`: `for _ in 0..part.quantity.max(1)`.
The `.max(1)` means a part explicitly given `quantity: 0` still gets nested
once.

The JS reference for **part** quantity (`launchWorkers`, non-sheet branch):
`for (var j = 0; j < parts[i].quantity; j++) { ... }` - a literal
`quantity: 0` is zero loop iterations, zero copies, the part is excluded
from the nest entirely. There is no fallback-to-1 anywhere in this branch.

The `.max(1)` here was justified (in both a doc comment and a test comment)
as matching *"background.js's own 'quantity 0 means unlimited on a sheet,
but 1 on a part'"* - but re-checking the reference, that convention
(`Number(parts[i].quantity) || totalPartInstances || 1`) exists **only** in
`launchWorkers`'s *sheet* branch, a completely different code path with
different semantics (0 sheets of a given size means "supply enough copies
to cover the worst case", not "1"). It doesn't apply to parts at all. The
justification is confidently worded and cites the original, but is simply
wrong about which branch it's describing.

Real-world impact: a UI that lets a user zero out a part's quantity without
deleting the row (a completely standard pattern - "uncheck to skip") would
silently get 1 copy nested anyway.

Compounding this: `commands.rs`'s test for this exact scenario is named
`run_nest_rejects_all_zero_quantities` but its body asserts
`run_nest(request).is_ok()` - the **opposite** of what the name says. The
test enshrines the bug as expected behavior, so a future correct fix will
look like it broke a passing test instead of fixing one.

**Fix:** drop the `.max(1)` in `expand_parts` - a part with `quantity: 0`
contributes zero entries to `adam`/`parts_by_id`, matching the original.
`run_nest`'s existing `if adam.is_empty() { return Err(...) }` already
correctly handles "every part was quantity 0" once this is fixed. Rename
the test to reflect what it should assert once fixed (something like
`run_nest_excludes_zero_quantity_parts`), and fix its assertion.

## 3. [MEDIUM] [rust] `GeneticAlgorithm::mate` is a public method with an undocumented, unenforced same-length precondition

**Status: fixed.** Doc comment + `debug_assert_eq!` added.

`crates/nesting/src/ga.rs::mate`: `cutpoint` is derived from
`male.placement.len()`, then used to slice **both** `male.placement[..cutpoint]`
*and* `female.placement[..cutpoint]`. If a caller ever passes a `female`
individual shorter than `male`, this panics via out-of-bounds slicing.

Currently safe in practice - the only real caller, `generation()`, always
draws both parents from the same `population`, where every individual is
guaranteed the same gene length by construction. But `mate` is `pub fn`, has
no doc comment stating the precondition, and no `debug_assert!` enforcing
it - a future caller (or a refactor of `generation()`) could violate it
silently.

**Fix:** add a one-line doc comment stating the precondition, and/or a
`debug_assert_eq!(male.placement.len(), female.placement.len())` at the top
of the function - cheap insurance for a public API.

## 4. [MEDIUM] [port] `NfpCache` (Phase 4) is built and tested but never actually called - every real run recomputes every NFP from scratch

**Status: partially fixed.** The poisoning risk is fixed (`NfpCache::lock`
now recovers via `PoisonError::into_inner` instead of `.unwrap()`ing
straight into a permanent panic cascade). Actually wiring the cache into
`try_place_part_on_sheet`/`place_parts` is deliberately deferred - see
`docs/PORT_STATUS.md`'s `NfpCache` row for why (real signature change,
plus an open shape- vs. instance-identity design question, not a
mechanical bug fix).

Grepping `dispatch.rs`/`placement.rs`/`consolidation.rs`/`commands.rs` for
`NfpCache` turns up nothing - the cache from `nesting::cache` is never
constructed or consulted anywhere in the actual placement pipeline. Every
`inner_nfp`/`obstacle_nfp` call inside `try_place_part_on_sheet`/`place_parts`
recomputes from scratch, including for identical (part, rotation) pairs
that repeat constantly across a GA population and across generations - the
exact redundant work the original's `NfpCache` (and the plan's Phase 4 row)
exists to avoid. `docs/PORT_STATUS.md` marks the `NfpCache` row "done",
which is true for the data structure itself, but the caching *behavior*
Phase 4 was meant to deliver isn't actually happening in any real run yet.

Related, currently-latent concern for when it **does** get wired in:
`cache.rs` calls `.lock().unwrap()` at all four access points. `Mutex`
poisons on any panic while the lock is held; once this cache sits in the
hot path of a `rayon::par_iter()` generation evaluation (exactly what the
module's own doc comment says it's for), a single panic in any one worker
thread while holding the lock would poison the cache for every other
thread, permanently, for the rest of the run - not "that thread's work is
lost", but "every subsequent cache access from any thread panics too".

**Fix:** wire `NfpCache` into `try_place_part_on_sheet`'s (or a caller's)
`inner_nfp`/`obstacle_nfp` calls before claiming Phase 4's performance goal
is met - not required for correctness, but worth flagging clearly rather
than let "done" quietly mean "built but disconnected". Separately, once it
is wired in: replace `.lock().unwrap()` with something that survives
poisoning (`.lock().unwrap_or_else(PoisonError::into_inner)` is the
simplest - a stale-but-still-valid cache entry from a half-finished insert
is a far smaller problem than poisoning the whole cache for the rest of the
run).

## 5. [LOW] [port] Undocumented preserved quirk: the adjacent-swap mutation operator swaps part order but not rotation

**Status: fixed.** One-line comment added at the swap site.

`ga.rs::mutate`'s adjacent-swap block does
`clone.placement.swap(i, j)` but never touches `clone.rotation[i]`/`[j]`.
Verified against the JS original - it has the exact same asymmetry (`var
temp = clone.placement[i]; ...` only ever touches `.placement`, never
`.rotation`). So this is a faithful port, not a bug introduced here. But
unlike similar surprising-on-first-read-but-intentional behaviors elsewhere
in this codebase (the `on_segment` tolerance asymmetry, `polygonHull`'s
backward-scan bug, etc.), which all get an explicit "preserved exactly,
matches the original" comment right at the code, this one doesn't - a
future reader might "fix" it by adding a rotation swap, silently changing
behavior.

**Fix:** one-line comment at the swap noting rotation is deliberately left
in place (it gets its own independent per-index reroll chance right below),
matching this codebase's own convention for this class of quirk.

## 6. [LOW] [rust] Dead test code masked by `let _ = ...`

**Status: fixed.** Deleted the unused variable.

`ga.rs::tests::is_better_nest_prefers_fewer_unplaced_parts_above_all_else`
constructs `more_sheets_but_all_placed` and never uses it in any assertion -
the actual assertions compare two entirely different `result(...)` values.
The unused variable is silenced with `let _ = more_sheets_but_all_placed;`
instead of being deleted, so it reads as intentional when it's very likely
a leftover from an earlier draft of the test.

**Fix:** delete the unused variable and its `let _ = ...` line - the test
still verifies what its name claims without it.

## 7. [VERY LOW] [rust] Inconsistent sanity-check coverage between two similar tests

**Status: fixed.** Sanity assertion added.

`consolidation.rs::tests::does_nothing_when_no_relocation_is_possible`
doesn't assert `result.placements.len() == 2` before running
`refine_consolidation`, unlike its sibling
`drains_a_sparse_sheet_into_another_when_relocation_fits`, which does.
Harmless today (48+48 > 50 makes two starting sheets geometrically
inevitable), purely a consistency nit.

**Fix:** add the same sanity assertion, or don't - lowest priority item on
this list, mentioned for completeness per `reviewer.md`'s "small mistakes
count too."

## Order of work

Fix #1 and #2 before `run_nest` is ever exposed to a real frontend - both
are silent-failure-or-crash bugs reachable from ordinary (not even
adversarial) input. #3 and #4 are worth doing in the same pass since
they're cheap and #4 in particular undermines a chunk of Phase 4's actual
point. #5-7 are cosmetic, bundle them in whenever these files are next
touched.
