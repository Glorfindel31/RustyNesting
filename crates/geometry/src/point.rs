//! Port of main/util/point.ts. `marked` mirrors the JS `Point.marked?: boolean`
//! field used by the NFP-tracing algorithm to avoid revisiting vertices.

#[derive(Clone, Copy, Debug)]
pub struct Point {
    pub x: f64,
    pub y: f64,
    pub marked: bool,
}

/// Manual, not derived: equality is geometric identity (`x`/`y`) only.
/// `marked` is mutable NFP-tracing bookkeeping, not part of what makes two
/// points "the same point" - a derived `PartialEq` would make two points at
/// the exact same coordinates compare unequal purely because one has been
/// visited by the NFP tracer and the other hasn't, which is never the
/// intent of any equality check in this codebase (confirmed: nothing relies
/// on `marked` participating in equality - see the code review this fixed).
impl PartialEq for Point {
    fn eq(&self, other: &Self) -> bool {
        self.x == other.x && self.y == other.y
    }
}

impl Point {
    pub fn new(x: f64, y: f64) -> Self {
        Point { x, y, marked: false }
    }

    pub fn squared_distance_to(&self, other: Point) -> f64 {
        (self.x - other.x).powi(2) + (self.y - other.y).powi(2)
    }

    pub fn distance_to(&self, other: Point) -> f64 {
        self.squared_distance_to(other).sqrt()
    }

    pub fn within_distance(&self, other: Point, distance: f64) -> bool {
        self.squared_distance_to(other) < distance * distance
    }

    pub fn midpoint(&self, other: Point) -> Point {
        Point::new((self.x + other.x) / 2.0, (self.y + other.y) / 2.0)
    }
}

impl From<(f64, f64)> for Point {
    fn from((x, y): (f64, f64)) -> Self {
        Point::new(x, y)
    }
}
