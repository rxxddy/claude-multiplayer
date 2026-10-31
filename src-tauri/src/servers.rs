//! Server list and per-server secrets. Session tokens and saved passwords live in the
//! Windows Credential Manager, never in settings.json.

use serde_json::{json, Value};
use std::fs;
use tauri::State;

use crate::settings::{self, Privacy, ServerEntry};
use crate::util::{lock, now_secs, random_hex_id, sanitize_id};
use crate::{chat_history, AppState};

/// Kept from the first releases so existing installs keep their saved logins.
const KEYRING_SERVICE: &str = "claude-cyberdeck";

fn keyring_entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, key).map_err(|e| format!("Credential store error: {e}"))
}

fn read_secret(key: &str) -> Option<String> {
    keyring_entry(key)
        .ok()?
        .get_password()
        .ok()
        .filter(|s| !s.is_empty())
}

fn delete_secret(key: &str) {
    if let Ok(entry) = keyring_entry(key) {
        let _ = entry.delete_credential();
    }
}

fn checked_id(id: &str) -> Result<&str, String> {
    if id.is_empty() || sanitize_id(id) != id {
        return Err("Invalid server id".to_string());
    }
    Ok(id)
}

fn password_key(id: &str) -> Result<String, String> {
    Ok(format!("pw-{}", checked_id(id)?))
}

/// https everywhere; plain http only for localhost and private LAN addresses.
pub fn validate_url(raw: &str) -> Result<String, String> {
    let url = raw.trim().to_string();
    let lower = url.to_ascii_lowercase();
    let rest = if let Some(r) = lower.strip_prefix("https://") {
        r
    } else if let Some(r) = lower.strip_prefix("http://") {
        let host_port = r.split(['/', '?', '#']).next().unwrap_or("");
        let host_port = host_port.rsplit('@').next().unwrap_or("");
        let host = if host_port.starts_with('[') {
            host_port
                .split(']')
                .next()
                .unwrap_or("")
                .trim_start_matches('[')
        } else {
            host_port.split(':').next().unwrap_or("")
        };
        if !is_private_host(host) {
            return Err("Insecure server URL: use https".to_string());
        }
        r
    } else {
        return Err("Server URL must start with https://".to_string());
    };
    if rest.is_empty() || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("Invalid server URL".to_string());
    }
    Ok(url)
}

fn is_private_host(host: &str) -> bool {
    if host == "localhost" || host == "::1" {
        return true;
    }
    let octets: Vec<u8> = host.split('.').filter_map(|p| p.parse().ok()).collect();
    if octets.len() != 4 || host.split('.').count() != 4 {
        return false;
    }
    matches!((octets[0], octets[1]), (127 | 10, _) | (192, 168))
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
}

fn server_view(s: &ServerEntry) -> Value {
    let mut v = serde_json::to_value(s).unwrap_or_else(|_| json!({}));
    v["has_token"] = json!(read_secret(&s.id).is_some());
    v
}

#[tauri::command(async)]
pub fn list_servers(state: State<'_, AppState>) -> Value {
    let cfg = lock(&state.settings).clone();
    let servers: Vec<Value> = cfg.servers.iter().map(server_view).collect();
    json!({ "servers": servers, "active_server_id": cfg.active_server_id })
}

#[tauri::command]
pub fn upsert_server(
    state: State<'_, AppState>,
    mut entry: ServerEntry,
) -> Result<ServerEntry, String> {
    entry.url = validate_url(&entry.url)?;
    entry.id = sanitize_id(&entry.id);
    entry.name = entry.name.trim().chars().take(80).collect();
    entry.username = entry.username.trim().chars().take(64).collect();
    if entry.name.is_empty() {
        entry.name.clone_from(&entry.url);
    }

    let mut cfg = lock(&state.settings);
    if let Some(existing) = cfg
        .servers
        .iter_mut()
        .find(|s| !entry.id.is_empty() && s.id == entry.id)
    {
        entry.added_at = existing.added_at;
        *existing = entry.clone();
    } else {
        if entry.id.is_empty() {
            entry.id = random_hex_id();
        }
        entry.added_at = now_secs();
        cfg.servers.push(entry.clone());
        if cfg.active_server_id.is_none() {
            cfg.active_server_id = Some(entry.id.clone());
        }
    }
    settings::save(&cfg);
    Ok(entry)
}

#[tauri::command(async)]
pub fn remove_server(state: State<'_, AppState>, id: String) {
    {
        let mut cfg = lock(&state.settings);
        cfg.servers.retain(|s| s.id != id);
        if cfg.active_server_id.as_deref() == Some(id.as_str()) {
            cfg.active_server_id = cfg.servers.first().map(|s| s.id.clone());
        }
        settings::save(&cfg);
    }
    let Ok(id) = checked_id(&id) else { return };
    delete_secret(id);
    if let Ok(key) = password_key(id) {
        delete_secret(&key);
    }
    let _ = fs::remove_file(chat_history::path_for(id));
}

#[tauri::command]
pub fn set_active_server(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut cfg = lock(&state.settings);
    if !cfg.servers.iter().any(|s| s.id == id) {
        return Err("Unknown server".to_string());
    }
    cfg.active_server_id = Some(id);
    settings::save(&cfg);
    Ok(())
}

#[tauri::command]
pub fn set_server_privacy(
    state: State<'_, AppState>,
    id: String,
    privacy: Privacy,
) -> Result<ServerEntry, String> {
    let mut cfg = lock(&state.settings);
    let entry = cfg
        .servers
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or("Unknown server")?;
    entry.privacy = privacy;
    let updated = entry.clone();
    settings::save(&cfg);
    Ok(updated)
}

#[tauri::command(async)]
pub fn set_server_token(id: String, token: Option<String>) -> Result<(), String> {
    let id = checked_id(&id)?;
    match token.filter(|t| !t.is_empty()) {
        Some(t) => keyring_entry(id)?
            .set_password(&t)
            .map_err(|e| format!("Cannot store token: {e}")),
        None => {
            delete_secret(id);
            Ok(())
        }
    }
}

#[tauri::command(async)]
pub fn get_server_token(id: String) -> Option<String> {
    read_secret(checked_id(&id).ok()?)
}

/// Servers have no password reset, so the password is kept locally to let the user recover it
/// (visible in Control Panel > Credential Manager).
#[tauri::command(async)]
pub fn save_login_password(id: String, password: String) -> Result<(), String> {
    let key = password_key(&id)?;
    if password.is_empty() {
        delete_secret(&key);
        return Ok(());
    }
    keyring_entry(&key)?
        .set_password(&password)
        .map_err(|e| format!("Cannot store password: {e}"))
}

#[tauri::command(async)]
pub fn get_login_password(id: String) -> Option<String> {
    read_secret(&password_key(&id).ok()?)
}
