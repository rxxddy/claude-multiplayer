//! Launching other programs. Kept deliberately narrow: the webview cannot open arbitrary URLs.

use crate::util::silent_command;

/// Only the project owner's GitHub pages. The charset check keeps `cmd start` free of shell
/// metacharacters.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let allowed_prefix =
        url == "https://github.com/rxxddy" || url.starts_with("https://github.com/rxxddy/");
    let safe_chars = url
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '/' | '.' | '_' | '-'));
    if !allowed_prefix || !safe_chars || url.contains("..") {
        return Err("URL not allowed".to_string());
    }
    silent_command("cmd")
        .args(["/C", "start", "", &url])
        .spawn()
        .map(drop)
        .map_err(|e| e.to_string())
}

/// Fallback for laptops whose PrtSc key never reaches Windows while the webview has focus.
#[tauri::command]
pub fn open_screen_snip() {
    let _ = silent_command("cmd")
        .args(["/C", "start", "", "ms-screenclip:"])
        .spawn();
}
