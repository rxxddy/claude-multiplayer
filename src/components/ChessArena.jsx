import { useEffect, useState } from 'react';
import { NumberInput } from './Controls';
import { createPortal } from 'react-dom';
import { ChessPanel } from './ChessPanel';
import { useT } from '../i18n';

/** Full-screen chess: nick search + multi-invite bar on top, the board below. First accepted invite plays. */
export default function ChessArena({ session, games, me, act, maxStake, onClose }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [people, setPeople] = useState([]);
  const [stake, setStake] = useState(0);
  const myId = Number(me?.user_id);
  const outgoing = games.filter((g) => g.status === 'INVITED' && Number(g.white_user_id) === myId);
  const incoming = games.filter((g) => g.status === 'INVITED' && Number(g.black_user_id) === myId);
  const invited = new Set(outgoing.map((g) => String(g.black_nick).toLowerCase()));

  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  useEffect(() => {
    const timer = setTimeout(() => {
      session
        .call('members', { q: q.trim() || 'online', limit: 30 })
        .then((r) => setPeople((r.items || []).filter((m) => Number(m.user_id) !== myId)))
        .catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [q, session, myId]);

  return createPortal(
    <div className="pcf" onClick={onClose}>
      <div className="arena" onClick={(e) => e.stopPropagation()}>
        <div className="arena__bar">
          <span className="arena__title">{t('chess.arena')}</span>
          <input className="deck-input arena__search" autoFocus placeholder={t('chess.findPlayer')} value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="arcade-dim">{t('chess.stake')}</span>
          <NumberInput min={0} max={maxStake} step={10} value={stake} onChange={(v) => setStake(Math.max(0, Number(v) || 0))} style={{ width: 120 }} />
          <button type="button" className="deck-btn" onClick={onClose} title="Esc">
            ✕
          </button>
        </div>
        <div className="arena__people">
          {people.length === 0 && <span className="arcade-dim">{t('chess.noPlayers')}</span>}
          {people.map((p) => {
            const done = invited.has(String(p.display_nick).toLowerCase());
            return (
              <button
                key={p.user_id}
                type="button"
                className={`arena__nick ${done ? 'is-invited' : ''} ${p.is_online ? 'is-online' : ''}`}
                disabled={done}
                onClick={() => act('chess_invite', { target_nick: p.display_nick, stake })}
                title={
                  done
                    ? t('chess.inviteSent')
                    : stake
                      ? t('chess.challengeNickStake', { nick: p.display_nick, n: stake })
                      : t('chess.challengeNick', { nick: p.display_nick })
                }
              >
                <span className="arena__dot" />
                {p.display_nick}
                <span className="arcade-dim">{p.elo}</span>
                <b>{done ? '⏳' : '+'}</b>
              </button>
            );
          })}
        </div>
        {(outgoing.length > 0 || incoming.length > 0) && (
          <div className="arena__invites">
            {outgoing.length > 0 && (
              <span>
                {t('chess.waitingFor')}{' '}
                {outgoing.map((g) => (
                  <span key={g.id} className="chip">
                    {g.black_nick}
                    {Number(g.stake) > 0 && ` · ${g.stake}`}
                    <button
                      type="button"
                      className="msg-reply-btn"
                      onClick={() => act('chess_decline', { game_id: g.id, nick: g.black_nick })}
                      title={t('chess.withdraw')}
                    >
                      ✕
                    </button>
                  </span>
                ))}
                <span className="arcade-dim">{t('chess.firstAccept')}</span>
              </span>
            )}
            {incoming.map((g) => (
              <span key={g.id} className="chip chip--on">
                {t('chess.challengesYou', { nick: g.white_nick })}
                {Number(g.stake) > 0 && t('chess.ptsSuffix', { n: g.stake })}
                <button type="button" className="msg-reply-btn" onClick={() => act('chess_accept', { game_id: g.id, challenger_nick: g.white_nick })}>
                  {t('chess.accept')}
                </button>
                <button type="button" className="msg-reply-btn" onClick={() => act('chess_decline', { game_id: g.id, nick: g.white_nick })}>
                  {t('chess.decline')}
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="arena__board">
          <ChessPanel games={games.filter((g) => g.status === 'ACTIVE')} me={me} act={act} big />
        </div>
      </div>
    </div>,
    document.body
  );
}
