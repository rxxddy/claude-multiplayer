import { invoke } from '@tauri-apps/api/core';
import { useSyncExternalStore } from 'react';
import { createApi } from './api';

/**
 * One background sync loop per configured server. The active tab syncs every 2s, background tabs every 10s.
 * Local telemetry is collected once and fanned out; each server only receives the blocks its privacy
 * switches allow (disabled blocks are never sent).
 */
const ACTIVE_MS = 2000;
const BACKGROUND_MS = 10000;
const MAX_IN_MEMORY = 400;

// ---------------- shared local telemetry ----------------
const telemetry = { snap: null, at: 0, inflight: null, queues: new Map() };

export async function localSnapshot() {
  if (telemetry.snap && Date.now() - telemetry.at < 1500) return telemetry.snap;
  if (!telemetry.inflight) {
    telemetry.inflight = invoke('collect_local_telemetry')
      .then((snap) => {
        telemetry.snap = snap;
        telemetry.at = Date.now();
        // commits are drained by Rust on read: hand a copy to every server queue
        for (const q of telemetry.queues.values()) q.push(...(snap.new_commits || []));
        return snap;
      })
      .finally(() => {
        telemetry.inflight = null;
      });
  }
  return telemetry.inflight;
}

export function buildTelemetry(snap, privacy, sleeping) {
  const t = { is_sleeping: Boolean(sleeping || snap.is_sleeping) };
  if (privacy.focus) t.status = snap.status;
  if (privacy.usage) {
    if (snap.usage_ts > 0)
      t.usage = {
        s: snap.usage_s,
        w: snap.usage_w,
        reset_s: snap.usage_reset_s || snap.usage_reset || '',
        reset_w: snap.usage_reset_w || '',
        ts: snap.usage_ts,
      };
    t.ctx_pct = snap.ctx_pct;
  }
  if (privacy.commits) t.commits = { day: snap.commits_day, week: snap.commits_week };
  if (privacy.focus) t.focus = { project: snap.project, branch: snap.branch, task: snap.task_it };
  return t;
}

// ---------------- per-server session ----------------
class Session {
  constructor(entry, manager) {
    this.entry = entry;
    this.manager = manager;
    this.token = null;
    this.tokenGen = 0; // bumped on every sign-in/out: stale in-flight 401s must not wipe a fresh token
    this.timer = null;
    this.inFlight = false;
    this.kickPending = false;
    this.stopped = false;
    telemetry.queues.set(entry.id, []);
    this.call = createApi(entry.url, async () => {
      if (this.token === null) this.token = (await invoke('get_server_token', { id: entry.id })) || '';
      return this.token;
    });
    this.readingHistory = false; // set by the chat view while the user is scrolled up
    this.pendingCommits = null;
    this.state = {
      status: 'connecting',
      error: '',
      me: null,
      server: null,
      messages: [],
      lastMsgId: 0,
      hasOlder: true,
      duels: [],
      chess: [],
      battleship: [],
      commitFeed: [],
      membersRev: 0,
      onlineCount: 0,
      limits: null,
      unread: 0,
    };
  }

  set(patch) {
    let changed = false;
    const next = { ...this.state };
    for (const [k, v] of Object.entries(patch)) {
      const cur = this.state[k];
      if (cur === v) continue;
      if (v && typeof v === 'object' && k !== 'messages' && JSON.stringify(cur) === JSON.stringify(v)) continue;
      next[k] = v;
      changed = true;
    }
    if (!changed) return;
    this.state = next;
    this.manager.emit(this.entry.id);
  }

  async start() {
    try {
      const cached = await invoke('load_local_chat_history', { roomId: this.entry.id });
      const msgs = (cached?.messages || []).slice(-MAX_IN_MEMORY);
      this.set({ messages: msgs, lastMsgId: Number(cached?.last_msg_id || 0) });
    } catch {
      /* cache is optional */
    }
    this.loop();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    telemetry.queues.delete(this.entry.id);
  }

  kick() {
    if (this.inFlight) {
      this.kickPending = true;
      return;
    }
    clearTimeout(this.timer);
    this.loop();
  }

  async loop() {
    if (this.stopped) return;
    if (this.state.status === 'auth') return; // signed out: no polling until setToken()
    this.inFlight = true;
    try {
      await this.tick();
    } finally {
      this.inFlight = false;
      if (!this.stopped) {
        const active = this.manager.activeId === this.entry.id;
        const delay = this.kickPending ? 0 : active ? ACTIVE_MS : BACKGROUND_MS;
        this.kickPending = false;
        this.timer = setTimeout(() => this.loop(), delay);
      }
    }
  }

