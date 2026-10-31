//! Everything read from (or written to) Claude Code's local files: session logs, the focus
//! file with the current task topic, the optional CLAUDE.md instruction and `/usage`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

use crate::settings::{self, LocalSettings};
use crate::util::{app_home_dir, lock, now_secs, silent_command};
use crate::AppState;

/// Marks our block in CLAUDE.md. The text is kept from older releases so their block is still found.
const CLAUDE_MD_MARKER: &str = "# CYBERDECK MULTIPLAYER SYNC";
/// First words of the block's last line; everything between marker and this line is ours.
const CLAUDE_MD_LAST_LINE: &str = "Keep the topic general";
const CONTEXT_WINDOW: u64 = 200_000;
const LARGE_CONTEXT_WINDOW: u64 = 1_000_000;
const DEFAULT_TOPIC: &str = "Waiting for activity";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PathDiagnostics {
    pub claude_dir_path: String,
    pub claude_dir_exists: bool,
    pub claude_md_path: String,
    pub claude_md_exists: bool,
    pub focus_file_path: String,
    pub focus_file_exists: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct UsageInfo {
    pub session_pct: i32,
    pub week_pct: i32,
    pub session_reset: String,
    pub week_reset: String,
    pub fetched_at: u64,
}

impl UsageInfo {
    pub fn unknown() -> Self {
        Self {
            session_pct: -1,
            week_pct: -1,
            ..Default::default()
        }
    }
}

pub struct SessionState {
    pub ctx_pct: u32,
    pub status: &'static str,
    pub cwd: Option<String>,
}

fn non_empty(path: Option<&String>) -> Option<PathBuf> {
    path.map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
}

pub fn claude_dir(cfg: &LocalSettings) -> PathBuf {
    non_empty(cfg.custom_claude_dir.as_ref())
        .or_else(|| {
            std::env::var("CLAUDE_CONFIG_DIR")
                .ok()
                .filter(|d| !d.trim().is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".claude")
        })
}

pub fn focus_file(cfg: &LocalSettings) -> PathBuf {
    non_empty(cfg.custom_focus_file.as_ref())
        .unwrap_or_else(|| app_home_dir().join("current_focus.json"))
}

fn claude_md(cfg: &LocalSettings) -> PathBuf {
    non_empty(cfg.custom_claude_md.as_ref()).unwrap_or_else(|| claude_dir(cfg).join("CLAUDE.md"))
}

pub fn diagnostics(cfg: &LocalSettings) -> PathDiagnostics {
    let dir = claude_dir(cfg);
    let md = claude_md(cfg);
    let focus = focus_file(cfg);
    PathDiagnostics {
        claude_dir_exists: dir.is_dir(),
        claude_dir_path: dir.to_string_lossy().into_owned(),
        claude_md_exists: md.is_file(),
        claude_md_path: md.to_string_lossy().into_owned(),
        focus_file_exists: focus.is_file(),
        focus_file_path: focus.to_string_lossy().into_owned(),
    }
}

pub fn ensure_focus_and_claude_md(cfg: &LocalSettings) -> Result<PathDiagnostics, String> {
    let focus = focus_file(cfg);
    if let Some(parent) = focus.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create focus dir: {e}"))?;
    }
    if !focus.exists() {
        let initial = json!({ "project": "workspace", "topic": DEFAULT_TOPIC });
        fs::write(&focus, initial.to_string())
            .map_err(|e| format!("Cannot create focus file at {}: {e}", focus.display()))?;
    }
    if cfg.claude_md_consent == Some(true) {
        write_claude_md_block(cfg)?;
    }
    Ok(diagnostics(cfg))
}

fn claude_md_block(cfg: &LocalSettings) -> String {
    let focus = focus_file(cfg).to_string_lossy().replace('\\', "/");
    format!(
        "\n{CLAUDE_MD_MARKER}\n\
        Whenever you start a new task or the user changes the high-level conversation topic, \
        silently write a single-line JSON to `{focus}` with a concise 3-5 word \
        high-level chat title, always written in English (the app translates it for other people):\n\
        `{{\"project\": \"<current_folder_name>\", \"topic\": \"<3-5 word chat title in English, e.g. Refactoring order webhooks>\"}}`\n\
        {CLAUDE_MD_LAST_LINE} and always in English rather than micro-commands.\n"
    )
}

