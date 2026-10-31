//! Local chat cache per server (JSON lines), so a tab shows its history instantly on start.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

use crate::util::{app_home_dir, sanitize_id};

const MAX_MESSAGES: usize = 2000;

pub fn path_for(server_id: &str) -> PathBuf {
    app_home_dir().join(format!("history_{}.jsonl", sanitize_id(server_id)))
}

fn message_id(msg: &Value) -> Option<i64> {
    msg.get("id").and_then(Value::as_i64)
}

fn read_lines(path: &PathBuf) -> Vec<String> {
    File::open(path)
        .map(|f| {
            BufReader::new(f)
                .lines()
                .map_while(Result::ok)
                .filter(|l| !l.trim().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command(async)]
pub fn load_local_chat_history(room_id: String) -> Value {
    if sanitize_id(&room_id).is_empty() {
        return json!({ "messages": [], "last_msg_id": 0 });
    }
    let mut messages: Vec<Value> = read_lines(&path_for(&room_id))
        .iter()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let last_id = messages
        .iter()
        .filter_map(message_id)
        .max()
        .unwrap_or(0)
        .max(0);
    if messages.len() > MAX_MESSAGES {
        messages.drain(..messages.len() - MAX_MESSAGES);
    }
    json!({ "messages": messages, "last_msg_id": last_id })
}

/// Appends messages not cached yet and returns the highest known message id.
#[tauri::command(async)]
pub fn append_local_chat_history(room_id: String, new_messages: Vec<Value>) -> Result<i64, String> {
    if new_messages.is_empty() || sanitize_id(&room_id).is_empty() {
        return Ok(0);
    }
    let path = path_for(&room_id);
    let mut lines = read_lines(&path);
    let mut known_ids = HashSet::new();
    let mut max_id: i64 = 0;
    for id in lines
        .iter()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|m| message_id(&m))
    {
        known_ids.insert(id);
        max_id = max_id.max(id);
    }

    let before = lines.len();
    for msg in new_messages {
        let id = message_id(&msg).unwrap_or(0);
        if id > 0 && !known_ids.insert(id) {
            continue;
        }
        max_id = max_id.max(id);
        if let Ok(line) = serde_json::to_string(&msg) {
            lines.push(line);
        }
    }

    let write_err = |e: std::io::Error| format!("Failed writing local history: {e}");
    if lines.len() > MAX_MESSAGES {
        // rewrite through a temp file so a crash never leaves a truncated cache
        lines.drain(..lines.len() - MAX_MESSAGES);
        let tmp = path.with_extension("jsonl.tmp");
        fs::write(&tmp, lines.join("\n") + "\n").map_err(write_err)?;
        fs::rename(&tmp, &path).map_err(write_err)?;
    } else if lines.len() > before {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(write_err)?;
        for line in &lines[before..] {
            writeln!(file, "{line}").map_err(write_err)?;
        }
    }
    Ok(max_id)
}
