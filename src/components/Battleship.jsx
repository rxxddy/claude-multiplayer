import { Fragment, useMemo, useState } from 'react';
import { NumberInput } from './Controls';
import { useT } from '../i18n';

const FLEET = [5, 4, 3, 3, 2];
const N = 10;
const COLS = 'ABCDEFGHIJ';

function cellsOf(s) {
  return Array.from({ length: s.len }, (_, i) => (s.dir === 'h' ? [s.x + i, s.y] : [s.x, s.y + i]));
}

export function randomFleet() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const taken = new Set();
    const ships = [];
    let ok = true;
    for (const len of FLEET) {
      let placed = false;
      for (let t = 0; t < 100 && !placed; t++) {
        const dir = Math.random() < 0.5 ? 'h' : 'v';
        const x = Math.floor(Math.random() * (dir === 'h' ? N - len + 1 : N));
        const y = Math.floor(Math.random() * (dir === 'v' ? N - len + 1 : N));
        const s = { x, y, len, dir };
        // keep a one-cell gap around ships for a classic look
        const clash = cellsOf(s).some(([cx, cy]) => {
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (taken.has(`${cx + dx},${cy + dy}`)) return true;
          return false;
        });
        if (!clash) {
          cellsOf(s).forEach(([cx, cy]) => taken.add(`${cx},${cy}`));
          ships.push(s);
          placed = true;
        }
      }
      if (!placed) {
        ok = false;
        break;
      }
    }
    if (ok) return ships;
  }
  return [];
}