fn write_claude_md_block(cfg: &LocalSettings) -> Result<(), String> {
    let path = claude_md(cfg);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let block = claude_md_block(cfg);
    let existing = fs::read_to_string(&path).unwrap_or_default();
    if existing.contains(&block) {
        return Ok(());
    }
    if existing.contains(CLAUDE_MD_MARKER) {
        // an older wording of our block (older releases asked for Italian topics)
        remove_claude_md_block(cfg)?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| f.write_all(block.as_bytes()))
        .map_err(|e| format!("Cannot write to CLAUDE.md at {}: {e}", path.display()))
}

/// Removes only our block, leaving the rest of the user's CLAUDE.md untouched.
fn remove_claude_md_block(cfg: &LocalSettings) -> Result<(), String> {
    let path = claude_md(cfg);
    let Ok(existing) = fs::read_to_string(&path) else {
        return Ok(());
    };
    let exact = claude_md_block(cfg);
    let updated = if existing.contains(&exact) {
        existing.replacen(&exact, "", 1)
    } else {
        let mut kept: Vec<&str> = Vec::new();
        let mut skipping = false;
        let mut removed = false;
        for line in existing.split_inclusive('\n') {
            if !removed && !skipping && line.trim_end() == CLAUDE_MD_MARKER {
                skipping = true;
                if kept.last().is_some_and(|l| l.trim().is_empty()) {
                    kept.pop();
                }
            } else if skipping {
                if line.starts_with(CLAUDE_MD_LAST_LINE) {
                    skipping = false;
                    removed = true;
                }
            } else {
                kept.push(line);
            }
        }
        if !removed {
            return Ok(());
        }
        kept.concat()
    };
    fs::write(&path, updated).map_err(|e| format!("Cannot update CLAUDE.md: {e}"))
}

pub fn collect_session_logs(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_session_logs(&path, out);
        } else if path.extension().is_some_and(|e| e == "jsonl") {
            out.push(path);
        }
    }
}

fn modified_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

fn tokens_in(usage: &Value) -> u64 {
    ["input_tokens", "cache_read_input_tokens", "output_tokens"]
        .iter()
        .map(|k| usage.get(k).and_then(Value::as_u64).unwrap_or(0))
        .sum()
}

/// Context fill, activity status and working directory of the most recently active session.
pub fn session_state(cfg: &LocalSettings) -> SessionState {
    let mut logs = Vec::new();
    collect_session_logs(&claude_dir(cfg).join("projects"), &mut logs);
    let Some((latest, mtime)) = logs
        .into_iter()
        .map(|p| (modified_secs(&p), p))
        .max_by_key(|(t, _)| *t)
        .map(|(t, p)| (p, t))
    else {
        return SessionState {
            ctx_pct: 0,
            status: "IDLE",
            cwd: None,
        };
    };

    let mut ctx_tokens = 0;
    let mut cwd = None;
    if let Ok(file) = File::open(&latest) {
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(val) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some(dir) = val
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|d| !d.is_empty())
            {
                cwd = Some(dir.to_string());
            }
            if let Some(usage) = val.pointer("/message/usage") {
                ctx_tokens = tokens_in(usage);
            }
        }
    }

    // anything above 200k can only be a 1M-context model
    let window = if ctx_tokens > CONTEXT_WINDOW {
        LARGE_CONTEXT_WINDOW
    } else {
        CONTEXT_WINDOW
    };
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss
    )]
    let ctx_pct = ((ctx_tokens as f64 / window as f64) * 100.0)
        .round()
        .clamp(0.0, 100.0) as u32;
    let status = if ctx_pct >= 90 {
        "OVERHEAT"
    } else if now_secs().saturating_sub(mtime) <= 10 {
        "WORKING"
    } else {
        "IDLE"
    };
    SessionState {
        ctx_pct,
        status,
        cwd,
    }
}

