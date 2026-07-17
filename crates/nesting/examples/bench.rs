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
//! profile in `tests/fixtures/FLAT.dxf` (a real cut layout - 99 profiles,
//! sizes from ~300mm to ~2400mm, some with drilled holes), each offset
//! *outward* by half the 6.5mm spacing - the standard offset-based spacing
//! technique: two parts whose spacing-padded footprints don't overlap end
//! up with at least the full spacing between their real outlines. Holes
//! aren't re-offset - the padding is a keep-out zone around the *outside*
//! of a part for inter-part clearance, unrelated to interior features.
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
const SHEET_COPIES: usize = 40;
const CURVE_TOLERANCE: f64 = 0.3;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn load_parts() -> HashMap<usize, LayeredPolygon> {
    let fixture = repo_root().join("tests/fixtures/FLAT.dxf");
    let drawing = Drawing::load_file(&fixture).unwrap_or_else(|e| panic!("couldn't parse {}: {e}", fixture.display()));
    let flat = entities_to_polygons(drawing.entities(), CURVE_TOLERANCE);
    let tree = build_polygon_tree(flat);

    let mut parts_by_id = HashMap::new();
    let mut skipped = 0usize;
    for (id, root) in tree.into_iter().enumerate() {
        let Some(expanded_points) = offset(&root.points, SPACING / 2.0).into_iter().next() else {
            skipped += 1;
            continue;
        };
        parts_by_id.insert(id, LayeredPolygon { points: expanded_points, layer: root.layer, is_circle: None, children: root.children });
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
    let points = offset(&raw, -MARGIN).into_iter().next().expect("sheet inset by margin should still be a valid polygon");
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
