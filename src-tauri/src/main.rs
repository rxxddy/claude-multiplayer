#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod autostart;
mod chat_history;
mod claude;
mod git;
mod servers;
mod settings;
mod shell;
mod telemetry;
mod translate;
mod tray;
mod util;

use std::collections::HashMap;
use std::sync::Mutex;
use std::thread;
use tauri::{Manager, WindowEvent};

use crate::claude::UsageInfo;
use crate::git::CommitEntry;
use crate::settings::LocalSettings;
use crate::util::lock;

/// Shared between Tauri commands and the telemetry worker thread.
pub struct AppState {
    pub settings: Mutex<LocalSettings>,
    pub snapshot: Mutex<Option<telemetry::Snapshot>>,
    /// Commits detected by the worker and not yet handed to the UI.
    pub pending_commits: Mutex<Vec<CommitEntry>>,
    /// Last seen HEAD per repository, to detect new commits for the live feed.
    pub last_seen_heads: Mutex<HashMap<String, String>>,
    /// Repositories found in the projects folder (re-walked periodically).
    pub root_repos: Mutex<Vec<String>>,
    pub git_email: Mutex<Option<String>>,
    pub manual_topic: Mutex<Option<String>>,
    pub usage: Mutex<UsageInfo>,
    pub translations: Mutex<HashMap<String, String>>,
}

fn main() {
    let state = AppState {
        settings: Mutex::new(settings::load()),
        snapshot: Mutex::new(None),
        pending_commits: Mutex::new(Vec::new()),
        last_seen_heads: Mutex::new(HashMap::new()),
        root_repos: Mutex::new(Vec::new()),
        git_email: Mutex::new(None),
        manual_topic: Mutex::new(None),
        usage: Mutex::new(UsageInfo::unknown()),
        translations: Mutex::new(translate::load_cache()),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(state)
        .setup(|app| {
            let handle = app.handle().clone();
            let show_digits = lock(&app.state::<AppState>().settings).tray_enabled;
            let _ = tray::ensure(&handle, show_digits);
            // started by Windows at sign-in: stay in the tray
            if !std::env::args().any(|a| a == autostart::HIDDEN_FLAG) {
                tray::show_main(&handle);
            }
            thread::spawn(move || telemetry::run_worker(handle));
            Ok(())
        })
        .on_window_event(|window, event| {
            // closing the window only hides it; "Quit" lives in the tray menu
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            settings::init_cyberdeck,
            settings::set_language,
            servers::list_servers,
            servers::upsert_server,
            servers::remove_server,
            servers::set_active_server,
            servers::set_server_privacy,
            servers::set_server_token,
            servers::get_server_token,
            servers::save_login_password,
            servers::get_login_password,
            claude::set_custom_paths,
            claude::set_claude_md_consent,
            claude::set_manual_task_it,
            claude::extract_last_claude_snippet,
            git::set_projects_root,
            telemetry::collect_local_telemetry,
            telemetry::force_refresh,
            chat_history::load_local_chat_history,
            chat_history::append_local_chat_history,
            translate::translate_texts,
            tray::set_tray_enabled,
            autostart::autostart_status,
            autostart::set_autostart,
            shell::open_external,
            shell::open_screen_snip,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Claude Multiplayer");
}
