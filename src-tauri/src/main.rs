// Phase 0: bare shell serving the copied frontend, zero real commands.
// See RUST-REWRITE-PLAN.md and docs/PORT_STATUS.md Phase 6 for the real
// Tauri command layer that replaces this.
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
