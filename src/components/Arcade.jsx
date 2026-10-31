import { useState, useRef, useEffect, useMemo, memo } from 'react';
import { NumberInput } from './Controls';
import { notify } from './Toasts';
import Battleship from './Battleship';
import { useT, t as tr } from '../i18n';

// Terminal-style casino. RNG is server-side; the client only animates towards the server result.
const CELL_W = 64;
const STRIP_LEN = 60;
const TARGET_AT = 52;
const SPIN_MS = 3200;

const rouletteColor = (n) => (n === 0 ? 'green' : n % 2 === 1 ? 'red' : 'black'); // must match server rule
const CASE_POOL = ['x0', 'x0.25', 'x0.5', 'x0.75', 'x1.25', 'x1.5', 'x2', 'x3', 'x5', 'x10', 'x25', 'x50', 'x100', '-x2', '-x5'];

function caseTier(label) {
  if (label.startsWith('-') || label === 'x0') return 'loss';
  const m = parseFloat(label.slice(1));
  if (m < 1) return 'common';
  if (m <= 2) return 'rare';
  if (m <= 5) return 'epic';
  if (m <= 25) return 'legend';
  return 'mythic';
}

const randomRouletteCell = () => {
  const n = Math.floor(Math.random() * 37);
  return { label: String(n), tone: rouletteColor(n) };
};
const randomCaseCell = () => {
  // visual weighting: mostly low tiers, rare jackpots flashing by
  const r = Math.random();
  const label =
    r < 0.55 ? CASE_POOL[Math.floor(Math.random() * 6)] : r < 0.9 ? CASE_POOL[6 + Math.floor(Math.random() * 3)] : CASE_POOL[9 + Math.floor(Math.random() * 6)];
  return { label, tone: caseTier(label) };
};

/** Horizontal reel that decelerates onto strip[TARGET_AT]; pure CSS transform (GPU, no per-frame JS). */
function Reel({ strip, spinId, onDone }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !spinId) return undefined;
    const jitter = Math.floor(Math.random() * (CELL_W - 16)) - (CELL_W - 16) / 2;
    const target = -(TARGET_AT * CELL_W) + (el.parentElement.clientWidth / 2 - CELL_W / 2) + jitter;
    el.style.transition = 'none';
    el.style.transform = 'translateX(0px)';
    // force reflow so the transition restarts
    void el.offsetWidth;
    el.style.transition = `transform ${SPIN_MS}ms cubic-bezier(0.1, 0.7, 0.12, 1)`;
    el.style.transform = `translateX(${target}px)`;
    const t = setTimeout(onDone, SPIN_MS + 80);
    return () => clearTimeout(t);
  }, [spinId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="reel">
      <div className="reel__marker">▼</div>
      <div className="reel__strip" ref={ref}>
        {strip.map((c, i) => (
          <div key={i} className={`reel__cell reel__cell--${c.tone}`} style={{ width: CELL_W }}>
            {c.label}
          </div>
        ))}
      </div>
      <div className="reel__marker reel__marker--bottom">▲</div>
    </div>
  );
}

function Reveal({ res }) {
  const t = useT();
  if (!res) return <div className="reveal reveal--idle">{t('arcade.awaiting')}</div>;
  const win = res.delta > 0;
  const even = res.delta === 0;
  const big = Math.abs(res.mult) >= 10;
  return (
    <div className={`reveal ${win ? 'reveal--win' : even ? 'reveal--even' : 'reveal--loss'} ${big ? 'reveal--big' : ''}`}>
      {big && win && <pre className="reveal__burst">{'* .  *  JACKPOT  *  . *'}</pre>}
      <span className="reveal__label">{res.result}</span>
      <span className="reveal__delta">{t('arcade.pts', { n: win ? `+${res.delta}` : res.delta })}</span>
    </div>
  );
}

const DiceRoll = memo(function DiceRoll({ duel }) {
  const [rolling, setRolling] = useState(true);
  const [face, setFace] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setFace(Math.floor(Math.random() * 100) + 1), 60);
    const t = setTimeout(() => {
      clearInterval(iv);
      setRolling(false);
    }, 1600);
    return () => {
      clearInterval(iv);
      clearTimeout(t);
    };
  }, []);
  const { rolls, winner, pot } = duel.result;
  return (
    <div className="dice">
      {rolls.map((r) => (
        <span key={r.id} className={`dice__p ${!rolling && r.id === winner.id ? 'dice__p--win' : ''}`}>
          [{rolling ? String(face).padStart(3) : String(r.roll).padStart(3)}] {r.nick}
        </span>
      ))}
      {!rolling && (
        <span className="arcade-win">
          → {winner.nick} +{pot}
        </span>
      )}
    </div>
  );
});

