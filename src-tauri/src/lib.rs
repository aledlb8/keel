mod agent_hooks;
mod agents;
mod assistant;
mod assistant_agents;
mod assistant_mcp;
mod assistant_media;
mod blocking;
mod git;
mod git_ops;
mod grep;
mod hook_config;
mod paths;
mod preview;
mod procs;
mod pty;
mod roots;
mod sessions;
mod sqlite;
mod store;
mod telegram;
mod usage;
mod vpn;
mod vpn_profile;
mod vpn_proxy;
mod vpn_service;
mod watch;
mod workspace;

use tauri::{Emitter, Manager};

pub use agent_hooks::run_helper as run_agent_hook_helper;

use assistant::AssistantManager;
use pty::PtyManager;
use vpn::VpnManager;
use watch::WatchManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .register_asynchronous_uri_scheme_protocol(preview::SCHEME, preview::protocol)
        .setup(|app| {
            app.manage(WatchManager::new(app.handle().clone()));
            app.manage(AssistantManager::start(app.handle().clone()));
            // Tauri 2 does not wrap wry's with_browser_accelerator_keys.
            #[cfg(windows)]
            disable_browser_accelerator_keys(app);
            Ok(())
        })
        .manage(PtyManager::default())
        .manage(VpnManager::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            agents::detect_agents,
            agents::agent_catalogue_path,
            agents::agent_catalogue_defaults,
            agents::agent_catalogue_save,
            store::state_load,
            store::state_save,
            store::state_path,
            store::list_subdirectories,
            roots::project_pick,
            workspace::workspace_list,
            workspace::workspace_read,
            workspace::workspace_write,
            workspace::workspace_create,
            workspace::workspace_delete,
            workspace::workspace_rename,
            workspace::workspace_search,
            preview::workspace_read_bytes,
            sqlite::sqlite_tables,
            sqlite::sqlite_rows,
            sqlite::sqlite_query,
            grep::workspace_grep,
            grep::workspace_replace,
            watch::workspace_watch,
            watch::workspace_unwatch,
            git::git_status,
            git::git_diff,
            git::git_base,
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
            git_ops::git_commit_details,
            git_ops::git_diff_rev,
            git_ops::git_head_message,
            git_ops::git_undo_commit,
            git_ops::git_stash_list,
            git_ops::git_stash_push,
            git_ops::git_stash_apply,
            git_ops::git_stash_drop,
            git_ops::git_tags,
            git_ops::git_tag_create,
            git_ops::git_tag_delete,
            git_ops::git_tag_push,
            git_ops::git_branch_rename,
            git_ops::git_checkout_remote,
            git_ops::git_checkout_rev,
            git_ops::git_branch_delete_remote,
            git_ops::git_merge,
            git_ops::git_rebase,
            git_ops::git_cherry_pick,
            git_ops::git_revert,
            git_ops::git_reset,
            git_ops::git_operation,
            git_ops::git_resolve,
            git_ops::git_ignore,
            git_ops::git_remotes,
            git_ops::git_init,
            git_ops::git_apply_lines,
            usage::usage_fetch,
            vpn::vpn_snapshot,
            vpn::vpn_connect,
            vpn::vpn_disconnect,
            assistant::assistant_snapshot,
            assistant::assistant_log,
            assistant::assistant_set_token,
            assistant::assistant_pair,
            assistant::assistant_unpair,
            assistant::assistant_configure,
            assistant::assistant_check_voice,
            assistant::assistant_new_conversation,
            assistant::assistant_stop,
            assistant::assistant_send,
            assistant::assistant_tool_result,
            assistant::assistant_pane_event,
        ])
        .on_window_event(|window, event| {
            // CloseRequested is a *request*. Killing PTYs here would destroy
            // unsaved work before the UI can ask. The frontend confirms, then
            // destroys the window; Destroyed is what tears children down.
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.emit("app:close-requested", ());
                }
                tauri::WindowEvent::Destroyed => {
                    shutdown_managed(window.app_handle());
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                shutdown_managed(app);
            }
        });
}

/// Turn off WebView2's F5 / Ctrl+R / zoom chords so they cannot reload this webview.
#[cfg(windows)]
fn disable_browser_accelerator_keys(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.with_webview(|webview| {
        let _ = disable_webview2_accelerator_keys(webview);
    });
}

#[cfg(windows)]
fn disable_webview2_accelerator_keys(
    webview: tauri::webview::PlatformWebview,
) -> windows_core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    unsafe {
        webview
            .controller()
            .CoreWebView2()?
            .Settings()?
            .cast::<ICoreWebView2Settings3>()?
            .SetAreBrowserAcceleratorKeysEnabled(false)
    }
}

fn shutdown_managed(app: &tauri::AppHandle) {
    if let Some(manager) = app.try_state::<PtyManager>() {
        manager.shutdown_all();
    }
    if let Some(vpn) = app.try_state::<VpnManager>() {
        vpn.shutdown();
    }
    if let Some(watch) = app.try_state::<WatchManager>() {
        watch.shutdown();
    }
    if let Some(assistant) = app.try_state::<AssistantManager>() {
        assistant.shutdown();
    }
}
