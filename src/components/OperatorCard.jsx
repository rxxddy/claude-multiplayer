import { memo, useEffect, useRef, useState } from 'react';
import { NumberInput } from './Controls';
import { createPortal } from 'react-dom';
import { OperatorSvgIcon } from './Avatar';
import { confirmBox } from './Toasts';
import { useT, t as tr, useTranslatedText } from '../i18n';

const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
const ROLE_TAG = { owner: 'OWNER', admin: 'ADMIN' };

const pct = (v) => Math.max(0, Math.min(100, Number(v) || 0));
const hhmm = (ts) => (ts ? new Date(Number(ts) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--');
const tone = (v) => (v >= 90 ? 'danger' : v >= 70 ? 'warn' : 'ok');

function Bar({ label, value, hint, wide }) {
  const v = pct(value);
  return (
    <div className={`oc-bar ${wide ? 'oc-bar--wide' : ''}`} title={hint}>
      <span className="oc-bar__label">{label}</span>
      <div className="oc-bar__track">
        <div className={`oc-bar__fill oc-bar__fill--${tone(v)}`} style={{ width: `${v}%` }} />
      </div>
      <span className="oc-bar__val">{v}%</span>
    </div>
  );
}

function usageInfo(op) {
  if (op.usage_masked || op.usage_s === null || op.usage_s === undefined) return { hidden: true };
  if (Number(op.usage_s) >= 0) return { s: op.usage_s, w: op.usage_w, at: hhmm(op.usage_ts), reset: op.usage_reset, real: true };
  return { s: op.quota_pct, w: null, real: false };
}

function statusOf(op) {
  if (!op.is_online) return { text: 'OFFLINE', cls: 'off' };
  return { text: op.status || 'IDLE', cls: String(op.status || 'idle').toLowerCase() };
}

/** Detects what just changed for an operator (points, commits, status) and returns a short-lived effect. */
function useOperatorFx(op, statusCls) {
  const prev = useRef(null);
  const [fx, setFx] = useState(null);
  useEffect(() => {
    const cur = { points: Number(op.points || 0), commits: Number(op.commits_day || 0), status: statusCls };
    const p = prev.current;
    prev.current = cur;
    if (!p) return undefined;
    let next = null;
    if (cur.points !== p.points) {
      const d = cur.points - p.points;
      next = { kind: d > 0 ? 'gain' : 'loss', label: `${d > 0 ? '+' : ''}${d.toLocaleString()}` };
    } else if (cur.commits > p.commits) {
      next = { kind: 'commit', label: tr('card.commitFx', { n: cur.commits - p.commits }) };
    } else if (cur.status !== p.status) {
      next = { kind: 'status', label: null };
    }
    if (!next) return undefined;
    setFx({ ...next, id: Date.now() });
    const t = setTimeout(() => setFx(null), 1600);
    return () => clearTimeout(t);
  }, [op.points, op.commits_day, statusCls]);
  return fx;
}

/** Compact square tile for the leaderboard grid; full details live in PlayerCardModal. */
export const OperatorCard = memo(function OperatorCard({ op, isMe, onOpen }) {
  const t = useT();
  const st = statusOf(op);
  const u = usageInfo(op);
  const fx = useOperatorFx(op, st.cls);
  return (
    <button
      type="button"
      className={`oc ${op.is_week_champion ? 'oc--champ' : ''} ${st.cls === 'off' ? 'oc--off' : ''} ${op.rank <= 3 ? `oc--top${op.rank}` : ''} ${fx ? `oc--${fx.kind}` : ''}`}
      onClick={() => onOpen(op)}
      title={t('card.openProfile')}
    >
      {fx?.label && (
        <span key={fx.id} className={`oc__fx oc__fx--${fx.kind}`}>
          {fx.label}
        </span>
      )}
      <div className="oc__top">
        <span className={`oc__rank oc__rank--${op.rank <= 3 ? op.rank : 'n'}`}>{MEDAL[op.rank] || `#${op.rank}`}</span>
        <span className={`oc__dot oc__dot--${st.cls}`} title={st.text} />
      </div>
      <OperatorSvgIcon color={op.avatar_color || '#D97757'} preset={op.avatar_preset} status={op.status} isOnline={op.is_online} size={30} />
      <div className="oc__nick">
        {op.is_week_champion && '👑 '}
        {op.display_nick}
        {isMe && <em>{t('card.you')}</em>}
      </div>
      {ROLE_TAG[op.role] && <span className={`oc__role oc__role--${op.role}`}>{ROLE_TAG[op.role]}</span>}
      <div className="oc__pts">
        {Number(op.points ?? 0).toLocaleString()} <small>{t('card.pts')}</small>
      </div>
      <div className="oc__bars">
        {u.hidden ? (
          <div className="oc-bar--hidden">{t('card.usagePrivate')}</div>
        ) : (
          <>
            <Bar label="5H" value={u.s} hint={t('card.limit5h')} />
            {u.w !== null && <Bar label="WK" value={u.w} hint={t('card.limitWeek')} />}
          </>
        )}
      </div>
      <div className="oc__commits" title={t('card.commitsTitle')}>
        {op.commits_day === null || op.commits_day === undefined ? (
          t('card.commitsPrivate')
        ) : (
          <>
            ⎇ <b>{op.commits_day}</b> {t('card.today')} · <b>{op.commits_week}</b> {t('card.week')}
          </>
        )}
      </div>
    </button>
  );
});

function Stat({ label, value, sub }) {
  return (
    <div className="pc-stat">
      <div className="pc-stat__value">{value}</div>
      <div className="pc-stat__label">{label}</div>
      {sub && <div className="pc-stat__sub">{sub}</div>}
    </div>
  );
}

/** Full-screen operator profile with every metric plus chess and moderation actions. */
export function PlayerCardModal({ op, me, myRole, maxStake, onClose, onChessInvite, onAdmin, onSendPoints }) {
  const t = useT();
  const task = useTranslatedText(op?.task || op?.task_it || '');
  const [stake, setStake] = useState(0);
  const [muteMin, setMuteMin] = useState(10);
  const [grant, setGrant] = useState(100);
  const [gift, setGift] = useState(100);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!op) return null;
  const isMe = Number(op.user_id) === Number(me?.user_id);
  const isOwner = myRole === 'owner';
  const canModerate = !isMe && (isOwner || (myRole === 'admin' && op.role === 'member'));
  const u = usageInfo(op);
  const st = statusOf(op);

  const act = async (opName, extra = {}, question) => {
    if (question && !(await confirmBox(question))) return;
    await onAdmin({ op: opName, target_user_id: op.user_id, ...extra });
  };

  return createPortal(
    <div className="pcf" onClick={onClose}>
      <div className="pcf__panel" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="deck-btn pcf__close" onClick={onClose} aria-label={t('card.close')}>
          ✕ esc
        </button>

        <header className="pcf__hero">
          <div className="pcf__avatar">
            <OperatorSvgIcon color={op.avatar_color || '#D97757'} preset={op.avatar_preset} status={op.status} isOnline={op.is_online} size={72} />
          </div>
          <div className="pcf__ident">
            <div className="pcf__nick">
              <span className="pcf__medal">{MEDAL[op.rank] || `#${op.rank}`}</span>
              {op.is_week_champion && '👑 '}
              {op.display_nick}
              {ROLE_TAG[op.role] && <span className={`oc__role oc__role--${op.role}`}>{ROLE_TAG[op.role]}</span>}
            </div>
            <div className="pcf__bio">{op.bio ? `“${op.bio}”` : t('card.noBio')}</div>
            <div className={`pcf__status oc__status--${st.cls}`}>● {st.text}</div>
          </div>
        </header>

        <div className="pcf__stats">
          <Stat label={t('card.points')} value={Number(op.points ?? 0).toLocaleString()} sub={t('card.rank', { n: op.rank })} />
          <Stat label={t('card.chessElo')} value={op.elo} sub={op.is_elo_leader ? t('card.eloLeader') : ' '} />
          <Stat label={t('card.trophies')} value={op.trophies ?? 0} sub={t('card.showdown')} />
          <Stat label={t('card.commitsToday')} value={op.commits_day ?? '—'} sub={op.commits_day == null ? t('card.notShared') : t('card.projectsFolder')} />
          <Stat label={t('card.commitsWeek')} value={op.commits_week ?? '—'} sub={op.commits_week == null ? t('card.notShared') : t('card.sinceMonday')} />
        </div>

        <div className="pcf__grid">
          <section className="pcf__box">
            <h4>{t('card.usage')}</h4>
            {u.hidden ? (
              <p className="arcade-dim">{t('card.usageHidden')}</p>
            ) : (
              <>
                <Bar wide label={t('card.limit5hShort')} value={u.s} />
                {u.w !== null && <Bar wide label={t('card.limitWeekShort')} value={u.w} />}
                {op.ctx_pct != null && <Bar wide label={t('card.context')} value={op.ctx_pct} />}
                <p className="arcade-dim pcf__note">
                  {t('card.usageFrom', { at: u.at })}
                  <br />
                  {t('card.contextHint')}
                </p>
              </>
            )}
          </section>

          <section className="pcf__box">
            <h4>{t('card.workingOn')}</h4>
            {op.project == null ? (
              <p className="arcade-dim">{t('card.focusHidden')}</p>
            ) : (
              <>
                <div className="pcf__kv">
                  <span>{t('card.project')}</span>
                  <b className="oc__proj">{op.project}</b>
                </div>
                <div className="pcf__kv">
                  <span>{t('card.branch')}</span>
                  <b>{op.branch || '—'}</b>
                </div>
                <div className="pcf__kv">
                  <span>{t('card.task')}</span>
                  <b>{task || '—'}</b>
                </div>
              </>
            )}
          </section>
        </div>

        {!isMe && (
          <section className="pcf__box">
            <h4>{t('card.chessChallenge')}</h4>
            <div className="pc__row">
              <span className="pc__label">{t('card.stake')}</span>
              <NumberInput min={0} max={maxStake} step={10} value={stake} onChange={(v) => setStake(Math.max(0, Number(v) || 0))} style={{ width: 140 }} />
              <button
                type="button"
                className="deck-btn deck-btn--primary"
                onClick={() => {
                  onChessInvite(op.display_nick, stake);
                  onClose();
                }}
              >
                {stake > 0 ? t('card.challengeFor', { n: stake }) : t('card.challengeFriendly')}
              </button>
              <span className="arcade-dim">{t('card.stakeHint')}</span>
            </div>
          </section>
        )}

        {!isMe && (
          <section className="pcf__box">
            <h4>{t('card.sendPoints')}</h4>
            <div className="pc__row">
              <NumberInput min={1} max={Number(me?.points) || 1} step={10} value={gift} onChange={(v) => setGift(Math.max(1, Number(v) || 1))} style={{ width: 140 }} />
              <button
                type="button"
                className="deck-btn deck-btn--primary"
                disabled={!(Number(me?.points) >= gift)}
                onClick={async () => {
                  if (!(await confirmBox(t('card.sendConfirm', { n: gift, nick: op.display_nick })))) return;
                  await onSendPoints(op.user_id, gift);
                }}
              >
                {t('card.sendBtn', { n: gift })}
              </button>
              <span className="arcade-dim">{t('card.sendHint')}</span>
            </div>
          </section>
        )}

        {isOwner && isMe && (
          <section className="pcf__box pcf__box--admin">
            <h4>{t('card.moderation')}</h4>
            <div className="pc__row">
              <NumberInput step={10} value={grant} onChange={(v) => setGrant(Number(v) || 0)} style={{ width: 120 }} />
              <button
                type="button"
                className="deck-btn"
                onClick={() => act('grant_points', { amount: grant }, t(grant >= 0 ? 'card.giveSelfConfirm' : 'card.removeSelfConfirm', { n: Math.abs(grant) }))}
              >
                {t('card.pointsBtn')}
              </button>
              <span className="arcade-dim">{t('card.grantSilent')}</span>
            </div>
          </section>
        )}

        {canModerate && (
          <section className="pcf__box pcf__box--admin">
            <h4>{t('card.moderation')}</h4>
            <div className="pc__row">
              <NumberInput min={1} value={muteMin} onChange={(v) => setMuteMin(Math.max(1, Number(v) || 1))} style={{ width: 100 }} />
              <button type="button" className="deck-btn" onClick={() => act('mute', { minutes: muteMin })}>
                {t('card.mute')}
              </button>
              <button type="button" className="deck-btn" onClick={() => act('unmute')}>
                {t('card.unmute')}
              </button>
              <button type="button" className="deck-btn" onClick={() => act('kick', {}, t('card.kickConfirm', { nick: op.display_nick }))}>
                {t('card.kick')}
              </button>
              <button type="button" className="deck-btn pc__danger" onClick={() => act('ban', {}, t('card.banConfirm', { nick: op.display_nick }))}>
                {t('card.ban')}
              </button>
            </div>
            {isOwner && (
              <div className="pc__row">
                {op.role === 'admin' ? (
                  <button type="button" className="deck-btn" onClick={() => act('demote')}>
                    {t('card.revokeAdmin')}
                  </button>
                ) : (
                  <button type="button" className="deck-btn" onClick={() => act('promote')}>
                    {t('card.makeAdmin')}
                  </button>
                )}
                <button type="button" className="deck-btn pc__danger" onClick={() => act('transfer', {}, t('card.transferConfirm', { nick: op.display_nick }))}>
                  {t('card.transfer')}
                </button>
                <NumberInput step={10} value={grant} onChange={(v) => setGrant(Number(v) || 0)} style={{ width: 120 }} />
                <button
                  type="button"
                  className="deck-btn"
                  onClick={() =>
                    act(
                      'grant_points',
                      { amount: grant },
                      t(grant >= 0 ? 'card.giveConfirm' : 'card.removeConfirm', { n: Math.abs(grant), nick: op.display_nick })
                    )
                  }
                >
                  {t('card.pointsBtn')}
                </button>
              </div>
            )}
          </section>
        )}
      </div>
    </div>,
    document.body
  );
}
