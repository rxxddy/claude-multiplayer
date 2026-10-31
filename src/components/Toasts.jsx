import { useEffect, useState } from 'react';
import { useT } from '../i18n';

// In-app notifications (replace native alert/confirm). Usage: notify('text', 'error' | 'ok' | 'info' | 'event')
const listeners = new Set();
let seq = 0;

export function notify(text, kind = 'info', ttl = 4500) {
  const toast = { id: ++seq, text: String(text), kind, ttl };
  listeners.forEach((fn) => fn(toast));
}

// Toast with custom buttons, e.g. accept/decline an invite. actions: [{label, onClick, primary}]
export function notifyAction(text, actions, ttl = 20000) {
  const toast = { id: ++seq, text: String(text), kind: 'action', ttl, actions };
  listeners.forEach((fn) => fn(toast));
}

// Promise-based confirm rendered by <Toasts/>; resolves true/false
export function confirmBox(text) {
  return new Promise((resolve) => {
    const toast = { id: ++seq, text: String(text), kind: 'confirm', ttl: 0, resolve };
    listeners.forEach((fn) => fn(toast));
  });
}

const ICON = { error: '[ERR]', ok: '[ OK]', info: '[i]', event: '[>>]', confirm: '[??]', action: '[!!]' };

export default function Toasts() {
  const tr = useT();
  const [items, setItems] = useState([]);

  useEffect(() => {
    const add = (t) => {
      setItems((prev) => [...prev.slice(-4), t]);
      if (t.ttl > 0) setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), t.ttl);
    };
    listeners.add(add);
    return () => listeners.delete(add);
  }, []);

  const close = (t, answer) => {
    t.resolve?.(answer);
    setItems((prev) => prev.filter((x) => x.id !== t.id));
  };

  return (
    <div className="toast-stack">
      {items.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`} onClick={() => !['confirm', 'action'].includes(t.kind) && close(t)}>
          <span className="toast__icon">{ICON[t.kind] || ICON.info}</span>
          <span className="toast__text">{t.text}</span>
          {t.kind === 'action' && (
            <span className="toast__actions">
              {t.actions.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  className={`deck-btn ${a.primary ? 'deck-btn--primary' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    close(t);
                    a.onClick();
                  }}
                >
                  {a.label}
                </button>
              ))}
            </span>
          )}
          {t.kind === 'confirm' && (
            <span className="toast__actions">
              <button type="button" className="deck-btn deck-btn--primary" onClick={() => close(t, true)}>
                {tr('toast.yes')}
              </button>
              <button type="button" className="deck-btn" onClick={() => close(t, false)}>
                {tr('toast.no')}
              </button>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
