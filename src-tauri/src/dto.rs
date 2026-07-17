//! Serialization boundary between the Tauri IPC surface and the internal
//! `geometry`/`nesting` types. Kept as a separate, explicit conversion layer
//! rather than deriving `Serialize`/`Deserialize` directly on
//! `geometry::point::Point`/`LayeredPolygon` etc. - those crates are
//! deliberately I/O-free (`geometry`'s own module doc: "Zero I/O, zero
//! threading"), and serialization is exactly the kind of boundary concern
//! that belongs at the edge, not baked into core geometry types.

use std::collections::HashMap;

use geometry::dxf_import::LayeredPolygon;
use geometry::point::Point;
use nesting::ga::GaConfig;
use nesting::placement::{PlacementConfig, PlacementType};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Clone, Copy, Debug)]
pub struct PointDto {
    pub x: f64,
    pub y: f64,
}

impl From<&Point> for PointDto {
    fn from(p: &Point) -> Self {
        PointDto { x: p.x, y: p.y }
    }
}

impl From<PointDto> for Point {
    fn from(p: PointDto) -> Self {
        Point::new(p.x, p.y)
    }
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug)]
pub struct CircleDto {
    pub cx: f64,
    pub cy: f64,
    pub r: f64,
}

/// A polygon plus its holes, matching `geometry::dxf_import::LayeredPolygon`
/// field-for-field. Deserializable (a `run_nest` request builds these from
/// whatever the frontend already has) and serializable (`import_dxf`'s
/// response is these).
#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct PolygonDto {
    pub points: Vec<PointDto>,
    pub layer: String,
    #[serde(default)]
    pub is_circle: Option<CircleDto>,
    #[serde(default)]
    pub children: Vec<PolygonDto>,
}

impl From<&LayeredPolygon> for PolygonDto {
    fn from(poly: &LayeredPolygon) -> Self {
        PolygonDto {
            points: poly.points.iter().map(PointDto::from).collect(),
            layer: poly.layer.clone(),
            is_circle: poly.is_circle.map(|c| CircleDto { cx: c.cx, cy: c.cy, r: c.r }),
            children: poly.children.iter().map(PolygonDto::from).collect(),
        }
    }
}

impl From<PolygonDto> for LayeredPolygon {
    fn from(dto: PolygonDto) -> Self {
        LayeredPolygon {
            points: dto.points.into_iter().map(Point::from).collect(),
            layer: dto.layer,
            is_circle: dto.is_circle.map(|c| geometry::circular_nfp::Circle { cx: c.cx, cy: c.cy, r: c.r }),
            children: dto.children.into_iter().map(LayeredPolygon::from).collect(),
        }
    }
}

/// One part definition from the frontend: a shape plus how many copies to
/// nest. Expanded into individually-id'd `NestPart`s by `expand_parts`
/// below - `nesting::dispatch`'s `parts_by_id: HashMap<usize, _>` needs one
/// entry per physical copy, not per shape (matches the original's
/// `launchWorkers` building `adam` the same way: one polygon clone with a
/// fresh id per `parts[i].quantity`).
#[derive(Deserialize, Clone, Debug)]
pub struct PartDto {
    pub polygon: PolygonDto,
    #[serde(default = "one")]
    pub quantity: usize,
}

fn one() -> usize {
    1
}

/// Expands `parts` (shape + quantity) into `(adam, parts_by_id)`: `adam` is
/// every physical copy's id, area-sorted decreasing (same seed order
/// `launchWorkers` uses for the GA's `population[0]`); `parts_by_id` maps
/// each id to its geometry. A part with `quantity: 0` contributes zero
/// copies - matches the original's plain `for (j=0; j<quantity; j++)` loop
/// for parts (`launchWorkers`'s non-sheet branch). There's no
/// fallback-to-1 here: that convention exists only for *sheet* quantity
/// (`Number(quantity) || totalPartInstances || 1`, "0 means unlimited"), a
/// different code path with different semantics that doesn't apply to
/// parts.
pub fn expand_parts(parts: Vec<PartDto>) -> (Vec<usize>, HashMap<usize, LayeredPolygon>) {
    let mut parts_by_id = HashMap::new();
    let mut adam = Vec::new();
    let mut next_id = 0usize;

    for part in parts {
        let polygon: LayeredPolygon = part.polygon.into();
        for _ in 0..part.quantity {
            parts_by_id.insert(next_id, polygon.clone());
            adam.push(next_id);
            next_id += 1;
        }
    }

    adam.sort_by(|&a, &b| {
        let area_a = geometry::polygon::polygon_area(&parts_by_id[&a].points).abs();
        let area_b = geometry::polygon::polygon_area(&parts_by_id[&b].points).abs();
        area_b.total_cmp(&area_a)
    });

    (adam, parts_by_id)
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "lowercase")]
pub enum PlacementTypeDto {
    Gravity,
    Box,
    #[serde(rename = "convexhull")]
    ConvexHull,
}

impl From<PlacementTypeDto> for PlacementType {
    fn from(dto: PlacementTypeDto) -> Self {
        match dto {
            PlacementTypeDto::Gravity => PlacementType::Gravity,
            PlacementTypeDto::Box => PlacementType::Box,
            PlacementTypeDto::ConvexHull => PlacementType::ConvexHull,
        }
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct NestConfigDto {
    pub placement_type: PlacementTypeDto,
    pub rotations: u32,
    pub population_size: usize,
    pub mutation_rate: f64,
    #[serde(default = "default_dominant_part_area_threshold")]
    pub dominant_part_area_threshold: f64,
    #[serde(default = "default_curve_tolerance")]
    pub curve_tolerance: f64,
    pub generations: usize,
}

fn default_dominant_part_area_threshold() -> f64 {
    nesting::placement::DEFAULT_DOMINANT_PART_AREA_THRESHOLD
}

fn default_curve_tolerance() -> f64 {
    0.3
}

impl NestConfigDto {
    pub fn placement_config(&self) -> PlacementConfig {
        PlacementConfig {
            placement_type: self.placement_type.clone().into(),
            rotations: self.rotations,
            dominant_part_area_threshold: self.dominant_part_area_threshold,
            curve_tolerance: self.curve_tolerance,
        }
    }

    pub fn ga_config(&self) -> GaConfig {
        GaConfig { population_size: self.population_size, mutation_rate: self.mutation_rate, rotations: self.rotations }
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct RunNestRequest {
    pub sheets: Vec<PolygonDto>,
    pub parts: Vec<PartDto>,
    pub config: NestConfigDto,
}

#[derive(Serialize, Clone, Copy, Debug)]
pub struct PlacedPartDto {
    pub id: usize,
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
}

#[derive(Serialize, Clone, Debug)]
pub struct SheetPlacementDto {
    pub sheet_index: usize,
    pub parts: Vec<PlacedPartDto>,
}

#[derive(Serialize, Clone, Debug)]
pub struct RunNestResponse {
    pub placements: Vec<SheetPlacementDto>,
    pub fitness: f64,
    pub utilisation: f64,
    pub unplaced_count: usize,
}

