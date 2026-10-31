import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Chess } from 'chess.js';
import { notify } from './Toasts';
import { useT } from '../i18n';

const GLYPH = {
  w: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕', k: '♔' },
  b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' },
};
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

export function ChessPanel({ games, me, act, onExpand, big }) {
  const t = useT();
  const [activeId, setActiveId] = useState(null);
  const [selected, setSelected] = useState(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return undefined;
    const k = (e) => e.key === 'Escape' && setFull(false);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [full]);
  const game = games.find((g) => Number(g.id) === Number(activeId)) || games[0] || null;
  const myId = Number(me?.user_id || 0);

  const view = useMemo(() => {
    const engine = new Chess();
    if (game?.fen) {
      try {
        engine.load(game.fen);
      } catch {
        /* corrupted fen → start position */
      }
    }
    const isWhite = Number(game?.white_user_id) === myId;
    const turn = engine.turn();
    return { engine, board: engine.board(), isWhite, isMyTurn: game?.status === 'ACTIVE' && (turn === 'w') === isWhite, turn };
  }, [game, myId]);

  // render from my side of the board
  const rows = view.isWhite || !game ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];

  const click = (r, f) => {
    if (!game || !view.isMyTurn) return;
    const sq = `${FILES[f]}${8 - r}`;
    const mine = view.isWhite ? 'w' : 'b';
    if (!selected) {
      if (view.engine.get(sq)?.color === mine) setSelected(sq);
      return;
    }
    if (selected === sq) return setSelected(null);
    try {
      // the local engine only pre-validates for snappy UX; the server re-validates the move and decides results
      const mv = view.engine.move({ from: selected, to: sq, promotion: 'q' });
      setSelected(null);
      if (!mv) return;
      act('chess_move', { game_id: Number(game.id), from: mv.from, to: mv.to, promotion: mv.promotion || undefined });
    } catch {
      setSelected(view.engine.get(sq)?.color === mine ? sq : null);
    }
  };

  const pane = (
    <div className={`chess-pane ${full || big ? 'chess-pane--full' : ''}`}>
      <div className="chess-tabs">
        <button
          type="button"
          className="chess-expand"
          title={full ? t('chess.closeEsc') : t('chess.playFull')}
          onClick={() => (onExpand ? onExpand() : setFull((v) => !v))}
        >
          {full ? '✕' : '⛶'}
        </button>
        {games.length === 0 ? (
          <span className="arcade-dim">{t('chess.noMatches')}</span>
        ) : (
          games.map((g) => {
            const opp = Number(g.white_user_id) === myId ? g.black_nick : g.white_nick;
            return (
              <button
                key={g.id}
                type="button"
                className={`chess-tab ${Number(g.id) === Number(game?.id) ? 'chess-tab--active' : ''}`}
                onClick={() => {
                  setActiveId(g.id);
                  setSelected(null);
                }}
              >
                {t('chess.vs', { nick: opp })}
                {Number(g.stake) > 0 ? ` · ${g.stake}` : ''} {g.status === 'INVITED' ? '⏳' : ''}
              </button>
            );
          })
        )}
      </div>

      {game && game.status === 'INVITED' ? (
        <div className="chess-invite">
          {Number(game.black_user_id) === myId ? (
            <>
              <div>
                <b>{game.white_nick}</b>{' '}
                {Number(game.stake) > 0
                  ? t('chess.challengedYouStake', { elo: game.white_elo, n: game.stake })
                  : t('chess.challengedYou', { elo: game.white_elo })}
              </div>
              <div className="pc__row">
                <button type="button" className="deck-btn deck-btn--primary" onClick={() => act('chess_accept', { challenger_nick: game.white_nick })}>
                  {t('chess.accept')}
                </button>
                <button type="button" className="deck-btn" onClick={() => act('chess_decline', { nick: game.white_nick })}>
                  {t('chess.decline')}
                </button>
              </div>
            </>
          ) : (
            <>
              <div>{t('chess.waitingAccept', { nick: game.black_nick })}</div>
              <button type="button" className="deck-btn" onClick={() => act('chess_decline', { nick: game.black_nick })}>
                {t('chess.withdraw')}
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="chess-board-grid">
            {rows.map((r) =>
              (view.isWhite || !game ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0]).map((f) => {
                const cell = view.board[r][f];
                const sq = `${FILES[f]}${8 - r}`;
                return (
                  <div
                    key={sq}
                    onClick={() => click(r, f)}
                    className={`chess-sq ${(r + f) % 2 === 0 ? 'chess-sq--light' : 'chess-sq--dark'} ${selected === sq ? 'chess-sq--selected' : ''}`}
                    style={{ color: cell?.color === 'w' ? '#F0EFEA' : '#D97757' }}
                    title={sq}
                  >
                    {cell ? GLYPH[cell.color][cell.type] : ''}
                  </div>
                );
              })
            )}
          </div>
          <div className="chess-status tabular">
            <span>{game ? (view.isMyTurn ? t('chess.yourTurn') : t('chess.opponent')) : t('chess.practice')}</span>
            <span>{t('chess.last', { move: game?.last_move || '—' })}</span>
            {game?.status === 'ACTIVE' && (
              <button
                type="button"
                className="msg-reply-btn"
                onClick={() => act('chess_move', { game_id: Number(game.id), resign: true }, t('chess.resignConfirm'))}
              >
                {t('chess.resign')}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );

  if (!full) return pane;
  return (
    <>
      <div className="chess-pane chess-pane--placeholder">
        <button type="button" className="deck-btn" onClick={() => setFull(false)}>
          {t('chess.dock')}
        </button>
      </div>
      {createPortal(
        <div className="pcf" onClick={() => setFull(false)}>
          <div className="chess-full" onClick={(e) => e.stopPropagation()}>
            {pane}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

export function CommitFeed({ items }) {
  const t = useT();
  return (
    <div className="git-feed-pane">
      <div className="git-feed-head">
        <span>{t('chess.feedTitle')}</span>
        <span className="tabular">{t('chess.feedRecent', { n: items.length })}</span>
      </div>
      <div className="git-feed-list">
        {items.length === 0 ? (
          <div className="arcade-dim">{t('chess.feedEmpty')}</div>
        ) : (
          items.map((c) => (
            <div key={`${c.short_hash}-${c.id}`} className="git-item">
              <div className="git-item__meta tabular">
                <span>
                  <b>{c.handle}</b> →{' '}
                  <span className="arcade-dim">
                    {c.project}:{c.branch}
                  </span>
                </span>
                <span>
                  <span className="git-item__hash">{c.short_hash}</span> · {c.created_at}
                </span>
              </div>
              <div className="git-item__msg" title={c.message}>
                {c.message}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export async function runAct(session, action, payload, confirmText, confirmBox) {
  if (confirmText && !(await confirmBox(confirmText))) return null;
  try {
    const r = await session.call(action, payload);
    session.kick();
    return r;
  } catch (err) {
    notify(err.message, 'error');
    return null;
  }
}
