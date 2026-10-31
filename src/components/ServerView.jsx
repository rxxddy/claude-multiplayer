import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ChessArena from './ChessArena';
import { createPortal } from 'react-dom';
import { useSession } from '../lib/sessions';
import Leaderboard from './Leaderboard';
import ChatPanel from './ChatPanel';
import Arcade from './Arcade';
import { ChessPanel, CommitFeed, runAct } from './ChessPanel';
import { PlayerCardModal } from './OperatorCard';
import { ProfileModal, PrivacyModal, PathsModal, ServerAdminModal } from './Modals';
import { notify, notifyAction, confirmBox } from './Toasts';
import { useT, t as tr } from '../i18n';

function SnippetModal({ snippet, onClose }) {
  const t = useT();
  if (!snippet) return null;
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-card--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{t('server.snippetFrom', { nick: snippet.sender_nick })}</h3>
          <div className="pc__row">
            <button
              type="button"
              className="deck-btn"
              onClick={() => navigator.clipboard?.writeText(snippet.snippet_body).then(() => notify(t('server.copied'), 'ok'))}
            >
              {t('server.copy')}
            </button>
            <button type="button" className="deck-btn" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <pre className="snippet-body">{snippet.snippet_body}</pre>
      </div>
    </div>,
    document.body
  );
}

