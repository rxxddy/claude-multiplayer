//! Machine translation of other people's task topics (Claude Code always writes them in English).
//! Uses the free MyMemory API: no key, and only the short topic text is sent. Results are cached
//! on disk so each topic is translated once per language.

use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::State;

use crate::util::{app_home_dir, lock};
use crate::AppState;

const MAX_TEXTS_PER_CALL: usize = 50;
const MAX_TEXT_CHARS: usize = 200;
const MAX_CACHE_ENTRIES: usize = 5000;

fn cache_path() -> PathBuf {
    app_home_dir().join("translations.json")
}

pub fn load_cache() -> HashMap<String, String> {
    fs::read_to_string(cache_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn fetch(text: &str, target: &str) -> Option<String> {
    let resp: Value = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .build()
        .get("https://api.mymemory.translated.net/get")
        .query("q", text)
        .query("langpair", &format!("en|{target}"))
        .call()
        .ok()?
        .into_json()
        .ok()?;
    if resp
        .get("responseStatus")
        .and_then(Value::as_i64)
        .unwrap_or(200)
        != 200
    {
        return None;
    }
    let translated = resp
        .pointer("/responseData/translatedText")?
        .as_str()?
        .trim();
    // quota exhaustion comes back as a "translation" with a warning text
    if translated.is_empty() || translated.to_ascii_uppercase().contains("MYMEMORY WARNING") {
        return None;
    }
    Some(translated.chars().take(MAX_TEXT_CHARS).collect())
}

/// Translates English texts into `target` (e.g. "it"). Texts that could not be translated
/// are left out of the result and the UI keeps showing the original.
#[tauri::command(async)]
pub fn translate_texts(
    state: State<'_, AppState>,
    texts: Vec<String>,
    target: String,
) -> HashMap<String, String> {
    let target: String = target
        .chars()
        .filter(|c| c.is_ascii_alphabetic() || *c == '-')
        .take(8)
        .collect::<String>()
        .to_lowercase();
    let mut out = HashMap::new();
    if target.is_empty() || target == "en" {
        return out;
    }

    let mut cache_changed = false;
    for text in texts.into_iter().take(MAX_TEXTS_PER_CALL) {
        let text = text.trim().to_string();
        if text.is_empty() || text.chars().count() > MAX_TEXT_CHARS || out.contains_key(&text) {
            continue;
        }
        let key = format!("{target}|{text}");
        let cached = lock(&state.translations).get(&key).cloned();
        let translated = match cached {
            Some(t) => t,
            None => {
                let Some(t) = fetch(&text, &target) else {
                    continue;
                };
                let mut cache = lock(&state.translations);
                if cache.len() > MAX_CACHE_ENTRIES {
                    cache.clear();
                }
                cache.insert(key, t.clone());
                cache_changed = true;
                t
            }
        };
        out.insert(text, translated);
    }

    if cache_changed {
        if let Ok(json) = serde_json::to_string(&*lock(&state.translations)) {
            let _ = fs::write(cache_path(), json);
        }
    }
    out
}
