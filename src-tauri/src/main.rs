// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if keel_lib::run_agent_hook_helper() {
        return;
    }
    keel_lib::run()
}