function Game({ kind, title, makeCell, stake, choice, busy, setBusy, run, onSettled, children }) {
  const t = useT();
  const [strip, setStrip] = useState(() => Array.from({ length: STRIP_LEN }, makeCell));
  const [spinId, setSpinId] = useState(0);
  const [shown, setShown] = useState(null);
  const pending = useRef(null);

  const start = async () => {
    if (busy) return;
    setBusy(kind);
    setShown(null);
    const res = await run('game_spin', { kind, bet: stake, choice });
    if (!res) return setBusy(null);
    pending.current = res;
    const cells = Array.from({ length: STRIP_LEN }, makeCell);
    cells[TARGET_AT] =
      kind === 'roulette' ? { label: res.result.split(' ')[0], tone: res.result.split(' ')[1] } : { label: res.result, tone: caseTier(res.result) };
    setStrip(cells);
    setSpinId((x) => x + 1);
  };

  const done = () => {
    const res = pending.current;
    pending.current = null;
    setShown(res);
    setBusy(null);
    onSettled(kind, res); // balance is revealed only now
  };

  return (
    <section className="arcade-box">
      <div className="arcade-title">{title}</div>
      {children}
      <Reel strip={strip} spinId={spinId} onDone={done} />
      <div className="arcade-row">
        <button type="button" className="deck-btn deck-btn--primary arcade-go" disabled={!!busy} onClick={start}>
          {busy === kind ? t('arcade.spinning') : kind === 'case' ? t('arcade.openCase') : t('arcade.spin')}
        </button>
        <Reveal res={busy === kind ? null : shown} />
      </div>
    </section>
  );
}

