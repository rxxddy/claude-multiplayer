//! Start with Windows: an `HKCU\...\Run` entry that launches the app with `--autostart`,
//! which keeps the window hidden (tray icon only). Dev builds never touch it, so
//! `target\debug` cannot end up in the user's startup list.

use serde_json::{json, Value};
use tauri::State;

use crate::util::lock;
use crate::{settings, AppState};

pub const HIDDEN_FLAG: &str = "--autostart";
#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const VALUE_NAME: &str = "ClaudeMultiplayer";

/// Called on every start so the entry follows the exe after updates or moves.
pub fn sync(enabled: bool) {
    let _ = apply(enabled);
}

#[cfg(windows)]
fn apply(enable: bool) -> Result<(), String> {
    use crate::util::silent_command;

    if cfg!(debug_assertions) {
        return Err("Autostart is disabled in development builds.".to_string());
    }
    // older releases used a .cmd in the Startup folder (flashed a console, opened the window)
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let legacy = std::path::Path::new(&appdata)
            .join("Microsoft/Windows/Start Menu/Programs/Startup/ClaudeCyberdeck.cmd");
        let _ = std::fs::remove_file(legacy);
    }
    let status = if enable {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let command = format!("\"{}\" {HIDDEN_FLAG}", exe.display());
        silent_command("reg")
            .args([
                "add", RUN_KEY, "/v", VALUE_NAME, "/t", "REG_SZ", "/d", &command, "/f",
            ])
            .status()
    } else {
        silent_command("reg")
            .args(["delete", RUN_KEY, "/v", VALUE_NAME, "/f"])
            .status()
    }
    .map_err(|e| e.to_string())?;
    if enable && !status.success() {
        return Err("Could not write the Windows startup entry.".to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
fn apply(_enable: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn is_registered() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let exe = exe.display().to_string().to_lowercase();
    crate::util::silent_command("reg")
        .args(["query", RUN_KEY, "/v", VALUE_NAME])
        .output()
        .is_ok_and(|o| {
            o.status.success()
                && String::from_utf8_lossy(&o.stdout)
                    .to_lowercase()
                    .contains(&exe)
        })
}

#[cfg(not(windows))]
fn is_registered() -> bool {
    false
}

#[tauri::command(async)]
pub fn autostart_status() -> Value {
    json!({ "registered": is_registered(), "dev_build": cfg!(debug_assertions) })
}

#[tauri::command(async)]
pub fn set_autostart(state: State<'_, AppState>, enabled: bool) -> Result<bool, String> {
    apply(enabled)?;
    let mut cfg = lock(&state.settings);
    cfg.autostart_enabled = enabled;
    settings::save(&cfg);
    Ok(is_registered())
}
