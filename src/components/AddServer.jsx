import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { createApi, normalizeServerUrl } from '../lib/api';
import { derivePassword } from '../lib/password';
import { useT, LANGUAGES, getLanguage, setLanguage } from '../i18n';
import Spark from './Spark';

function PasswordInput({ value, onChange, placeholder, autoFocus, autoComplete }) {
  const t = useT();
  const [show, setShow] = useState(false);
  return (
    <div className="pw-field">
      <input
        className="deck-input"
        type={show ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="pw-field__eye"
        onClick={() => setShow((v) => !v)}
        title={show ? t('connect.hide') : t('connect.show')}
        aria-label={show ? t('connect.hide') : t('connect.show')}
      >
        {show ? (
          <svg viewBox="0 0 24 24">
            <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10.8 10.8 0 0 1 12 5c6 0 10 7 10 7a17.6 17.6 0 0 1-3.2 3.9M6.1 6.1C3.6 7.8 2 12 2 12s4 7 10 7a9.7 9.7 0 0 0 4.2-.9" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24">
            <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

function LanguagePicker() {
  const t = useT();
  return (
    <div className="lang-picker" role="group" aria-label={t('app.language')}>
      {LANGUAGES.map((l) => (
        <button key={l.code} type="button" className={getLanguage() === l.code ? 'is-on' : ''} onClick={() => setLanguage(l.code)}>
          {l.name}
        </button>
      ))}
    </div>
  );
}

function Steps({ step, withFolder }) {
  const t = useT();
  const cls = (n) => (step === n ? 'is-on' : step > n ? 'is-done' : '');
  return (
    <div className="connect__steps">
      <span className={cls(1)}>{t('connect.stepServer')}</span>
      <span className={cls(2)}>{t('connect.stepAccount')}</span>
      {withFolder && <span className={cls(3)}>{t('connect.stepFolder')}</span>}
    </div>
  );
}

/**
 * Two-step connect: (1) server address + join key → server_info, (2) sign in or register.
 * Step 3 (projects folder) is <ProjectsFolderStep>, shown by App while no folder is set.
 * `existing` re-authenticates a saved server (step 2 only).
 */
export default function AddServer({ existing, onDone, onCancel, needsFolder }) {
  const t = useT();
  const [step, setStep] = useState(existing ? 2 : 1);
  const [url, setUrl] = useState(existing?.url || '');
  const [joinKey, setJoinKey] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [info, setInfo] = useState(existing ? { name: existing.name } : null);
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState(existing?.username || '');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stage, setStage] = useState('');
  const [savedPw, setSavedPw] = useState('');

  useEffect(() => {
    if (!existing?.id) return;
    invoke('get_login_password', { id: existing.id })
      .then((p) => setSavedPw(p || ''))
      .catch(() => {});
  }, [existing]);

  useEffect(() => {
    if (!existing) return;
    createApi(existing.url)('server_info', {}, { timeout: 8000 })
      .then((d) => setInfo({ ...d, url: existing.url }))
      .catch(() => {});
  }, [existing]);

  const probe = async (e) => {
    e.preventDefault();
    setError('');
    const endpoint = normalizeServerUrl(url);
    if (!endpoint) return setError(t('connect.enterAddress'));
    setBusy(true);
    try {
      const data = await createApi(endpoint)('server_info', {}, { timeout: 8000 });
      setInfo({ ...data, url: endpoint });
      setUrl(endpoint);
      setStep(2);
    } catch (err) {
      setError(t('connect.checkAddress', { error: err.message }));
    } finally {
      setBusy(false);
    }
  };

  const auth = async (e) => {
    e.preventDefault();
    setError('');
    if (mode === 'register' && password !== password2) return setError(t('connect.mismatch'));
    if (password.length < 8 && mode === 'register') return setError(t('connect.tooShort'));
    if (busy) return;
    setBusy(true);
    try {
      const endpoint = existing?.url || info?.url || normalizeServerUrl(url);
      const call = createApi(endpoint);
      setStage(t('connect.stageSecuring'));
      const secret = await derivePassword(endpoint, username, password);
      setStage(mode === 'login' ? t('connect.stageSigningIn') : t('connect.stageCreating'));
      const res =
        mode === 'register'
          ? await call('register', {
              username,
              password: secret,
              password_confirm: secret,
              join_key: joinKey || undefined,
              setup_token: setupToken.trim() || undefined,
            })
          : await call('login', { username, password: secret });
      setStage(t('connect.stageOpening'));
      const entry = await invoke('upsert_server', {
        entry: { id: existing?.id || '', url: endpoint, name: info?.name || new URL(endpoint).host, username: res.user?.username || username },
      });
      await invoke('set_server_token', { id: entry.id, token: res.auth_token });
      // keep the password locally (Windows Credential Manager): servers have no password reset
      await invoke('save_login_password', { id: entry.id, password }).catch(() => {});
      await invoke('set_active_server', { id: entry.id });
      onDone({ ...entry, has_token: true, auth_token: res.auth_token });
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
      setStage('');
    }
  };

  return (
    <div className="connect">
      <div className="connect__card">
        <div className="connect__head">
          <Spark className="connect__mark" weight={0.9} />
          <div>
            <h2>{step === 1 ? t('connect.title') : info?.name || t('connect.signIn')}</h2>
            <p>{step === 1 ? t('connect.subtitle') : existing?.url || info?.url}</p>
          </div>
        </div>

        {!existing && step === 1 && <LanguagePicker />}
        <Steps step={step} withFolder={needsFolder} />

        {error && <div className="connect__error">{error}</div>}

        {step === 1 ? (
          <form onSubmit={probe} className="connect__form">
            <label>{t('connect.serverAddress')}</label>
            <input className="deck-input" value={url} autoFocus placeholder="https://deck.example.com/api.php" onChange={(e) => setUrl(e.target.value)} />
            <div className="connect__actions">
              {onCancel && (
                <button type="button" className="deck-btn" onClick={onCancel}>
                  {t('connect.cancel')}
                </button>
              )}
              <button type="submit" className="deck-btn deck-btn--primary" disabled={busy}>
                {busy ? t('connect.connecting') : t('connect.continue')}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={auth} className="connect__form">
            {info?.motd && (
              <div className="motd">
                <span className="motd__tag">{t('connect.pinned')}</span>
                {info.motd}
              </div>
            )}
            <div className="connect__tabs">
              <button type="button" className={mode === 'login' ? 'is-on' : ''} onClick={() => setMode('login')}>
                {t('connect.tabSignIn')}
              </button>
              <button
                type="button"
                className={mode === 'register' ? 'is-on' : ''}
                onClick={() => setMode('register')}
                disabled={info?.registration_open === false}
              >
                {t('connect.tabRegister')}
              </button>
            </div>
            <label>{t('connect.username')}</label>
            <input className="deck-input" value={username} autoFocus autoComplete="username" onChange={(e) => setUsername(e.target.value)} />
            <label>{t('connect.password')}</label>
            <PasswordInput value={password} onChange={setPassword} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
            {mode === 'login' && savedPw && password !== savedPw && (
              <button type="button" className="footer-link" style={{ alignSelf: 'flex-start' }} onClick={() => setPassword(savedPw)}>
                {t('connect.useSaved')}
              </button>
            )}
            {mode === 'register' && (
              <>
                <label>{t('connect.repeatPassword')}</label>
                <PasswordInput value={password2} onChange={setPassword2} autoComplete="new-password" />
                {info?.requires_setup_token && (
                  <>
                    <label>
                      {t('connect.setupToken')} <span className="arcade-dim">{t('connect.setupTokenHint')}</span>
                    </label>
                    <PasswordInput value={setupToken} onChange={setSetupToken} />
                  </>
                )}
                {info?.requires_join_key && (
                  <>
                    <label>
                      {t('connect.joinKey')} <span className="arcade-dim">{t('connect.joinKeyHint')}</span>
                    </label>
                    <PasswordInput value={joinKey} onChange={setJoinKey} placeholder={t('connect.joinKeyPlaceholder')} />
                  </>
                )}
              </>
            )}
            <div className="connect__actions">
              {!existing && (
                <button type="button" className="deck-btn" onClick={() => setStep(1)}>
                  {t('connect.back')}
                </button>
              )}
              {existing && onCancel && (
                <button type="button" className="deck-btn" onClick={onCancel}>
                  {t('connect.cancel')}
                </button>
              )}
              <button type="submit" className="deck-btn deck-btn--primary" disabled={busy || !username || !password}>
                {busy ? (
                  <span className="btn-progress">{stage || t('connect.working')}</span>
                ) : mode === 'login' ? (
                  t('connect.btnSignIn')
                ) : (
                  t('connect.btnCreate')
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/** Mandatory onboarding step: the folder whose git repos are counted. Cannot be skipped. */
export function ProjectsFolderStep({ onDone }) {
  const t = useT();
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const value = path.trim().replace(/^"|"$/g, '');
    if (!value) return setError(t('folder.required'));
    setBusy(true);
    try {
      const repos = await invoke('set_projects_root', { path: value });
      if (!repos.length) {
        await invoke('set_projects_root', { path: null });
        setError(t('folder.none'));
        return;
      }
      onDone(value);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connect">
      <div className="connect__card">
        <div className="connect__head">
          <Spark className="connect__mark" weight={0.9} />
          <div>
            <h2>{t('folder.title')}</h2>
            <p>{t('folder.subtitle')}</p>
          </div>
        </div>
        <Steps step={3} withFolder />
        {error && <div className="connect__error">{error}</div>}
        <form onSubmit={submit} className="connect__form">
          <label>{t('folder.label')}</label>
          <input className="deck-input" value={path} autoFocus placeholder={t('folder.placeholder')} onChange={(e) => setPath(e.target.value)} />
          <div className="motd folder-notice">
            <span className="motd__tag">{t('folder.privacyTitle')}</span>
            {t('folder.privacy')}
          </div>
          <div className="connect__actions">
            <button type="submit" className="deck-btn deck-btn--primary" disabled={busy || !path.trim()}>
              {busy ? t('folder.scanning') : t('folder.scan')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
