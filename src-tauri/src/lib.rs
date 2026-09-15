mod agents;
mod blocking;
mod git;
mod paths;
mod procs;
mod pty;
mod sessions;
mod store;
mod usage;
mod vpn;
mod vpn_profile;
mod vpn_proxy;
mod vpn_service;
mod workspace;

use tauri::Manager;

use pty::PtyManager;
use vpn::VpnManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyManager::default())
        .manage(VpnManager::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_alive,
            agents::detect_agents,
            agents::agent_catalogue_path,
            agents::agent_catalogue_defaults,
            agents::agent_catalogue_save,
            store::state_load,
            store::state_save,
            store::state_path,
            store::list_subdirectories,
            store::path_exists,
            workspace::workspace_list,
            workspace::workspace_read,
            workspace::workspace_write,
            workspace::workspace_create,
            workspace::workspace_delete,
            workspace::workspace_rename,
            workspace::workspace_search,
            git::git_status,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_push,
            git::git_pull,
            git::git_fetch,
            git::git_branches,
            git::git_checkout,
            git::git_branch_create,
            git::git_branch_delete,
            git::git_log,
            git::pr_list,
            git::pr_create,
            git::pr_checkout,
            sessions::session_recent,
            usage::usage_fetch,
            vpn::vpn_snapshot,
            vpn::vpn_connect,
            vpn::vpn_disconnect,
        ])
        .on_window_event(|window, event| {
            // Closing the window must take every child process with it, or the
            // agents keep running headless. The private OpenVPN tunnel is the
            // same: it exists only for this app.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(manager) = window.app_handle().try_state::<PtyManager>() {
                    manager.shutdown_all();
                }
                if let Some(vpn) = window.app_handle().try_state::<VpnManager>() {
                    vpn.shutdown();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
