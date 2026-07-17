//! Performance-bottleneck-finding benchmark: repeated timed nest runs
//! against a real DXF fixture, on the sheet size/margin/spacing a real
//! job uses, logged via `nesting::benchmark_log` in the same two-file
//! shape `main/benchmarkLogger.js` established (a per-generation detail
//! log, `nest-benchmark.log`, and a per-run summary CSV,
//! `nest-benchmark-runs.csv`, both at the repo root).
//!
//! Usage: `cargo run --release -p nesting --example bench -- [num_runs] [run_seconds]`
//! (defaults: 40 runs, 60s each - pass small values to smoke-test first,
//! release mode matters a lot here, this is a perf measurement).
//!
//! Sheet is a plain 2440x1220mm rectangle, offset inward by the 3mm margin
//! (`geometry::clipper::offset`, negative delta). Parts are every closed
//! profile in *both* `tests/fixtures/FLAT.dxf` and
//! `tests/fixtures/FLAT-struck.dxf` (two real cut layouts, combined into one
//! part pool - ids continue across the second file rather than restarting
//! at 0, so they stay unique), each offset *outward* by half the 6.5mm
//! spacing - the standard offset-based spacing technique: two parts whose
//! spacing-padded footprints don't overlap end up with at least the full
//! spacing between their real outlines. Holes aren't re-offset - the
//! padding is a keep-out zone around the *outside* of a part for inter-part
//! clearance, unrelated to interior features.
//!
//! `SHEET_COPIES` is asserted at startup to have real headroom over the
//! computed minimum (total part area / sheet area, at the ~90% packing
//! efficiency real runs actually achieve) instead of being a bare guess - a
//! previous pass used a guessed 40, which turned out to be below the true
//! minimum for `FLAT.dxf` alone, leaving parts structurally unable to fit
//! regardless of GA quality and confounding the "why doesn't more compute
//! time help" result. Panics with the real numbers instead of silently
//! under-providing sheets again.
//!
//! Each run gets a fresh `GeneticAlgorithm` and calls
//! `dispatch::run_generation` in a loop until `run_seconds` of wall clock
//! have elapsed, logging every generation's timing/fitness/placement
//! stats - this is real per-generation throughput data (rayon-parallel,
//! same as an actual run), not a synthetic microbenchmark, and is exactly
//! the shape of information needed to see whether NfpCache's absence (see
//! `docs/PORT_STATUS.md`'s Phase 4 row - built but not wired into the
//! placement pipeline yet) is actually the dominant cost here or not.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use dxf::Drawing;
use geometry::clipper::offset;
use geometry::dxf_import::{build_polygon_tree, entities_to_polygons, LayeredPolygon};
use nesting::benchmark_log::{append_benchmark_line, append_run_summary_row, git_revision};
use nesting::dispatch;
use nesting::ga::{GaConfig, GeneticAlgorithm};
use nesting::placement::{PlacementConfig, PlacementType, DEFAULT_DOMINANT_PART_AREA_THRESHOLD};

const SHEET_WIDTH: f64 = 2440.0;
const SHEET_HEIGHT: f64 = 1220.0;
const MARGIN: f64 = 3.0;
const SPACING: f64 = 6.5;
const SHEET_COPIES: usize = 120;
const CURVE_TOLERANCE: f64 = 0.3;
/// Real utilisation observed in prior runs on this fixture set was ~91%;
/// use a slightly more conservative 90% here so the startup check has a
/// small margin of its own rather than asserting against the exact figure.
const ASSUMED_PACKING_EFFICIENCY: f64 = 0.9;
const FIXTURES: &[&str] = &["FLAT.dxf", "FLAT-struck.dxf"];

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Loads every closed profile from every file in `FIXTURES`, combined into
/// one part pool - ids continue across files (a plain running counter)
/// rather than restarting at 0 per file, so they stay unique.
fn load_parts() -> HashMap<usize, LayeredPolygon> {
    let mut parts_by_id = HashMap::new();
    let mut next_id = 0usize;
    let mut skipped = 0usize;

    for name in FIXTURES {
        let fixture = repo_root().join("tests/fixtures").join(name);
        let drawing = Drawing::load_file(&fixture).unwrap_or_else(|e| panic!("couldn't parse {}: {e}", fixture.display()));
        let flat = entities_to_polygons(drawing.entities(), CURVE_TOLERANCE);
        let tree = build_polygon_tree(flat);

        for root in tree {
            let Some(expanded_points) = offset(&root.points, SPACING / 2.0).into_iter().next() else {
                skipped += 1;
                continue;
            };
            parts_by_id.insert(next_id, LayeredPolygon { points: expanded_points, layer: root.layer, is_circle: None, children: root.children });
            next_id += 1;
        }
    }
    if skipped > 0 {
        eprintln!("warning: {skipped} profile(s) failed to offset for spacing and were skipped");
    }
    parts_by_id
}

