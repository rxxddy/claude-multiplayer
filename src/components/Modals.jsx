import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { OperatorSvgIcon, AVATAR_PRESETS, COLOR_PALETTE } from './Avatar';
import { notify } from './Toasts';
import { useT, LANGUAGES, getLanguage, setLanguage } from '../i18n';
import { NumberInput } from './Controls';

function Modal({ title, onClose, children, wide }) {
  const t = useT();
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal-card ${wide ? 'modal-card--wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="deck-btn" onClick={onClose} aria-label={t('modal.close')}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}

function Toggle({ value, onChange, label, hint }) {
  return (
    <label className="ra__toggle" onClick={() => onChange(!value)}>
      <span className={`switch ${value ? 'switch--on' : ''}`}>
        <span className="switch__track" />
      </span>
      <span>
        {label}
        {hint && (
          <div className="arcade-dim" style={{ fontSize: 10.5 }}>
            {hint}
          </div>
        )}
      </span>
    </label>
  );
}

export function ProfileModal({ me, session, taskIt, onClose }) {
  const t = useT();
  const [nick, setNick] = useState(me?.display_nick || '');
  const [color, setColor] = useState(me?.avatar_color || '#D97757');
  const [preset, setPreset] = useState(me?.avatar_preset || 'CLAUDE_CRAB');
  const [bio, setBio] = useState(me?.bio || '');
  const [hideUsage, setHideUsage] = useState(Boolean(me?.usage_hidden));
  const [task, setTask] = useState(taskIt || '');
  const [busy, setBusy] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await session.call('update_profile', { display_nick: nick.trim(), avatar_color: color, avatar_preset: preset, bio: bio.trim(), usage_hidden: hideUsage });
      if (task.trim() && task.trim() !== taskIt) await invoke('set_manual_task_it', { taskIt: task.trim() });
      session.kick();
      notify(t('profile.saved'), 'ok');
      onClose();
    } catch (err) {
      notify(String(err?.message || err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('profile.title')} onClose={onClose}>
      <form className="form-stack" onSubmit={save}>
        <div className="avatar-picker">
          {AVATAR_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              className={`avatar-picker__item ${preset === p ? 'is-on' : ''}`}
              onClick={() => setPreset(p)}
              title={p.replace('CLAUDE_', '').toLowerCase()}
            >
              <OperatorSvgIcon color={color} preset={p} size={26} showStatusDot={false} />
            </button>
          ))}
        </div>
        <div className="swatches">
          {COLOR_PALETTE.map((c) => (
            <button
              key={c.hex}
              type="button"
              title={t(`avatar.color.${c.id}`)}
              className={`swatch ${color === c.hex ? 'is-on' : ''}`}
              style={{ background: c.hex }}
              onClick={() => setColor(c.hex)}
            />
          ))}
        </div>
        <label>{t('profile.nick')}</label>
        <input className="deck-input" value={nick} maxLength={18} onChange={(e) => setNick(e.target.value)} />
        <label>{t('profile.bio')}</label>
        <input className="deck-input" value={bio} maxLength={160} onChange={(e) => setBio(e.target.value)} />
        <label>{t('profile.task')}</label>
        <input className="deck-input" value={task} maxLength={90} onChange={(e) => setTask(e.target.value)} />
        <Toggle value={hideUsage} onChange={setHideUsage} label={t('profile.hideUsage')} hint={t('profile.hideUsageHint')} />
        <div className="modal-actions">
          <button type="button" className="deck-btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="deck-btn deck-btn--primary" disabled={busy}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function PrivacyModal({ entry, onSaved, onClose }) {
  const t = useT();
  const [p, setP] = useState({ usage: true, commits: true, focus: true, commit_feed: true, ...(entry?.privacy || {}) });
  const save = async () => {
    try {
      const updated = await invoke('set_server_privacy', { id: entry.id, privacy: p });
      onSaved(updated);
      notify(t('privacy.applied'), 'ok');
      onClose();
    } catch (err) {
      notify(String(err), 'error');
    }
  };
  return (
    <Modal title={t('privacy.title', { name: entry?.name || t('privacy.thisServer') })} onClose={onClose}>
      <div className="form-stack">
        <p className="arcade-dim">{t('privacy.intro')}</p>
        <Toggle value={p.usage} onChange={(v) => setP({ ...p, usage: v })} label={t('privacy.usage')} hint={t('privacy.usageHint')} />
        <Toggle value={p.commits} onChange={(v) => setP({ ...p, commits: v })} label={t('privacy.commits')} hint={t('privacy.commitsHint')} />
        <Toggle value={p.commit_feed} onChange={(v) => setP({ ...p, commit_feed: v })} label={t('privacy.feed')} hint={t('privacy.feedHint')} />
        <Toggle value={p.focus} onChange={(v) => setP({ ...p, focus: v })} label={t('privacy.focus')} hint={t('privacy.focusHint')} />
        <div className="modal-actions">
          <button type="button" className="deck-btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="deck-btn deck-btn--primary" onClick={save}>
            {t('common.apply')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AutostartRow() {
  const t = useT();
  const [st, setSt] = useState(null);
  useEffect(() => {
    invoke('autostart_status')
      .then(setSt)
      .catch(() => {});
  }, []);
  const add = async () => {
    try {
      const ok = await invoke('set_autostart', { enabled: true });
      setSt((s) => ({ ...s, registered: ok }));
      notify(t('autostart.added'), 'ok');
    } catch (err) {
      notify(String(err), 'error');
    }
  };
  if (!st) return null;
  return (
    <div className="pc__row" style={{ alignItems: 'center' }}>
      <span style={{ flex: 1 }}>
        {t('autostart.label')}:{' '}
        {st.registered ? <b className="text-success">{t('autostart.enabled')}</b> : <b className="arcade-loss">{t('autostart.missing')}</b>}
        <div className="arcade-dim" style={{ fontSize: 10.5 }}>
          {t('autostart.hint')}
        </div>
      </span>
      {!st.registered && (
        <button type="button" className="deck-btn deck-btn--primary" disabled={st.dev_build} title={st.dev_build ? t('autostart.dev') : ''} onClick={add}>
          {t('autostart.add')}
        </button>
      )}
    </div>
  );
}

export function PathsModal({ diag, projectsRoot, onClose, onDiag, onProjectsRoot }) {
  const t = useT();
  const [root, setRoot] = useState(projectsRoot || '');
  const [rootRepos, setRootRepos] = useState(null);
  const [claudeDir, setClaudeDir] = useState(diag?.claude_dir_path || '');
  const [focusFile, setFocusFile] = useState(diag?.focus_file_path || '');
  const [claudeMd, setClaudeMd] = useState(diag?.claude_md_path || '');
  const [claudeCli, setClaudeCli] = useState(diag?.claude_cli_path || '');

  // show what is being counted right now
  useEffect(() => {
    if (projectsRoot)
      invoke('set_projects_root', { path: projectsRoot })
        .then(setRootRepos)
        .catch(() => {});
  }, [projectsRoot]);

  const applyRoot = async () => {
    const value = root.trim().replace(/^"|"$/g, '');
    if (!value) return notify(t('folder.required'), 'error');
    try {
      const list = await invoke('set_projects_root', { path: value });
      if (!list.length) {
        // keep the previous folder: an empty folder would silently zero the counters
        if (projectsRoot) await invoke('set_projects_root', { path: projectsRoot });
        return notify(t('folder.none'), 'error');
      }
      setRootRepos(list);
      onProjectsRoot(value);
      notify(t('paths.rootScanning', { path: value, n: list.length }), 'ok');
    } catch (err) {
      notify(String(err), 'error');
    }
  };
  const save = async () => {
    try {
      onDiag(await invoke('set_custom_paths', { claudeDir: claudeDir || null, focusFile: focusFile || null, claudeMd: claudeMd || null, claudeCli }));
      notify(t('paths.saved'), 'ok');
    } catch (err) {
      notify(String(err), 'error');
    }
  };
  return (
    <Modal title={t('paths.title')} onClose={onClose} wide>
      <div className="form-stack">
        <label>{t('app.language')}</label>
        <div className="lang-picker">
          {LANGUAGES.map((l) => (
            <button key={l.code} type="button" className={getLanguage() === l.code ? 'is-on' : ''} onClick={() => setLanguage(l.code)}>
              {l.name}
            </button>
          ))}
        </div>
        <AutostartRow />
        <label>{t('paths.rootLabel')}</label>
        <div className="pc__row">
          <input className="deck-input" placeholder={t('folder.placeholder')} value={root} onChange={(e) => setRoot(e.target.value)} style={{ flex: 1 }} />
          <button type="button" className="deck-btn deck-btn--primary" disabled={!root.trim()} onClick={applyRoot}>
            {t('paths.rootApply')}
          </button>
        </div>
        <div className="arcade-dim" style={{ fontSize: 10.5 }}>
          {t('folder.privacy')}
        </div>
        {rootRepos && (
          <>
            <label>{t('paths.repos', { n: rootRepos.length })}</label>
            <div className="repo-list">
              {rootRepos.length ? (
                rootRepos.map((r) => (
                  <div key={r} className="arcade-dim">
                    {r}
                  </div>
                ))
              ) : (
                <div className="arcade-loss">{t('paths.noRepos')}</div>
              )}
            </div>
          </>
        )}
        <label>
          {t('paths.claudeDir')} {diag?.claude_dir_exists === false && <span className="arcade-loss">{t('paths.notFound')}</span>}
        </label>
        <input className="deck-input" value={claudeDir} onChange={(e) => setClaudeDir(e.target.value)} />
        <label>
          {t('paths.focusFile')} {diag?.focus_file_exists === false && <span className="arcade-loss">{t('paths.notFound')}</span>}
        </label>
        <input className="deck-input" value={focusFile} onChange={(e) => setFocusFile(e.target.value)} />
        <label>
          {t('paths.claudeCli')} {diag?.claude_cli_found === false && <span className="arcade-loss">{t('paths.notFound')}</span>}
        </label>
        <input className="deck-input" value={claudeCli} placeholder="C:\\Users\\you\\.local\\bin\\claude.exe" onChange={(e) => setClaudeCli(e.target.value)} />
        <label>{t('paths.claudeMd')}</label>
        <input className="deck-input" value={claudeMd} onChange={(e) => setClaudeMd(e.target.value)} />
        <div className="modal-actions">
          <button type="button" className="deck-btn deck-btn--primary" onClick={save}>
            {t('paths.save')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function ServerAdminModal({ state, session, onClose }) {
  const t = useT();
  const srv = state.server || {};
  const s = srv.settings || {};
  const [f, setF] = useState({
    name: srv.name || '',
    motd: srv.motd || '',
    registration_open: s.registration_open !== false,
    games_enabled: s.games_enabled !== false,
    chess_stakes: s.chess_stakes !== false,
    max_stake: s.max_stake ?? 100000,
    slow_mode: s.slow_mode ?? 0,
    spins_5h: s.spins_5h ?? 60,
    spins_week: s.spins_week ?? 400,
  });
  const [joinKey, setJoinKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [banned, setBanned] = useState([]);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const isOwner = srv.my_role === 'owner';

  useEffect(() => {
    session
      .call('admin_banned')
      .then((r) => setBanned(r.items || []))
      .catch(() => {});
  }, [session]);

  const save = async (e) => {
    e.preventDefault();
    try {
      await session.call('admin', {
        op: 'settings',
        ...f,
        max_stake: Number(f.max_stake),
        slow_mode: Number(f.slow_mode),
        spins_5h: Number(f.spins_5h),
        spins_week: Number(f.spins_week),
        ...(joinKey ? { join_key: joinKey } : {}),
        ...(anthropicKey ? { anthropic_key: anthropicKey } : {}),
      });
      session.kick();
      notify(t('admin.saved'), 'ok');
      onClose();
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  const num = (k, label, min, max) => (
    <>
      <label>{label}</label>
      <NumberInput min={min} max={max} value={f[k]} onChange={set(k)} />
    </>
  );

  return (
    <Modal title={t('admin.title', { role: srv.my_role })} onClose={onClose} wide>
      <form className="form-stack" onSubmit={save}>
        <div className="ra__grid">
          <label>{t('admin.name')}</label>
          <input className="deck-input" value={f.name} maxLength={40} onChange={(e) => set('name')(e.target.value)} />
          <label>{t('admin.pinned')}</label>
          <input className="deck-input" value={f.motd} maxLength={280} onChange={(e) => set('motd')(e.target.value)} />
          {num('max_stake', t('admin.maxStake'), 10, 1000000)}
          {num('slow_mode', t('admin.slowMode'), 0, 600)}
          {num('spins_5h', t('admin.spins5h'), 0, 10000)}
          {num('spins_week', t('admin.spinsWeek'), 0, 100000)}
          {isOwner && (
            <>
              <label>{t('admin.joinKey')}</label>
              <input className="deck-input" type="password" placeholder={t('admin.keepEmpty')} value={joinKey} onChange={(e) => setJoinKey(e.target.value)} />
            </>
          )}
          <label>{t('admin.anthropicKey')}</label>
          <input
            className="deck-input"
            type="password"
            placeholder={srv.anthropic_key_masked || t('admin.anthropicNotSet')}
            value={anthropicKey}
            onChange={(e) => setAnthropicKey(e.target.value)}
          />
        </div>
        <Toggle value={f.registration_open} onChange={set('registration_open')} label={t('admin.registrationOpen')} hint={t('admin.registrationHint')} />
        <Toggle value={f.games_enabled} onChange={set('games_enabled')} label={t('admin.games')} />
        <Toggle value={f.chess_stakes} onChange={set('chess_stakes')} label={t('admin.stakes')} />
        {banned.length > 0 && (
          <>
            <label>{t('admin.banned', { n: banned.length })}</label>
            {banned.map((b) => (
              <div key={b.user_id} className="arcade-duel">
                <span>{b.display_nick}</span>
                <button
                  type="button"
                  className="deck-btn"
                  onClick={async () => {
                    try {
                      await session.call('admin', { op: 'unban', target_user_id: b.user_id });
                      setBanned((x) => x.filter((y) => y.user_id !== b.user_id));
                    } catch (err) {
                      notify(err.message, 'error');
                    }
                  }}
                >
                  {t('admin.unban')}
                </button>
              </div>
            ))}
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="deck-btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="deck-btn deck-btn--primary">
            {t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ConsentModal({ onAnswer }) {
  const t = useT();
  return (
    <Modal title={t('consent.title')} onClose={() => onAnswer(false)}>
      <div className="form-stack">
        <p>{t('consent.body')}</p>
        <p className="arcade-dim">{t('consent.later')}</p>
        <div className="modal-actions">
          <button type="button" className="deck-btn" onClick={() => onAnswer(false)}>
            {t('consent.no')}
          </button>
          <button type="button" className="deck-btn deck-btn--primary" onClick={() => onAnswer(true)}>
            {t('consent.yes')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Asked at start-up when claude.exe cannot be found: without it the app cannot read Claude usage limits. */
export function ClaudeCliModal({ onSaved, onClose }) {
  const t = useT();
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const diag = await invoke('set_custom_paths', { claudeCli: path.trim() });
      onSaved(diag);
      notify(t('cli.saved'), 'ok');
      onClose();
    } catch (err) {
      notify(String(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('cli.title')} onClose={onClose}>
      <form className="form-stack" onSubmit={save}>
        <p>{t('cli.body')}</p>
        <p className="arcade-dim">{t('cli.hint')}</p>
        <input className="deck-input" autoFocus value={path} placeholder="C:\\Users\\you\\.local\\bin\\claude.exe" onChange={(e) => setPath(e.target.value)} />
        <div className="modal-actions">
          <button type="button" className="deck-btn" onClick={onClose}>
            {t('cli.later')}
          </button>
          <button type="submit" className="deck-btn deck-btn--primary" disabled={busy || !path.trim()}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
