use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::State;

use crate::util::{app_home_dir, lock, now_secs, random_hex_id, sanitize_id};
use crate::{autostart, chat_history, claude, servers, AppState};

fn default_true() -> bool {
    true
}

/// What a server is allowed to receive. Disabled blocks are never sent (filtered in the client).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Privacy {
    #[serde(default = "default_true")]
    pub usage: bool,
    #[serde(default = "default_true")]
    pub commits: bool,
    #[serde(default = "default_true")]
    pub focus: bool,
    #[serde(default = "default_true")]
    pub commit_feed: bool,
}

impl Default for Privacy {
    fn default() -> Self {
        Self {
            usage: true,
            commits: true,
            focus: true,
            commit_feed: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerEntry {
    #[serde(default)]
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub privacy: Privacy,
    #[serde(default)]
    pub added_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LocalSettings {
    pub servers: Vec<ServerEntry>,
    pub active_server_id: Option<String>,
    pub custom_claude_dir: Option<String>,
    pub custom_focus_file: Option<String>,
    pub custom_claude_md: Option<String>,
    /// Path to claude.exe chosen by the user when it is not in a standard location.
    pub custom_claude_cli: Option<String>,
    pub autostart_enabled: bool,
    pub tray_enabled: bool,
    pub claude_md_consent: Option<bool>,
    /// Only git repositories inside this folder are counted.
    pub projects_root: Option<String>,
    /// UI language code; `None` follows the OS language.
    pub language: Option<String>,
}

impl Default for LocalSettings {
    fn default() -> Self {
        Self {
            servers: Vec::new(),
            active_server_id: None,
            custom_claude_dir: None,
            custom_focus_file: None,
            custom_claude_md: None,
            custom_claude_cli: None,
            autostart_enabled: true,
            tray_enabled: false,
            claude_md_consent: None,
            projects_root: None,
            language: None,
        }
    }
}

fn settings_path() -> PathBuf {
    app_home_dir().join("settings.json")
}

pub fn load() -> LocalSettings {
    let raw = fs::read_to_string(settings_path()).ok();
    let parsed = raw
        .as_deref()
        .and_then(|r| serde_json::from_str::<Value>(r).ok());
    if let Some(val) = parsed {
        if let Ok(mut cfg) = serde_json::from_value::<LocalSettings>(val.clone()) {
            // pre-multi-server versions stored a single `api_url`
            if val.get("servers").is_none() {
                migrate_single_server(&val, &mut cfg);
                save(&cfg);
            }
            return cfg;
        }
    }
    let cfg = LocalSettings::default();
    save(&cfg);
    cfg
}

pub fn save(cfg: &LocalSettings) {
    if let Ok(serialized) = serde_json::to_string_pretty(cfg) {
        let _ = fs::write(settings_path(), serialized);
    }
}

fn migrate_single_server(val: &Value, cfg: &mut LocalSettings) {
    let url = val
        .get("api_url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if url.is_empty() || url.contains("yourdomain.com") {
        return;
    }
    let Ok(url) = servers::validate_url(url) else {
        return;
    };
    let id = random_hex_id();
    let room = val
        .get("last_room_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let old_history = app_home_dir().join(format!("history_{}.jsonl", sanitize_id(room)));
    if !room.is_empty() && old_history.exists() {
        let _ = fs::rename(&old_history, chat_history::path_for(&id));
    }
    cfg.servers.push(ServerEntry {
        id: id.clone(),
        name: url.clone(),
        url,
        username: String::new(),
        privacy: Privacy::default(),
        added_at: now_secs(),
    });
    cfg.active_server_id = Some(id);
}

#[tauri::command(async)]
pub fn init_cyberdeck(state: State<'_, AppState>) -> Value {
    let cfg = lock(&state.settings).clone();
    let diagnostics =
        claude::ensure_focus_and_claude_md(&cfg).unwrap_or_else(|_| claude::diagnostics(&cfg));
    autostart::sync(cfg.autostart_enabled);
    json!({
        "settings": cfg,
        "diagnostics": diagnostics,
        "app_version": env!("CARGO_PKG_VERSION"),
        "needs_claude_md_consent": cfg.claude_md_consent.is_none(),
    })
}

#[tauri::command]
pub fn set_language(state: State<'_, AppState>, language: Option<String>) {
    let mut cfg = lock(&state.settings);
    cfg.language = language
        .map(|l| {
            l.chars()
                .filter(char::is_ascii_alphabetic)
                .take(8)
                .collect::<String>()
                .to_lowercase()
        })
        .filter(|l| !l.is_empty());
    save(&cfg);
}
