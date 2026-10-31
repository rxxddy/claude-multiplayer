import { useEffect, useRef, useState } from 'react';
import { useT, LANGUAGES, getLanguage, setLanguage } from '../i18n';

/** Terminal-styled dropdown (replaces the native <select>). Opens upward when `up` is set. */
export function Dropdown({ value, options, onChange, title, up, className = '' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  const current = options.find((o) => o.value === value) || options[0];
  return (
    <div ref={ref} className={`dd ${up ? 'dd--up' : ''} ${open ? 'is-open' : ''} ${className}`}>
      <button
        type="button"
        className="dd__btn"
        title={title}
        aria-label={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{current?.label}</span>
        <span className="dd__caret">{up ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="dd__menu" role="listbox">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`dd__item ${o.value === value ? 'is-on' : ''}`}
              onClick={() => {
                setOpen(false);
                if (o.value !== value) onChange(o.value);
              }}
            >
              <span className="dd__mark">{o.value === value ? '›' : ' '}</span>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function LanguageDropdown({ up }) {
  const t = useT();
  return (
    <Dropdown
      up={up}
      title={t('app.language')}
      value={getLanguage()}
      options={LANGUAGES.map((l) => ({ value: l.code, label: l.name }))}
      onChange={setLanguage}
    />
  );
}

/** Number field with custom −/+ steppers (native Windows spinners are hidden in CSS). */
export function NumberInput({ value, onChange, min = -Infinity, max = Infinity, step = 1, className = '', style, ...rest }) {
  const clamp = (n) => Math.min(max, Math.max(min, n));
  const bump = (dir) => {
    const cur = Number(value);
    onChange(clamp((Number.isFinite(cur) ? cur : 0) + dir * step));
  };
  return (
    <div className={`num-input ${className}`} style={style}>
      <button type="button" className="num-input__btn" tabIndex={-1} aria-label="−" disabled={Number(value) <= min} onClick={() => bump(-1)}>
        −
      </button>
      <input
        {...rest}
        className="deck-input num-input__field"
        type="number"
        inputMode="numeric"
        value={value}
        min={Number.isFinite(min) ? min : undefined}
        max={Number.isFinite(max) ? max : undefined}
        step={step}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        onBlur={(e) => e.target.value !== '' && onChange(clamp(Number(e.target.value)))}
      />
      <button type="button" className="num-input__btn" tabIndex={-1} aria-label="+" disabled={Number(value) >= max} onClick={() => bump(1)}>
        +
      </button>
    </div>
  );
}
