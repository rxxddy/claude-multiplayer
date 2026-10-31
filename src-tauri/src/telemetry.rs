//! Background worker that keeps a snapshot of local activity. All disk, git and CLI work
//! happens on this thread; the UI only reads the cached snapshot.

use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use crate::claude::{self, PathDiagnostics};
use crate::git::{self, CommitEntry};
use crate::util::lock;
use crate::{tray, AppState};

/// Set by the UI ("sync now") or after settings change; wakes the worker early.
pub static FORCE_REFRESH: AtomicBool = AtomicBool::new(false);

const TICK: Duration = Duration::from_secs(30);
/// Re-walk the projects folder every 20 ticks (10 min) to pick up new repositories.
const REPO_RESCAN_TICKS: u64 = 20;
/// `claude -p /usage` is slow; every 6 ticks (3 min) is enough.
const USAGE_TICKS: u64 = 6;

/// Field names are the wire format the UI and the servers already use.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Snapshot {
    pub project: String,
    pub branch: String,
    #[serde(rename = "task_it")]
    pub task: String,
    pub status: String,
    pub ctx_pct: u32,
    pub commits_day: usize,
    pub commits_week: usize,
    pub new_commits: Vec<CommitEntry>,
    pub path_diagnostics: PathDiagnostics,
    pub app_version: String,
    pub usage_s: i32,
    pub usage_w: i32,
    pub usage_reset_s: String,
    pub usage_reset_w: String,
    pub usage_ts: u64,
}

impl Snapshot {
    fn placeholder() -> Self {
        Self {
            status: "IDLE".to_string(),
            project: "workspace".to_string(),
            branch: "main".to_string(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            usage_s: -1,
            usage_w: -1,
            ..Default::default()
        }
    }
}

fn compute(state: &AppState, rescan_repos: bool) -> Snapshot {
    let cfg = lock(&state.settings).clone();
    let session = claude::session_state(&cfg);

    let root = cfg
        .projects_root
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty());
    let repos = match root {
        Some(root) => {
            let mut cached = lock(&state.root_repos);
            if rescan_repos || cached.is_empty() {
                *cached = git::find_repos(Path::new(root));
            }
            cached.clone()
        }
        None => Vec::new(),
    };

    let manual_topic = lock(&state.manual_topic).clone();
    let (project, task) = claude::focus(&cfg, session.cwd.as_deref(), manual_topic.as_deref());
    let email = git::global_email(&state.git_email);
    let scan = git::scan(&repos, &email, &state.last_seen_heads);

    let mut snap = Snapshot {
        project,
        branch: scan.branch,
        task,
        status: session.status.to_string(),
        ctx_pct: session.ctx_pct,
        commits_day: scan.commits_day,
        commits_week: scan.commits_week,
        new_commits: scan.new_commits,
        path_diagnostics: claude::diagnostics(&cfg),
        ..Snapshot::placeholder()
    };
    apply_usage(&mut snap, &lock(&state.usage));
    snap
}

fn apply_usage(snap: &mut Snapshot, usage: &claude::UsageInfo) {
    snap.usage_s = usage.session_pct;
    snap.usage_w = usage.week_pct;
    snap.usage_reset_s.clone_from(&usage.session_reset);
    snap.usage_reset_w.clone_from(&usage.week_reset);
    snap.usage_ts = usage.fetched_at;
}

pub fn run_worker(app: AppHandle) {
    let mut tick: u64 = 0;
    loop {
        let state = app.state::<AppState>();
        let forced = FORCE_REFRESH.swap(false, Ordering::SeqCst);

        // git/log snapshot first (fast), then the slower `claude -p /usage` call
        let mut snap = compute(&state, tick.is_multiple_of(REPO_RESCAN_TICKS) || forced);
        lock(&state.pending_commits).append(&mut snap.new_commits);
        *lock(&state.snapshot) = Some(snap);

        if tick.is_multiple_of(USAGE_TICKS) || forced {
            let cfg = lock(&state.settings).clone();
            if let Some(fresh) = claude::fetch_usage(&cfg) {
                *lock(&state.usage) = fresh.clone();
                tray::refresh(&app, &fresh);
            }
        }

        tick += 1;
        for _ in 0..TICK.as_secs() {
            if FORCE_REFRESH.load(Ordering::SeqCst) {
                break;
            }
            thread::sleep(Duration::from_secs(1));
        }
    }
}

/// Latest snapshot plus the commits seen since the previous call (drained, so each is reported once).
#[tauri::command]
pub fn collect_local_telemetry(state: State<'_, AppState>) -> Snapshot {
    let mut snap = lock(&state.snapshot)
        .clone()
        .unwrap_or_else(Snapshot::placeholder);
    snap.new_commits = std::mem::take(&mut *lock(&state.pending_commits));
    apply_usage(&mut snap, &lock(&state.usage));
    snap
}

#[tauri::command]
pub fn force_refresh() {
    FORCE_REFRESH.store(true, Ordering::SeqCst);
}
