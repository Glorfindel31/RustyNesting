// Phase 6: first real Tauri commands (import_dxf, run_nest) - see
// docs/PORT_STATUS.md's Phase 6 table for what this does and doesn't cover
// yet (no progress events, no wiring of the legacy frontend/deepnest.js's
// ipcRenderer construction).
mod commands;
mod dto;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![commands::import_dxf_command, commands::run_nest_command, commands::export_dxf_command])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
