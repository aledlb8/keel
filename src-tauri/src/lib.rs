mod agents;
mod pty;
mod store;

use tauri::Manager;

use pty::PtyManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_alive,
            agents::detect_agents,
            agents::agent_catalogue_path,
            store::state_load,
            store::state_save,
            store::state_path,
            store::list_subdirectories,
            store::path_exists,
        ])
        .on_window_event(|window, event| {
            // Closing the window must take every child process with it, or the
            // agents keep running headless.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(manager) = window.app_handle().try_state::<PtyManager>() {
                    manager.shutdown_all();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
