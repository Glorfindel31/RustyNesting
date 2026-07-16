//! Pure geometry math: Clipper2 wrapper, NFP-tracing primitives, DXF import.
//! Zero I/O, zero threading — see RUST-REWRITE-PLAN.md Phase 1.

pub mod circular_nfp;
pub mod clipper;
pub mod dxf_import;
pub mod nfp;
pub mod point;
pub mod polygon;
pub mod simplify;

pub use point::Point;