fn build_sheet() -> LayeredPolygon {
    let raw = vec![
        geometry::point::Point::new(0.0, 0.0),
        geometry::point::Point::new(SHEET_WIDTH, 0.0),
        geometry::point::Point::new(SHEET_WIDTH, SHEET_HEIGHT),
        geometry::point::Point::new(0.0, SHEET_HEIGHT),
    ];
    // Every part is independently padded outward by `SPACING / 2` (see
    // `load_parts`) so two placed parts end up `SPACING` apart - but that
    // same padding also applies whenever a part is checked against the
    // *sheet* boundary, since the engine has no way to know which check is
    // which. Left uncorrected, that silently requires `SPACING / 2`
    // clearance from the true sheet edge in addition to whatever the sheet
    // itself is inset by - the original app (which has no separate margin
    // concept at all, only `config.spacing`, applied exactly this way -
    // `-0.5 * spacing` to the sheet, `+0.5 * spacing` to parts, see
    // `main/deepnest.js:1188-1205`) never has this problem because it only
    // ever wants that one combined clearance. We want two independently
    // configurable clearances (a `MARGIN` from the edge, a `SPACING` between
    // parts), so the sheet's own inset has to be net of the padding that's
    // coming from the part side: inset by `SPACING / 2 - MARGIN` less than
    // a naive `MARGIN` shrink would - which can go negative (grow the
    // sheet) when `SPACING / 2 > MARGIN`, as it does here (3.25mm > 3mm):
    // the part's own padding already provides more than the requested
    // margin, so the sheet needs no additional shrink for edge clearance at
    // all, only more than we correctively grow it back by the difference.
    let sheet_delta = SPACING / 2.0 - MARGIN;
    let points = offset(&raw, sheet_delta).into_iter().next().expect("sheet inset by margin should still be a valid polygon");
    LayeredPolygon { points, layer: "SHEET".into(), is_circle: None, children: Vec::new() }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let num_runs: usize = args.next().and_then(|s| s.parse().ok()).unwrap_or(40);
    let run_seconds: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(60);

    let parts_by_id = load_parts();
    let adam: Vec<usize> = {
        let mut ids: Vec<usize> = parts_by_id.keys().copied().collect();
        ids.sort_by(|&a, &b| {
            let area_a = geometry::polygon::polygon_area(&parts_by_id[&a].points).abs();
            let area_b = geometry::polygon::polygon_area(&parts_by_id[&b].points).abs();
            area_b.total_cmp(&area_a)
        });
        ids
    };
    let sheets: Vec<LayeredPolygon> = (0..SHEET_COPIES).map(|_| build_sheet()).collect();

    // Fail fast with the real numbers instead of silently under-providing
    // sheets again (see this file's module doc comment for the previous
    // pass that got this wrong with a bare guess of 40).
    let sheet_area = geometry::polygon::polygon_area(&sheets[0].points).abs();
    let total_part_area: f64 = adam.iter().map(|id| geometry::polygon::polygon_area(&parts_by_id[id].points).abs()).sum();
    let usable_capacity = SHEET_COPIES as f64 * sheet_area * ASSUMED_PACKING_EFFICIENCY;
    assert!(
        usable_capacity >= total_part_area,
        "SHEET_COPIES={SHEET_COPIES} isn't enough: {total_part_area:.0}mm2 of parts vs {usable_capacity:.0}mm2 of usable capacity \
         at {:.0}% packing efficiency ({:.1} sheets minimum at 100%, {:.1} at {:.0}%) - raise SHEET_COPIES",
        ASSUMED_PACKING_EFFICIENCY * 100.0,
        total_part_area / sheet_area,
        total_part_area / (sheet_area * ASSUMED_PACKING_EFFICIENCY),
        ASSUMED_PACKING_EFFICIENCY * 100.0,
    );

    let placement_config =
        PlacementConfig { placement_type: PlacementType::Gravity, rotations: 4, dominant_part_area_threshold: DEFAULT_DOMINANT_PART_AREA_THRESHOLD, curve_tolerance: CURVE_TOLERANCE };
    let ga_config = GaConfig { population_size: 10, mutation_rate: 10.0, rotations: 4 };

    let detail_log = repo_root().join("nest-benchmark.log");
    let runs_csv = repo_root().join("nest-benchmark-runs.csv");
    let runs_header = "timestamp,git_rev,run,elapsed_s,generations,parts_total,population_size,rotations,mutation_rate,placement_type,dominant_part_area_threshold,curve_tolerance,sheet_width,sheet_height,margin,spacing,best_fitness,sheets_used,parts_placed,parts_unplaced,utilisation_pct,avg_gen_ms,min_gen_ms,max_gen_ms";

    println!(
        "bench: {} parts, {} sheet copies ({SHEET_WIDTH}x{SHEET_HEIGHT}mm, margin {MARGIN}mm, spacing {SPACING}mm), {num_runs} runs x {run_seconds}s, rev={}",
        adam.len(),
        SHEET_COPIES,
        git_revision()
    );

    for run in 1..=num_runs {
        let mut ga = GeneticAlgorithm::new(adam.clone(), ga_config.clone(), Vec::new());
        let run_start = Instant::now();
        let deadline = Duration::from_secs(run_seconds);

        let mut generation = 0usize;
        let mut best_fitness = f64::INFINITY;
        let mut best_unplaced = usize::MAX;
        let mut best_sheets_used = 0usize;
        let mut best_utilisation = 0.0;
        let mut gen_times_ms: Vec<u128> = Vec::new();

        while run_start.elapsed() < deadline {
            let gen_start = Instant::now();
            let results = dispatch::run_generation(&mut ga, &sheets, &parts_by_id, &placement_config);
            let gen_ms = gen_start.elapsed().as_millis();
            generation += 1;
            gen_times_ms.push(gen_ms);

            for r in &results {
                if r.fitness < best_fitness {
                    best_fitness = r.fitness;
                    best_unplaced = r.unplaced_count;
                    best_sheets_used = r.placements.len();
                    best_utilisation = r.utilisation;
                }
            }

            append_benchmark_line(
                &detail_log,
                &format!(
                    "{},{},run={run},gen={generation},gen_ms={gen_ms},best_fitness={best_fitness:.0},unplaced={best_unplaced},sheets_used={best_sheets_used}",
                    unix_timestamp(),
                    git_revision(),
                ),
            );
            println!(
                "run {run}/{num_runs} gen {generation}: {gen_ms}ms, best_fitness={best_fitness:.0}, unplaced={best_unplaced}, sheets={best_sheets_used}, util={best_utilisation:.1}%"
            );
        }

        let avg_gen_ms = if gen_times_ms.is_empty() { 0.0 } else { gen_times_ms.iter().sum::<u128>() as f64 / gen_times_ms.len() as f64 };
        let min_gen_ms = gen_times_ms.iter().min().copied().unwrap_or(0);
        let max_gen_ms = gen_times_ms.iter().max().copied().unwrap_or(0);
        let parts_placed = adam.len().saturating_sub(best_unplaced.min(adam.len()));

        append_run_summary_row(
            &runs_csv,
            runs_header,
            &[
                unix_timestamp(),
                git_revision().to_string(),
                run.to_string(),
                format!("{:.1}", run_start.elapsed().as_secs_f64()),
                generation.to_string(),
                adam.len().to_string(),
                ga_config.population_size.to_string(),
                ga_config.rotations.to_string(),
                format!("{:.1}", ga_config.mutation_rate),
                format!("{:?}", placement_config.placement_type),
                format!("{:.2}", placement_config.dominant_part_area_threshold),
                format!("{:.2}", placement_config.curve_tolerance),
                SHEET_WIDTH.to_string(),
                SHEET_HEIGHT.to_string(),
                MARGIN.to_string(),
                SPACING.to_string(),
                format!("{best_fitness:.1}"),
                best_sheets_used.to_string(),
                parts_placed.to_string(),
                best_unplaced.to_string(),
                format!("{best_utilisation:.2}"),
                format!("{avg_gen_ms:.1}"),
                min_gen_ms.to_string(),
                max_gen_ms.to_string(),
            ],
        );

        println!("=== run {run}/{num_runs} done: {generation} generations in {:.1}s (avg {avg_gen_ms:.0}ms/gen) ===", run_start.elapsed().as_secs_f64());
    }

    println!("all runs complete. see {} and {}", detail_log.display(), runs_csv.display());
}

/// No `chrono`/`time` dependency for one timestamp column - a fixed-offset
/// seconds-since-UNIX-epoch value is enough to line runs up chronologically
/// (which is all the original's ISO-string timestamp was for) without a new
/// dependency for it.
fn unix_timestamp() -> String {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs().to_string()).unwrap_or_else(|_| "0".to_string())
}
