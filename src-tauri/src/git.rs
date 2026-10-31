//! Commit counting. Only repositories inside the user's projects folder are scanned, and only
//! commits authored with the global `user.email` count. Nothing but the totals leaves the machine.

use chrono::{Datelike, Duration, Local, TimeZone};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::State;

use crate::util::{lock, silent_command};
use crate::{settings, telemetry, AppState};

const MAX_DEPTH: u32 = 4;
const MAX_REPOS: usize = 500;
const SKIPPED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "vendor",
    "venv",
    "dist",
    "build",
    "__pycache__",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitEntry {
    pub project: String,
    pub branch: String,
    pub short_hash: String,
    pub message: String,
    pub timestamp: String,
}

pub struct ScanResult {
    pub commits_day: usize,
    pub commits_week: usize,
    pub new_commits: Vec<CommitEntry>,
    pub branch: String,
}

pub fn find_repos(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    walk(root, MAX_DEPTH, &mut out);
    out
}

fn walk(dir: &Path, depth: u32, out: &mut Vec<String>) {
    if out.len() >= MAX_REPOS {
        return;
    }
    if dir.join(".git").exists() {
        out.push(dir.to_string_lossy().into_owned());
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_dir() || kind.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if name.starts_with('.') || SKIPPED_DIRS.contains(&name.as_str()) {
            continue;
        }
        walk(&entry.path(), depth - 1, out);
    }
}

/// Local midnight today and on Monday, RFC 3339 (what `git log --since` expects).
pub fn day_and_week_start() -> (String, String) {
    let now = Local::now();
    let today = Local
        .with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0)
        .single()
        .unwrap_or(now);
    let monday = today - Duration::days(i64::from(now.weekday().num_days_from_monday()));
    (today.to_rfc3339(), monday.to_rfc3339())
}

pub fn global_email(cache: &Mutex<Option<String>>) -> String {
    let mut cached = lock(cache);
    cached
        .get_or_insert_with(|| {
            silent_command("git")
                .args(["config", "--global", "user.email"])
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .unwrap_or_default()
        })
        .clone()
}

fn git_lines(repo: &str, args: &[&str]) -> Vec<String> {
    silent_command("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

fn commit_hashes(repo: &str, since: &str, email: &str, into: &mut HashSet<String>) {
    let since = format!("--since={since}");
    let author = format!("--author={email}");
    let mut args = vec!["log", "--all", since.as_str(), "--format=%H"];
    if !email.is_empty() {
        args.push(author.as_str());
    }
    into.extend(git_lines(repo, &args));
}

/// Counts today's / this week's commits and reports HEAD changes since the previous scan
/// (those feed the live commit feed). The first scan of a repo only records its HEAD.
pub fn scan(
    repos: &[String],
    email: &str,
    last_heads: &Mutex<HashMap<String, String>>,
) -> ScanResult {
    let (day_start, week_start) = day_and_week_start();
    let mut day = HashSet::new();
    let mut week = HashSet::new();
    let mut new_commits = Vec::new();
    let mut branch = "main".to_string();
    let mut heads = lock(last_heads);

    for repo in repos {
        let path = Path::new(repo);
        if !path.exists() {
            continue;
        }
        if let Some(b) = git_lines(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).pop() {
            branch = b;
        }
        commit_hashes(repo, &day_start, email, &mut day);
        commit_hashes(repo, &week_start, email, &mut week);

        let Some(head) = git_lines(repo, &["log", "-1", "--format=%H|%h|%s"]).pop() else {
            continue;
        };
        let mut parts = head.splitn(3, '|');
        let (Some(full), Some(short), Some(subject)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let previous = heads.insert(repo.clone(), full.to_string());
        if previous.is_some_and(|p| p != full) {
            new_commits.push(CommitEntry {
                project: path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("repo")
                    .to_string(),
                branch: branch.clone(),
                short_hash: short.to_string(),
                message: subject.chars().take(72).collect(),
                timestamp: Local::now().format("%H:%M").to_string(),
            });
        }
    }

    ScanResult {
        commits_day: day.len(),
        commits_week: week.len(),
        new_commits,
        branch,
    }
}

#[tauri::command(async)]
pub fn set_projects_root(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<Vec<String>, String> {
    let root = path
        .map(|p| p.trim().trim_matches('"').to_string())
        .filter(|p| !p.is_empty());
    let found = match &root {
        Some(r) if !Path::new(r).is_dir() => return Err(format!("Folder does not exist: {r}")),
        Some(r) => find_repos(Path::new(r)),
        None => Vec::new(),
    };
    {
        let mut cfg = lock(&state.settings);
        cfg.projects_root = root;
        settings::save(&cfg);
    }
    lock(&state.root_repos).clone_from(&found);
    // new set of repos: their current HEADs are a baseline, not "new commits"
    lock(&state.last_seen_heads).clear();
    telemetry::FORCE_REFRESH.store(true, Ordering::SeqCst);
    Ok(found)
}