export default function Arcade({ me, duels, messages, callApi, onPoints, onFreeze, limits, battleship, act, maxStake, gamesEnabled = true }) {
  const t = useT();
  const livePoints = Number(me?.points ?? 0);
  const [frozen, setFrozen] = useState(null); // balance shown while a reel is spinning
  const [stake, setStake] = useState(50);
  const [choice, setChoice] = useState('red');
  const [busy, setBusyRaw] = useState(null);
  const [duelPlayers, setDuelPlayers] = useState(2);
  const [session, setSession] = useState({ pl: 0, best: 0, spins: 0 });
  const seenDuels = useRef(new Set((duels || []).filter((d) => d.status === 'DONE').map((d) => d.id)));
  const shownPoints = frozen ?? livePoints;
  const maxBet = Math.max(10, livePoints);

  useEffect(() => () => onFreeze?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  const setBusy = (b) => {
    setFrozen(b ? livePoints : null);
    onFreeze?.(b ? livePoints : null);
    setBusyRaw(b);
  };

  const run = async (action, payload) => {
    try {
      return await callApi(action, payload);
    } catch (err) {
      notify(err?.message || tr('arcade.requestFailed'), 'error');
      return null;
    }
  };

  const settled = (kind, res) => {
    if (!res) return;
    onPoints(res.points);
    setSession((s) => ({ pl: s.pl + res.delta, best: Math.max(s.best, res.delta), spins: s.spins + 1 }));
    if (Math.abs(res.mult) >= 10)
      notify(
        tr('arcade.bigResult', { kind: kind.toUpperCase(), result: res.result, delta: `${res.delta > 0 ? '+' : ''}${res.delta}` }),
        res.delta > 0 ? 'ok' : 'error'
      );
  };

  const duelAction = async (action, payload) => {
    const res = await run(action, payload);
    if (res && typeof res.points === 'number') onPoints(res.points);
  };

  const casinoFeed = useMemo(() => (messages || []).filter((m) => m.sender_nick === 'CASINO').slice(-8), [messages]);

  if (!gamesEnabled) {
    return (
      <div className="arcade">
        <div className="arcade-dim">{t('arcade.disabled')}</div>
      </div>
    );
  }

  return (
    <div className="arcade">
      <div className="arcade-hud">
        <pre className="arcade-banner">{`▄▀█ █▀█ █▀▀ ▄▀█ █▀▄ █▀▀
█▀█ █▀▄ █▄▄ █▀█ █▄▀ ██▄`}</pre>
        <div className="arcade-hud__stats">
          <div className={`arcade-balance ${busy ? 'arcade-balance--locked' : ''}`}>
            {shownPoints.toLocaleString()}{' '}
            <small>
              {t('arcade.ptsUnit')}
              {busy ? t('arcade.locked') : ''}
            </small>
          </div>
          {limits && (
            <div className="arcade-session" title={t('arcade.limitsTitle')}>
              {t('arcade.spinsLeft', { h: limits.spins_5h_left, w: limits.spins_week_left })}
            </div>
          )}
          <div className="arcade-session">
            {t('arcade.session', { pl: `${session.pl >= 0 ? '+' : ''}${session.pl}`, best: session.best, spins: session.spins })}
          </div>
        </div>
      </div>

      <div className="arcade-row">
        <span className="arcade-prompt">{t('arcade.stake')}</span>
        <NumberInput min={10} step={10} value={stake} disabled={!!busy} onChange={(v) => setStake(Math.max(10, Number(v) || 10))} style={{ width: 130 }} />
        {[
          [t('arcade.min'), 10],
          ['½', Math.floor(shownPoints / 2)],
          ['¼', Math.floor(shownPoints / 4)],
          [t('arcade.max'), maxBet],
        ].map(([l, v]) => (
          <button key={l} type="button" className="deck-btn" disabled={!!busy} onClick={() => setStake(Math.max(10, v))}>
            {l}
          </button>
        ))}
        {stake > shownPoints && <span className="arcade-loss">{t('arcade.insufficient')}</span>}
      </div>

      <Game
        kind="roulette"
        title={`$ roulette --on ${choice} --bet ${stake}`}
        makeCell={randomRouletteCell}
        stake={stake}
        choice={choice}
        busy={busy}
        setBusy={setBusy}
        run={run}
        onSettled={settled}
      >
        <div className="arcade-row">
          {[
            ['red', '×2'],
            ['black', '×2'],
            ['green', '×14'],
          ].map(([c, m]) => (
            <button key={c} type="button" disabled={!!busy} className={`chip chip--${c} ${choice === c ? 'chip--on' : ''}`} onClick={() => setChoice(c)}>
              {t(`arcade.${c}`)} {m}
            </button>
          ))}
        </div>
      </Game>

      <Game
        kind="case"
        title={`$ open-case --upgrade ${stake}   (×0 … ×100 · rare −×5)`}
        makeCell={randomCaseCell}
        stake={stake}
        busy={busy}
        setBusy={setBusy}
        run={run}
        onSettled={settled}
      />

      <section className="arcade-box">
        <div className="arcade-title">
          $ dice-duel --players {duelPlayers} --stake {stake} (highest d100 takes the pot)
        </div>
        <div className="arcade-row">
          {[2, 3, 4, 6, 8].map((n) => (
            <button key={n} type="button" className={`chip ${duelPlayers === n ? 'chip--on' : ''}`} onClick={() => setDuelPlayers(n)}>
              {n}P
            </button>
          ))}
          <button type="button" className="deck-btn deck-btn--primary" onClick={() => duelAction('duel_create', { stake, max_players: duelPlayers })}>
            {t('arcade.openDuel')}
          </button>
        </div>
        {(duels || []).length === 0 && <div className="arcade-dim">{t('arcade.noDuels')}</div>}
        {(duels || []).map((d) => {
          const mine = d.players.some((p) => Number(p.id) === Number(me?.user_id));
          const fresh = d.status === 'DONE' && !seenDuels.current.has(d.id);
          if (fresh) seenDuels.current.add(d.id);
          return (
            <div key={d.id} className={`arcade-duel arcade-duel--${d.status.toLowerCase()}`}>
              <span className="arcade-dim">#{d.id}</span>
              <span>
                {t('arcade.duelStake', { n: d.stake })} · [{d.players.length}/{d.max_players}] {d.players.map((p) => p.nick).join(', ')}
              </span>
              {d.status === 'OPEN' && !mine && (
                <button type="button" className="deck-btn deck-btn--primary" onClick={() => duelAction('duel_join', { duel_id: d.id })}>
                  {t('arcade.join')}
                </button>
              )}
              {d.status === 'OPEN' && Number(d.creator_id) === Number(me?.user_id) && (
                <button type="button" className="deck-btn" onClick={() => duelAction('duel_cancel', { duel_id: d.id })}>
                  {t('arcade.cancel')}
                </button>
              )}
              {d.status === 'DONE' &&
                d.result &&
                (fresh ? (
                  <DiceRoll duel={d} />
                ) : (
                  <span className="arcade-win">
                    {d.result.rolls.map((r) => `${r.nick}:${r.roll}`).join(' ')} → {d.result.winner.nick} +{d.result.pot}
                  </span>
                ))}
              {d.status === 'CANCELLED' && <span className="arcade-dim">{t('arcade.cancelled')}</span>}
            </div>
          );
        })}
      </section>

      <Battleship games={battleship || []} act={act} me={me} maxStake={maxStake} />

      <section className="arcade-feed">
        <div className="arcade-title">$ tail -f casino.log</div>
        {casinoFeed.length === 0 && <div className="arcade-dim">{t('arcade.quiet')}</div>}
        {casinoFeed.map((m) => (
          <div key={m.id} className="arcade-feed__line">
            <span className="arcade-dim">{m.created_at}</span> {m.content}
          </div>
        ))}
        <div className="arcade-dim">{t('arcade.showdown')}</div>
      </section>
    </div>
  );
}
