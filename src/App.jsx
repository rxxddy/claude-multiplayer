import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { sessions, useAllSessions, localSnapshot } from './lib/sessions';
import AddServer, { ProjectsFolderStep } from './components/AddServer';
import { useT, initLanguage, t as translate } from './i18n';
import { LanguageDropdown } from './components/Controls';
import Spark from './components/Spark';
import ServerView from './components/ServerView';
import { ConsentModal, ClaudeCliModal } from './components/Modals';
import Toasts, { notify, confirmBox } from './components/Toasts';
import './styles/index.css';

const GITHUB_URL = 'https://github.com/rxxddy';
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
const appWindow = getCurrentWindow();

function ServerTabs({ servers, activeId, onSelect, onAdd, onRemove }) {
  useAllSessions();
  const t = useT();
  return (
    <div className="server-tabs" data-tauri-drag-region>
      {servers.map((s) => {
        const st = sessions.get(s.id)?.state;
        const status = !s.has_token ? 'auth' : st?.status || 'connecting';
        return (
          <div key={s.id} className={`server-tab ${s.id === activeId ? 'is-active' : ''}`} onClick={() => onSelect(s.id)} title={s.url}>
            <span className={`server-tab__dot server-tab__dot--${status}`} />
            <span className="server-tab__name">{s.name || s.url}</span>
            {st?.unread > 0 && s.id !== activeId && <span className="server-tab__badge">{st.unread > 99 ? '99+' : st.unread}</span>}
            <button
              type="button"
              className="server-tab__close"
              title={t('app.removeServer')}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(s);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button type="button" className="server-tab server-tab--add" onClick={onAdd} title={t('app.addServer')}>
        ＋
      </button>
    </div>
  );
}

function useUpdater() {
  const [update, setUpdate] = useState(null);
  const [state, setState] = useState('idle'); // idle | checking | installing | latest | error
  const run = useCallback(async (manual) => {
    setState('checking');
    try {
      const u = await check();
      setUpdate(u || null);
      setState(u ? 'idle' : 'latest');
      if (u && !manual) notify(translate('update.available', { version: u.version }), 'info', 8000);
    } catch {
      setState(manual ? 'error' : 'idle');
      if (manual) notify(translate('update.unreachable'), 'error');
    }
  }, []);
  useEffect(() => {
    run(false);
    const timer = setInterval(() => run(false), UPDATE_EVERY_MS);
    return () => clearInterval(timer);
  }, [run]);
  const install = async () => {
    if (!update) return;
    setState('installing');
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch (err) {
      setState('error');
      notify(translate('update.failed', { error: String(err) }), 'error');
    }
  };
  return { update, state, check: () => run(true), install };
}

export default function App() {
  const [boot, setBoot] = useState(null);
  const [servers, setServers] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState({});
  const [snap, setSnap] = useState(null);
  const [isMax, setIsMax] = useState(false);
  const updater = useUpdater();
  const t = useT();
  useAllSessions(); // re-render on session status changes (auth expiry etc.)

  const refreshServers = useCallback(async () => {
    const r = await invoke('list_servers');
    setServers(r.servers || []);
    setActiveId(r.active_server_id || r.servers?.[0]?.id || null);
    sessions.sync(r.servers || [], r.active_server_id);
    return r;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const b = await invoke('init_cyberdeck');
        initLanguage(b.settings?.language);
        setSettings(b.settings || {});
        setBoot(b);
        await refreshServers();
      } catch (err) {
        setBoot({ error: String(err) });
      }
    })();
  }, [refreshServers]);

  // local telemetry for the profile/paths UI (shared cache, does not steal queued commits)
  useEffect(() => {
    let last = '';
    const pull = () =>
      localSnapshot()
        .then((s) => {
          const key = JSON.stringify([s.task_it, s.path_diagnostics, s.app_version]);
          if (key !== last) {
            last = key;
            setSnap(s);
          }
        })
        .catch(() => {});
    pull();
    const timer = setInterval(pull, 5000);
    return () => clearInterval(timer);
  }, []);

  // in-app notifications from every connected server
  useEffect(() => {
    const fn = (session, incoming, me) => {
      const nick = me?.display_nick;
      const isActive = session.entry.id === sessions.activeId;
      for (const m of incoming) {
        if (Number(m.created_ts) < Date.now() / 1000 - 30 || Number(m.user_id) === Number(me?.user_id)) continue;
        const text = String(m.content || '');
        const aboutMe = nick && new RegExp(`\\b${nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
        const where = isActive ? '' : `[${session.entry.name}] `;
        if (aboutMe && m.user_id > 0) notify(`${where}${m.sender_nick}: ${text.slice(0, 140)}`, 'event');
        else if (aboutMe) notify(`${where}${text.slice(0, 160)}`, 'event', 8000);
        else if (m.msg_type === 'TROPHY_EVENT') notify(`${where}${text}`, 'event', 10000);
      }
    };
    sessions.messageListeners.add(fn);
    return () => sessions.messageListeners.delete(fn);
  }, []);

  useEffect(() => {
    const refresh = () =>
      appWindow
        .isMaximized()
        .then(setIsMax)
        .catch(() => {});
    refresh();
    let unlisten;
    appWindow.onResized(refresh).then((f) => (unlisten = f));
    const onKey = (e) => e.key === 'PrintScreen' && invoke('open_screen_snip').catch(() => {});
    window.addEventListener('keyup', onKey);
    return () => {
      unlisten?.();
      window.removeEventListener('keyup', onKey);
    };
  }, []);

  const select = async (id) => {
    setActiveId(id);
    setAdding(false);
    sessions.setActive(id);
    await invoke('set_active_server', { id }).catch(() => {});
  };

  const remove = async (s) => {
    if (!(await confirmBox(t('app.removeConfirm', { name: s.name || s.url })))) return;
    await invoke('remove_server', { id: s.id });
    await refreshServers();
  };

  const signOut = async (entry) => {
    if (!(await confirmBox(t('app.signOutConfirm', { name: entry.name })))) return;
    const session = sessions.get(entry.id);
    try {
      await session?.call('logout');
    } catch {
      // the token is dropped locally anyway
    }
    if (session) await session.setToken(null);
    else await invoke('set_server_token', { id: entry.id, token: null });
    await refreshServers();
  };

  const answerConsent = async (yes) => {
    try {
      await invoke('set_claude_md_consent', { consent: yes });
    } catch (err) {
      notify(String(err), 'error');
    }
    setBoot((b) => ({ ...b, needs_claude_md_consent: false }));
  };

  const active = servers.find((s) => s.id === activeId);
  const activeSession = active ? sessions.get(active.id) : null;
  const needsAuth = active && (!active.has_token || activeSession?.state.status === 'auth');

  return (
    <div className="app-shell">
      <header className="titlebar" data-tauri-drag-region>
        <div className="titlebar__brand" data-tauri-drag-region>
          <Spark className="titlebar__mark" />
          <span className="titlebar__name">
            <b>CLAUDE</b> MULTIPLAYER
          </span>
        </div>
        <ServerTabs servers={servers} activeId={adding ? null : activeId} onSelect={select} onAdd={() => setAdding(true)} onRemove={remove} />
        <div className="titlebar__actions">
          <button type="button" className="window-ctrl-btn" onClick={() => appWindow.minimize()} title={t('app.minimize')} aria-label={t('app.minimize')}>
            <svg viewBox="0 0 10 10">
              <path d="M1 5.5h8" />
            </svg>
          </button>
          <button
            type="button"
            className="window-ctrl-btn"
            onClick={() => appWindow.toggleMaximize()}
            title={isMax ? t('app.restore') : t('app.maximize')}
            aria-label={t('app.maximize')}
          >
            {isMax ? (
              <svg viewBox="0 0 10 10">
                <path d="M3 3h5.5v5.5H3z M1.5 6.5V1.5h5" />
              </svg>
            ) : (
              <svg viewBox="0 0 10 10">
                <rect x="1.5" y="1.5" width="7" height="7" rx="1" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="window-ctrl-btn window-ctrl-btn--close"
            onClick={() => appWindow.close()}
            title={t('app.hideToTray')}
            aria-label={t('app.hideToTray')}
          >
            <svg viewBox="0 0 10 10">
              <path d="M1.8 1.8l6.4 6.4M8.2 1.8L1.8 8.2" />
            </svg>
          </button>
        </div>
      </header>

      {boot?.error && (
        <div className="connect">
          <div className="connect__error">{t('app.startupFailed', { error: boot.error })}</div>
        </div>
      )}

      {boot &&
        !boot.error &&
        (adding || servers.length === 0 ? (
          <AddServer
            needsFolder={!settings.projects_root}
            onCancel={servers.length ? () => setAdding(false) : null}
            onDone={async (entry) => {
              setAdding(false);
              const s = sessions.ensure(entry);
              await s.setToken(entry.auth_token);
              await refreshServers();
              select(entry.id);
            }}
          />
        ) : !settings.projects_root ? (
          <ProjectsFolderStep onDone={(root) => setSettings((s) => ({ ...s, projects_root: root }))} />
        ) : needsAuth ? (
          <AddServer
            key={active.id}
            existing={active}
            onDone={async (entry) => {
              await sessions.ensure(entry).setToken(entry.auth_token);
              await refreshServers();
            }}
          />
        ) : active && activeSession ? (
          <ServerView
            key={active.id}
            session={activeSession}
            entry={active}
            localSnap={snap}
            settings={settings}
            onEntryUpdated={(e) => {
              setServers((list) => list.map((x) => (x.id === e.id ? { ...x, ...e } : x)));
              activeSession.entry = { ...activeSession.entry, ...e };
            }}
            onSignOut={() => signOut(active)}
            onToggleTray={async (enabled) => {
              try {
                await invoke('set_tray_enabled', { enabled });
                setSettings((s) => ({ ...s, tray_enabled: enabled }));
                notify(enabled ? t('tray.on') : t('tray.off'), 'ok');
              } catch (err) {
                notify(String(err), 'error');
              }
            }}
            onForceSync={async () => {
              await invoke('force_refresh');
              notify(t('sync.rescan'), 'info');
            }}
            onDiag={(d) => setSnap((s) => ({ ...s, path_diagnostics: d }))}
            onProjectsRoot={(root) => setSettings((s) => ({ ...s, projects_root: root }))}
          />
        ) : (
          <div className="connect">
            <div className="arcade-dim">{t('app.connecting')}</div>
          </div>
        ))}

      <footer className="status-footer tabular">
        <span>v{snap?.app_version || '1.0.0'}</span>
        {updater.update ? (
          <button type="button" className="footer-link footer-link--hot" onClick={updater.install} disabled={updater.state === 'installing'}>
            {updater.state === 'installing' ? t('update.installing') : t('update.to', { version: updater.update.version })}
          </button>
        ) : (
          <button type="button" className="footer-link" onClick={updater.check} disabled={updater.state === 'checking'}>
            {updater.state === 'checking' ? t('update.checking') : updater.state === 'latest' ? t('update.latest') : t('update.check')}
          </button>
        )}
        <span className="status-footer__spacer" />
        <LanguageDropdown up />
        <button type="button" className="footer-link" onClick={() => invoke('open_external', { url: GITHUB_URL }).catch(() => {})} title={GITHUB_URL}>
          <svg viewBox="0 0 16 16" className="footer-gh" aria-hidden="true">
            <path d="M8 0C3.6 0 0 3.6 0 8c0 3.5 2.3 6.5 5.5 7.6.4.1.5-.2.5-.4v-1.4c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.3 1.9.9 2.4.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8.6-.2 1.3-.3 2-.3s1.4.1 2 .3c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.7-3.6 3.9.3.3.5.8.5 1.5v2.2c0 .2.1.5.6.4C13.7 14.5 16 11.5 16 8c0-4.4-3.6-8-8-8z" />
          </svg>
          rxxddy
        </button>
      </footer>

      {boot?.needs_claude_md_consent && <ConsentModal onAnswer={answerConsent} />}
      {!boot?.needs_claude_md_consent && boot?.diagnostics?.claude_cli_found === false && (
        <ClaudeCliModal
          onSaved={(d) => setSnap((s) => ({ ...s, path_diagnostics: d }))}
          onClose={() => setBoot((b) => ({ ...b, diagnostics: { ...b.diagnostics, claude_cli_found: true } }))}
        />
      )}
      <Toasts />
    </div>
  );
}