export default function ServerView({ session, entry, localSnap, settings, onEntryUpdated, onSignOut, onToggleTray, onForceSync, onDiag, onProjectsRoot }) {
  const state = useSession(entry.id);
  const t = useT();
  const [tab, setTab] = useState('CHAT');
  const [modal, setModal] = useState(null);
  const [viewOp, setViewOp] = useState(null);
  const [snippet, setSnippet] = useState(null);
  const [frozen, setFrozen] = useState(null);
  const [arena, setArena] = useState(false);
  const seenInvites = useRef(new Set());
  const me = state.me;
  const role = state.server?.my_role;
  const isAdmin = role === 'owner' || role === 'admin';
  const snippets = useMemo(() => state.messages.filter((m) => m.msg_type === 'SNIPPET'), [state.messages]);

  const act = useCallback((action, payload, confirmText) => runAct(session, action, payload, confirmText, confirmBox), [session]);

  // incoming chess challenges pop up bottom-right with accept / decline
  useEffect(() => {
    const myId = Number(me?.user_id);
    for (const g of state.chess || []) {
      if (g.status !== 'INVITED' || Number(g.black_user_id) !== myId || seenInvites.current.has(g.id)) continue;
      seenInvites.current.add(g.id);
      notifyAction(Number(g.stake) > 0 ? tr('server.challengeStake', { nick: g.white_nick, stake: g.stake }) : tr('server.challenge', { nick: g.white_nick }), [
        {
          label: tr('server.accept'),
          primary: true,
          onClick: () => act('chess_accept', { game_id: g.id, challenger_nick: g.white_nick }).then((r) => r && setArena(true)),
        },
        { label: tr('server.decline'), onClick: () => act('chess_decline', { game_id: g.id, nick: g.white_nick }) },
      ]);
    }
  }, [state.chess, me?.user_id, act]);

  const onCommand = async (raw) => {
    const [cmd, a1 = '', a2 = ''] = raw.split(/\s+/);
    const nick = a1.replace(/^@/, '');
    switch (cmd) {
      case '/chess':
        return nick ? act('chess_invite', { target_nick: nick, stake: Number(a2) || 0 }) : notify(t('server.usageChess'), 'info');
      case '/accept':
        return act('chess_accept', { challenger_nick: nick });
      case '/decline':
        return act('chess_decline', { nick });
      case '/resign': {
        const g = state.chess.find((x) => x.status === 'ACTIVE');
        return g ? act('chess_move', { game_id: g.id, resign: true }, t('server.resignConfirm')) : notify(t('server.noActiveChess'), 'info');
      }
      case '/bs':
        setTab('ARCADE');
        return nick ? act('bs_invite', { target_nick: nick, stake: Number(a2) || 0 }) : notify(t('server.usageBs'), 'info');
      case '/share':
        return notify(t('server.useShare'), 'info');
      default:
        return notify(t('server.unknownCmd', { cmd }), 'error');
    }
  };

  const points = Number(frozen ?? me?.points ?? 0);

  if (!state.me && (state.status === 'connecting' || state.status === 'none')) {
    return (
      <div className="connect">
        <div className="entering">
          <div className="entering__ring" />
          <div className="entering__title">{t('server.entering', { name: entry.name })}</div>
          <div className="entering__steps">
            <span className="is-done">{t('server.authenticated')}</span>
            <span className="is-on">{t('server.syncing')}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <main className="deck-viewport">
      <aside className="left-column">
        <div className="workspace-toolbar">
          <div className="toolbar-group">
            <button type="button" className="deck-btn deck-btn--primary" onClick={() => setModal('PROFILE')} title={t('server.editProfile')}>
              ◉ {me?.display_nick || entry.username}
            </button>
            <button type="button" className="deck-btn" onClick={() => setModal('PRIVACY')} title={t('server.privacyTitle')}>
              {t('server.privacy')}
            </button>
            <button type="button" className="deck-btn" onClick={() => setModal('PATHS')} title={t('server.pathsTitle')}>
              {t('server.paths')}
            </button>
            {isAdmin && (
              <button type="button" className="deck-btn" onClick={() => setModal('ADMIN')}>
                {t('server.server')}
              </button>
            )}
          </div>
          <div className="toolbar-group">
            <label
              className={`switch ${settings?.tray_enabled ? 'switch--on' : ''}`}
              title={t('server.trayTitle')}
              onClick={() => onToggleTray(!settings?.tray_enabled)}
            >
              <span className="switch__track" />
              <span>{t('server.tray')}</span>
            </label>
            <button type="button" className="deck-btn" onClick={onForceSync} title={t('server.syncTitle')}>
              {t('server.sync')}
            </button>
            <button type="button" className="deck-btn deck-btn--ghost" onClick={onSignOut} title={t('server.signOut')} aria-label={t('server.signOut')}>
              {t('server.signOutShort')}
            </button>
          </div>
        </div>

        <Leaderboard session={session} membersRev={state.membersRev} me={me} onOpen={setViewOp} />

        <div className="server-strip tabular">
          <span>{t('server.online', { n: state.onlineCount })}</span>
          <span>{t('server.pts', { n: points.toLocaleString() })}</span>
          <span>{t('server.elo', { n: me?.elo ?? '—' })}</span>
          {state.limits && <span>{t('server.spinsLeft', { n: state.limits.spins_5h_left })}</span>}
          <span className={`server-strip__state server-strip__state--${state.status}`}>{state.status === 'ok' ? t('server.synced') : state.status}</span>
        </div>

        <div className="lower-split">
          <ChessPanel games={state.chess} me={me} act={act} onExpand={() => setArena(true)} />
          <CommitFeed items={state.commitFeed} />
        </div>
      </aside>

      <section className="right-column">
        <div className="chat-header">
          <div>
            <button type="button" className={`deck-btn ${tab === 'CHAT' ? 'deck-btn--primary' : ''}`} onClick={() => setTab('CHAT')}>
              {t('server.tabChat')}
            </button>
            <button type="button" className={`deck-btn ${tab === 'SNIPPETS' ? 'deck-btn--primary' : ''}`} onClick={() => setTab('SNIPPETS')}>
              {t('server.tabSnippets')} <span className="tab-count">{snippets.length}</span>
            </button>
            <button type="button" className={`deck-btn ${tab === 'ARCADE' ? 'deck-btn--primary' : ''}`} onClick={() => setTab('ARCADE')}>
              {t('server.tabArcade')} <span className="tab-count">{points.toLocaleString()}</span>
            </button>
          </div>
        </div>

        {tab === 'CHAT' && <ChatPanel session={session} state={state} onCommand={onCommand} onOpenSnippet={setSnippet} />}
        {tab === 'SNIPPETS' && (
          <div className="arcade">
            {snippets.length === 0 && <div className="arcade-dim">{t('server.noSnippets')}</div>}
            {[...snippets].reverse().map((m) => (
              <button key={m.id} type="button" className="snippet-row" onClick={() => setSnippet(m)}>
                <b>{m.sender_nick}</b> <span className="arcade-dim">{new Date(Number(m.created_ts) * 1000).toLocaleString()}</span>
                <pre>{String(m.snippet_body).split('\n').slice(0, 4).join('\n')}</pre>
              </button>
            ))}
          </div>
        )}
        {tab === 'ARCADE' && (
          <Arcade
            me={me}
            duels={state.duels}
            messages={state.messages}
            limits={state.limits}
            battleship={state.battleship}
            act={act}
            maxStake={state.server?.settings?.max_stake}
            gamesEnabled={state.server?.settings?.games_enabled !== false}
            callApi={(action, payload) => session.call(action, payload)}
            onPoints={() => session.kick()}
            onFreeze={setFrozen}
          />
        )}
      </section>

      {viewOp && (
        <PlayerCardModal
          op={viewOp}
          me={me}
          myRole={role}
          maxStake={state.server?.settings?.max_stake}
          onClose={() => setViewOp(null)}
          onChessInvite={(nick, stake) => act('chess_invite', { target_nick: nick, stake })}
          onAdmin={async (payload) => {
            const r = await act('admin', payload);
            if (r) notify(t('server.done'), 'ok');
            return Boolean(r);
          }}
          onSendPoints={async (targetUserId, amount) => {
            const r = await act('transfer_points', { target_user_id: targetUserId, amount });
            if (r) notify(t('card.sent'), 'ok');
          }}
        />
      )}
      {arena && (
        <ChessArena session={session} games={state.chess} me={me} act={act} maxStake={state.server?.settings?.max_stake} onClose={() => setArena(false)} />
      )}
      <SnippetModal snippet={snippet} onClose={() => setSnippet(null)} />
      {modal === 'PROFILE' && <ProfileModal me={me} session={session} taskIt={localSnap?.task_it} onClose={() => setModal(null)} />}
      {modal === 'PRIVACY' && <PrivacyModal entry={entry} onSaved={onEntryUpdated} onClose={() => setModal(null)} />}
      {modal === 'PATHS' && (
        <PathsModal
          diag={localSnap?.path_diagnostics}
          projectsRoot={settings?.projects_root}
          onDiag={onDiag}
          onProjectsRoot={onProjectsRoot}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'ADMIN' && <ServerAdminModal state={state} session={session} onClose={() => setModal(null)} />}
    </main>
  );
}
