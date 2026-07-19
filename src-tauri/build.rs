fn main() {
    // `frontendDist` (tauri.conf.json) points at `../frontend` and gets
    // embedded into the binary at compile time (no `devUrl`/dev server
    // configured) - but Cargo only reruns this build script when it sees a
    // Rust-side change, so without this, editing frontend/*.js|html and
    // running `cargo build`/`cargo run` silently keeps serving the stale
    // embedded copy. Confirmed the hard way: several frontend fixes this
    // session never actually reached the running app until `build.rs` was
    // touched by hand to force a rebuild.
    println!("cargo:rerun-if-changed=../frontend");
    tauri_build::build()
}