function Grid({ title, cellClass, onCell, disabled }) {
  return (
    <div className="bs-grid-wrap">
      <div className="bs-grid-title">{title}</div>
      <div className={`bs-grid ${disabled ? 'bs-grid--disabled' : ''}`}>
        <span />
        {[...COLS].map((c) => (
          <span key={c} className="bs-axis">
            {c}
          </span>
        ))}
        {Array.from({ length: N }, (_, y) => (
          <Fragment key={y}>
            <span className="bs-axis">{y + 1}</span>
            {Array.from({ length: N }, (_, x) => (
              <button key={x} type="button" className={`bs-cell ${cellClass(x, y)}`} disabled={disabled || !onCell} onClick={() => onCell?.(x, y)} />
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function Game({ g, act, me }) {
  const t = useT();
  const [draft, setDraft] = useState(() => randomFleet());
  const [flash, setFlash] = useState(null);

  const myCells = useMemo(() => {
    const set = new Map();
    (g.my_board?.ships || (g.status === 'PLACING' && !g.i_am_ready ? draft : [])).forEach((s) => cellsOf(s).forEach(([x, y]) => set.set(`${x},${y}`, true)));
    return set;
  }, [g, draft]);
  const hitsTaken = useMemo(() => new Set((g.my_board?.hits_taken || []).map(([x, y]) => `${x},${y}`)), [g]);
  const missTaken = useMemo(() => new Set((g.my_board?.misses_taken || []).map(([x, y]) => `${x},${y}`)), [g]);
  const shots = useMemo(() => new Map((g.my_shots || []).map(([x, y, r]) => [`${x},${y}`, r])), [g]);

  const fire = async (x, y) => {
    if (shots.has(`${x},${y}`)) return;
    const r = await act('bs_fire', { game_id: g.id, x, y });
    if (r) {
      setFlash({ key: `${x},${y}`, result: r.result });
      setTimeout(() => setFlash(null), 900);
    }
  };

  const header = (
    <div className="bs-head">
      <b>{t('battleship.vs', { nick: g.opponent_nick })}</b>
      {Number(g.stake) > 0 && <span className="chip">{t('battleship.each', { n: g.stake })}</span>}
      <span className="arcade-dim">
        {t(`battleship.st_${g.status}`) === `battleship.st_${g.status}` ? g.status.toLowerCase() : t(`battleship.st_${g.status}`)}
      </span>
    </div>
  );

  if (g.status === 'INVITED') {
    return (
      <div className="bs-game">
        {header}
        <div className="pc__row">
          {!g.is_inviter && (
            <button type="button" className="deck-btn deck-btn--primary" onClick={() => act('bs_accept', { game_id: g.id })}>
              {t('battleship.accept')}
            </button>
          )}
          <button type="button" className="deck-btn" onClick={() => act('bs_decline', { game_id: g.id })}>
            {g.is_inviter ? t('battleship.withdraw') : t('battleship.decline')}
          </button>
          {g.is_inviter && <span className="arcade-dim">{t('battleship.waitingFor', { nick: g.opponent_nick })}</span>}
        </div>
      </div>
    );
  }

  if (g.status === 'PLACING') {
    return (
      <div className="bs-game">
        {header}
        {g.i_am_ready ? (
          <div className="arcade-dim">{t('battleship.deployedWaiting', { nick: g.opponent_nick })}</div>
        ) : (
          <>
            <Grid title={t('battleship.preview')} cellClass={(x, y) => (myCells.has(`${x},${y}`) ? 'bs-cell--ship' : '')} disabled />
            <div className="pc__row">
              <button type="button" className="deck-btn" onClick={() => setDraft(randomFleet())}>
                {t('battleship.shuffle')}
              </button>
              <button type="button" className="deck-btn deck-btn--primary" onClick={() => act('bs_place', { game_id: g.id, ships: draft })}>
                {t('battleship.deploy')}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  const over = g.status === 'FINISHED';
  const iWon = over && Number(g.winner_id) === Number(me?.user_id);
  return (
    <div className="bs-game">
      {header}
      <div className={`bs-turn ${g.my_turn && !over ? 'bs-turn--me' : ''}`}>
        {over
          ? iWon
            ? t('battleship.victory')
            : t('battleship.defeat')
          : g.my_turn
            ? t('battleship.yourShot')
            : t('battleship.aiming', { nick: g.opponent_nick })}
      </div>
      <div className="bs-boards">
        <Grid
          title={t('battleship.enemy')}
          disabled={over || !g.my_turn}
          onCell={fire}
          cellClass={(x, y) => {
            const k = `${x},${y}`;
            const r = shots.get(k);
            return `${r ? `bs-cell--${r}` : 'bs-cell--fog'} ${flash?.key === k ? `bs-flash bs-flash--${flash.result}` : ''}`;
          }}
        />
        <Grid
          title={t('battleship.yourFleet')}
          disabled
          cellClass={(x, y) => {
            const k = `${x},${y}`;
            return `${myCells.has(k) ? 'bs-cell--ship' : ''} ${hitsTaken.has(k) ? 'bs-cell--hit' : ''} ${missTaken.has(k) ? 'bs-cell--miss' : ''}`;
          }}
        />
      </div>
      {!over && (
        <button type="button" className="msg-reply-btn" onClick={() => act('bs_resign', { game_id: g.id }, t('battleship.surrenderConfirm'))}>
          {t('battleship.surrender')}
        </button>
      )}
    </div>
  );
}

export default function Battleship({ games, act, me, maxStake }) {
  const t = useT();
  const [nick, setNick] = useState('');
  const [stake, setStake] = useState(0);
  const live = games.filter((g) => g.status !== 'CANCELLED');
  return (
    <section className="arcade-box">
      <div className="arcade-title">
        $ battleship --vs {nick || '<nick>'} --stake {stake}
      </div>
      <div className="arcade-row">
        <input className="deck-input" placeholder="@nick" value={nick} onChange={(e) => setNick(e.target.value.replace(/^@/, ''))} style={{ width: 150 }} />
        <NumberInput min={0} max={maxStake} step={10} value={stake} onChange={(v) => setStake(Math.max(0, Number(v) || 0))} style={{ width: 120 }} />
        <button type="button" className="deck-btn deck-btn--primary" disabled={!nick} onClick={() => act('bs_invite', { target_nick: nick, stake })}>
          {t('battleship.challenge')}
        </button>
        <span className="arcade-dim">{t('battleship.rules')}</span>
      </div>
      {live.length === 0 && <div className="arcade-dim">{t('battleship.none')}</div>}
      {live.map((g) => (
        <Game key={g.id} g={g} act={act} me={me} />
      ))}
    </section>
  );
}