  async tick() {
    const gen = this.tokenGen;
    try {
      const snap = await localSnapshot();
      const privacy = this.entry.privacy || {};
      const queue = telemetry.queues.get(this.entry.id) || [];
      const taken = privacy.commit_feed ? queue.splice(0, 20) : ((queue.length = 0), []);
      const commits = privacy.focus ? taken : taken.map((c) => ({ ...c, project: '', branch: '' }));
      this.pendingCommits = taken;
      const r = await this.call('sync', {
        last_msg_id: this.state.lastMsgId,
        telemetry: buildTelemetry(snap, privacy, false),
        ...(commits.length ? { new_commits: commits } : {}),
      });
      const incoming = Array.isArray(r.new_messages) ? r.new_messages : [];
      let messages = this.state.messages;
      let lastMsgId = this.state.lastMsgId;
      if (incoming.length) {
        const real = messages.filter((m) => !m.pending || !incoming.some((x) => Number(x.user_id) === Number(m.user_id) && x.content === m.content));
        const seen = new Set(real.map((m) => Number(m.id)));
        messages = [...real, ...incoming.filter((m) => !seen.has(Number(m.id)))];
        if (!this.readingHistory && messages.length > MAX_IN_MEMORY) messages = messages.slice(-MAX_IN_MEMORY);
        lastMsgId = Math.max(lastMsgId, ...incoming.map((m) => Number(m.id)));
        invoke('append_local_chat_history', { roomId: this.entry.id, newMessages: incoming }).catch(() => {});
        this.manager.onMessages(this, incoming, r.me ? { ...r.me, user_id: r.me.user_id ?? r.me.id } : null);
      }
      this.set({
        status: 'ok',
        error: '',
        me: r.me ? { ...r.me, user_id: r.me.user_id ?? r.me.id } : this.state.me,
        server: r.server || this.state.server,
        messages,
        lastMsgId,
        duels: r.duels || [],
        chess: r.chess || [],
        battleship: r.battleship || [],
        commitFeed: r.commit_feed || this.state.commitFeed,
        membersRev: r.members_rev ?? this.state.membersRev,
        onlineCount: r.online_count ?? this.state.onlineCount,
        limits: r.game_limits || this.state.limits,
        unread: this.manager.activeId === this.entry.id ? 0 : this.state.unread + incoming.filter((m) => Number(m.user_id) > 0).length,
      });
      this.pendingCommits = null;
    } catch (err) {
      if (this.pendingCommits?.length) (telemetry.queues.get(this.entry.id) || []).unshift(...this.pendingCommits);
      this.pendingCommits = null;
      if (gen !== this.tokenGen) return; // answer to a request made with an old token
      if (err.status === 401 || err.code === 'UNAUTHORIZED') {
        this.tokenGen += 1;
        this.token = '';
        await invoke('set_server_token', { id: this.entry.id, token: null }).catch(() => {});
        this.set({ status: 'auth', error: 'Session expired — sign in again.' });
      } else if (err.code === 'BANNED' || err.code === 'ROOM_ACCESS_DENIED') {
        this.set({ status: 'banned', error: err.message });
      } else {
        this.set({ status: this.state.me ? 'degraded' : 'error', error: err.message });
      }
    }
  }

  /** Load older messages before the oldest one in memory. Returns number of messages added. */
  async loadOlder() {
    const oldest = this.state.messages.find((m) => !m.pending);
    if (!oldest || !this.state.hasOlder) return 0;
    const r = await this.call('history', { before_id: Number(oldest.id), limit: 60 });
    const older = r.messages || [];
    const seen = new Set(this.state.messages.map((m) => Number(m.id)));
    const fresh = older.filter((m) => !seen.has(Number(m.id)));
    // older pages may exceed the in-memory cap: keep them, the cap only applies to the live tail
    this.set({ messages: [...fresh, ...this.state.messages], hasOlder: older.length > 0 && this.state.hasOlder });
    return fresh.length;
  }

  addPending(msg) {
    this.set({ messages: [...this.state.messages, msg] });
  }

  dropPending(id) {
    this.set({ messages: this.state.messages.filter((m) => m.id !== id) });
  }

  async setToken(token) {
    this.tokenGen += 1;
    this.token = token || '';
    await invoke('set_server_token', { id: this.entry.id, token: token || null });
    this.set({ status: token ? 'connecting' : 'auth', error: '' });
    if (token) {
      clearTimeout(this.timer);
      if (this.inFlight) this.kickPending = true;
      else this.loop();
    }
  }
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.listeners = new Map();
    this.activeId = null;
    this.messageListeners = new Set();
    this.allVersion = 0;
  }

  sync(entries, activeId) {
    const ids = new Set(entries.map((e) => e.id));
    for (const [id, s] of this.sessions) {
      if (!ids.has(id)) {
        s.stop();
        this.sessions.delete(id);
      }
    }
    for (const e of entries) {
      const s = this.sessions.get(e.id);
      if (s) {
        s.entry = e;
      } else if (e.has_token) {
        const ns = new Session(e, this);
        this.sessions.set(e.id, ns);
        ns.start();
      }
    }
    this.setActive(activeId);
  }

  ensure(entry) {
    if (!this.sessions.has(entry.id)) {
      const s = new Session(entry, this);
      this.sessions.set(entry.id, s);
      s.start();
    }
    return this.sessions.get(entry.id);
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  setActive(id) {
    this.activeId = id;
    const s = this.sessions.get(id);
    if (s) {
      s.set({ unread: 0 });
      s.kick();
    }
  }

  emit(id) {
    this.allVersion = (this.allVersion || 0) + 1;
    (this.listeners.get(id) || new Set()).forEach((fn) => fn());
    (this.listeners.get('*') || new Set()).forEach((fn) => fn());
  }

  subscribe(id, fn) {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id).add(fn);
    return () => this.listeners.get(id)?.delete(fn);
  }

  onMessages(session, incoming, me) {
    this.messageListeners.forEach((fn) => fn(session, incoming, me));
  }
}

export const sessions = new SessionManager();

const EMPTY = { status: 'none', messages: [], duels: [], chess: [], battleship: [], commitFeed: [] };

export function useSession(id) {
  return useSyncExternalStore(
    (fn) => sessions.subscribe(id, fn),
    () => sessions.get(id)?.state || EMPTY
  );
}

export function useAllSessions() {
  return useSyncExternalStore(
    (fn) => sessions.subscribe('*', fn),
    () => [...sessions.sessions.values()].map((s) => `${s.entry.id}:${s.state.status}:${s.state.unread}`).join('|')
  );
}