/// Project name and task topic: the focus file wins over the session's folder name,
/// a topic typed by the user wins over both.
pub fn focus(
    cfg: &LocalSettings,
    session_cwd: Option<&str>,
    manual_topic: Option<&str>,
) -> (String, String) {
    let mut project = session_cwd
        .and_then(|p| Path::new(p).file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("workspace")
        .to_string();
    let mut topic = DEFAULT_TOPIC.to_string();

    let saved = fs::read_to_string(focus_file(cfg))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let field = |key: &str| {
        saved
            .as_ref()
            .and_then(|v| v.get(key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
    };
    if let Some(p) = field("project") {
        project = p;
    }
    if let Some(t) = field("topic") {
        topic = t;
    }
    if let Some(t) = manual_topic.map(str::trim).filter(|t| !t.is_empty()) {
        topic = t.to_string();
    }
    (project, topic)
}

/// Parses `claude -p "/usage"`, e.g. "Current session: 11% used · resets 3pm (Europe/Rome)".
pub fn fetch_usage() -> Option<UsageInfo> {
    let out = silent_command("cmd")
        .args(["/C", "claude", "-p", "/usage"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let parse = |prefix: &str| -> Option<(i32, String)> {
        let line = text.lines().find(|l| l.trim_start().starts_with(prefix))?;
        let after = line.split(':').nth(1)?.trim();
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        let reset = line.split("resets").nth(1).unwrap_or("").trim();
        let reset = match reset.rfind('(') {
            Some(i) if reset.ends_with(')') => reset[..i].trim(),
            _ => reset,
        };
        Some((digits.parse().ok()?, reset.to_string()))
    };
    let (session_pct, session_reset) = parse("Current session")?;
    let (week_pct, week_reset) = parse("Current week").unwrap_or((-1, String::new()));
    Some(UsageInfo {
        session_pct,
        week_pct,
        session_reset,
        week_reset,
        fetched_at: now_secs(),
    })
}

#[tauri::command(async)]
pub fn set_custom_paths(
    state: State<'_, AppState>,
    claude_dir: Option<String>,
    focus_file: Option<String>,
    claude_md: Option<String>,
) -> Result<PathDiagnostics, String> {
    let to_setting = |v: String| Some(v.trim().to_string()).filter(|s| !s.is_empty());
    let mut cfg = lock(&state.settings);
    if let Some(dir) = claude_dir {
        let dir = to_setting(dir);
        if let Some(d) = dir.as_deref().filter(|d| !Path::new(d).exists()) {
            return Err(format!("Directory does not exist: {d}"));
        }
        cfg.custom_claude_dir = dir;
    }
    if let Some(file) = focus_file {
        cfg.custom_focus_file = to_setting(file);
    }
    if let Some(md) = claude_md {
        cfg.custom_claude_md = to_setting(md);
    }
    settings::save(&cfg);
    ensure_focus_and_claude_md(&cfg)
}

#[tauri::command(async)]
pub fn set_claude_md_consent(
    state: State<'_, AppState>,
    consent: bool,
) -> Result<PathDiagnostics, String> {
    let cfg = {
        let mut cfg = lock(&state.settings);
        cfg.claude_md_consent = Some(consent);
        settings::save(&cfg);
        cfg.clone()
    };
    if consent {
        write_claude_md_block(&cfg)?;
    } else {
        remove_claude_md_block(&cfg)?;
    }
    Ok(diagnostics(&cfg))
}

/// The task typed in the profile overrides what Claude reports; also persisted to the focus file.
#[tauri::command]
pub fn set_manual_task_it(state: State<'_, AppState>, task_it: String) {
    let topic = task_it.trim().to_string();
    *lock(&state.manual_topic) = Some(topic.clone()).filter(|t| !t.is_empty());
    if topic.is_empty() {
        return;
    }
    let cfg = lock(&state.settings).clone();
    let (project, _) = focus(&cfg, None, None);
    let _ = fs::write(
        focus_file(&cfg),
        json!({ "project": project, "topic": topic }).to_string(),
    );
}

/// Text of the last assistant message in the most recent session, for sharing as a snippet.
#[tauri::command(async)]
pub fn extract_last_claude_snippet(state: State<'_, AppState>) -> Result<String, String> {
    let cfg = lock(&state.settings).clone();
    let mut logs = Vec::new();
    collect_session_logs(&claude_dir(&cfg).join("projects"), &mut logs);
    let latest = logs
        .into_iter()
        .max_by_key(|p| {
            fs::metadata(p)
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH)
        })
        .ok_or("No active Claude Code session logs found. Verify ~/.claude path in Settings.")?;

    let file = File::open(&latest).map_err(|e| format!("Failed opening session log: {e}"))?;
    let mut last_text = String::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(val) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if val.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(blocks) = val.pointer("/message/content").and_then(Value::as_array) else {
            continue;
        };
        let text: Vec<&str> = blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect();
        let text = text.join("\n");
        if !text.trim().is_empty() {
            last_text = text.trim().to_string();
        }
    }
    if last_text.is_empty() {
        return Err("No assistant text blocks found in the current Claude session.".to_string());
    }
    Ok(last_text.chars().take(6000).collect())
}
