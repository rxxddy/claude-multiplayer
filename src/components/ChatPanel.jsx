import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { OperatorSvgIcon } from './Avatar';
import { notify, confirmBox } from './Toasts';
import { useT, t as tr } from '../i18n';

export const SLASH_HELP = [
  // second item is an i18n key
  ['/chess @nick [stake]', 'chat.helpChess'],
  ['/accept @nick', 'chat.helpAccept'],
  ['/decline @nick', 'chat.helpDecline'],
  ['/resign', 'chat.helpResign'],
  ['/bs @nick [stake]', 'chat.helpBs'],
  ['/share', 'chat.helpShare'],
  ['@claude <question>', 'chat.helpClaude'],
];

const escapeRe = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const timeOf = (m) =>
  m.created_ts ? new Date(Number(m.created_ts) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : m.created_at || '';
const dayOf = (m) => (m.created_ts ? new Date(Number(m.created_ts) * 1000).toDateString() : '');

function Content({ text, myNick }) {
  const parts = String(text || '').split(/(@[A-Za-z0-9_.-]+)/g);
  return parts.map((p, i) =>
    p.startsWith('@') ? (
      <span
        key={i}
        className={`mention ${p.slice(1).toLowerCase() === 'claude' ? 'mention--bot' : ''} ${p.slice(1).toLowerCase() === String(myNick).toLowerCase() ? 'mention--me' : ''}`}
      >
        {p}
      </span>
    ) : (
      <Fragment key={i}>{p}</Fragment>
    )
  );
}

const Message = memo(function Message({ m, quoted, myId, myNick, onReply, onOpenSnippet, highlighted }) {
  if (Number(m.user_id) === 0 && m.msg_type === 'SYSTEM') {
    const tag = String(m.sender_nick || 'SYS');
    return (
      <div className={`sys-line sys-line--${tag.toLowerCase()}`} data-id={m.id}>
        <span className="sys-line__tag">{tag}</span>
        <span className="sys-line__text">{m.content}</span>
        <span className="sys-line__time tabular">{timeOf(m)}</span>
      </div>
    );
  }
  if (['CHESS_EVENT', 'TROPHY_EVENT', 'BATTLESHIP_EVENT'].includes(m.msg_type)) {
    return (
      <div className={`event-banner event-banner--${m.msg_type === 'TROPHY_EVENT' ? 'trophy' : 'chess'}`} data-id={m.id}>
        <span>{m.content}</span>
        <span className="tabular" style={{ fontSize: 10, opacity: 0.8 }}>
          {timeOf(m)}
        </span>
      </div>
    );
  }
  const mine = Number(m.user_id) === Number(myId);
  const mentionsMe = !mine && myNick && new RegExp(`@${escapeRe(myNick)}(?![A-Za-z0-9_.-])`, 'i').test(m.content || '');
  return (
    <div
      className={`msg-card ${mentionsMe ? 'msg-card--mention' : ''} ${m.pending ? 'msg-card--pending' : ''} ${highlighted ? 'msg-card--found' : ''}`}
      data-id={m.id}
    >
      <OperatorSvgIcon color={m.avatar_color} preset={m.avatar_preset} size={18} showStatusDot={false} />
      <div className="msg-card__body">
        <div className="msg-card__header tabular">
          <span className="msg-card__author">{m.sender_nick}</span>
          <span className="msg-card__time">
            {timeOf(m)}
            {!m.pending && (
              <button type="button" className="msg-reply-btn" title={tr('chat.reply')} onClick={() => onReply(m)}>
                ↩
              </button>
            )}
          </span>
        </div>
        {Number(m.reply_to) > 0 && (
          <div className="msg-quote">┌ {quoted ? `${quoted.sender_nick}: ${String(quoted.content).slice(0, 90)}` : tr('chat.replyTo', { id: m.reply_to })}</div>
        )}
        <div className="msg-card__text">
          <Content text={m.content} myNick={myNick} />
        </div>
        {m.msg_type === 'SNIPPET' && m.snippet_body && (
          <button type="button" className="deck-btn deck-btn--primary" style={{ marginTop: 6 }} onClick={() => onOpenSnippet(m)}>
            {tr('chat.openSnippet')}
          </button>
        )}
      </div>
    </div>
  );
});

function SearchPanel({ api, onJump, onClose }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [date, setDate] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async (e) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const day = date ? Math.floor(new Date(`${date}T00:00:00`).getTime() / 1000) : undefined;
      const r = await api('search_messages', {
        q: q || undefined,
        from_nick: from.replace(/^@/, '') || undefined,
        date_from: day,
        date_to: day ? day + 86399 : undefined,
        limit: 100,
      });
      setResults(r.messages || []);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat-search">
      <form className="chat-search__bar" onSubmit={run}>
        <input className="deck-input" autoFocus placeholder={t('chat.searchText')} value={q} onChange={(e) => setQ(e.target.value)} />
        <input className="deck-input" placeholder="@user" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 120 }} />
        <input className="deck-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 140 }} />
        <button type="submit" className="deck-btn deck-btn--primary" disabled={busy}>
          {busy ? '…' : t('chat.searchBtn')}
        </button>
        <button type="button" className="deck-btn" onClick={onClose}>
          ✕
        </button>
      </form>
      {results && (
        <div className="chat-search__results">
          {results.length === 0 && <div className="arcade-dim">{t('chat.noMatches')}</div>}
          {results.map((m) => (
            <button key={m.id} type="button" className="chat-search__hit" onClick={() => onJump(m)}>
              <span className="arcade-dim">{new Date(Number(m.created_ts) * 1000).toLocaleString()}</span> <b>{m.sender_nick}</b>{' '}
              {String(m.content).slice(0, 140)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ChatPanel({ session, state, onCommand, onOpenSnippet }) {
  const { messages, me } = state;
  const t = useT();
  const listRef = useRef(null);
  const atBottomRef = useRef(true);
  const prevLenRef = useRef(messages.length);
  const prevLastRef = useRef(messages[messages.length - 1]?.id);
  const anchorRef = useRef(null);
  const [newCount, setNewCount] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [input, setInput] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [showSearch, setShowSearch] = useState(false);
  const [found, setFound] = useState(null);
  const [showHelp, setShowHelp] = useState(false);

  const byId = useRef(new Map());
  byId.current = new Map(messages.map((m) => [Number(m.id), m]));

  const scrollToBottom = (smooth) => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    setNewCount(0);
  };

  // Keep position: stick to bottom only when the reader is already there (or sent the message)
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const last = messages[messages.length - 1];
    if (anchorRef.current) {
      el.scrollTop = el.scrollHeight - anchorRef.current;
      anchorRef.current = null;
    } else if (last?.id !== prevLastRef.current) {
      const prevLast = Number(prevLastRef.current) || 0;
      const added = messages.filter((m) => !m.pending && Number(m.id) > prevLast).length;
      if (atBottomRef.current || (last && (last.pending || Number(last.user_id) === Number(me?.user_id)))) scrollToBottom(false);
      else setNewCount((c) => c + added);
    }
    prevLenRef.current = messages.length;
    prevLastRef.current = last?.id;
  }, [messages, me?.user_id]);

  useEffect(() => {
    scrollToBottom(false);
  }, [session?.entry.id]);

  const onScroll = useCallback(async () => {
    const el = listRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (session) session.readingHistory = !atBottomRef.current;
    if (atBottomRef.current && newCount) setNewCount(0);
    if (el.scrollTop < 120 && !loadingOlder && state.hasOlder && session) {
      setLoadingOlder(true);
      anchorRef.current = el.scrollHeight - el.scrollTop;
      try {
        const added = await session.loadOlder();
        if (!added) anchorRef.current = null;
      } catch {
        anchorRef.current = null;
      } finally {
        setLoadingOlder(false);
      }
    }
  }, [loadingOlder, state.hasOlder, session, newCount]);

  const jumpTo = (m) => {
    const el = listRef.current?.querySelector(`[data-id="${Number(m.id)}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setFound(Number(m.id));
      setTimeout(() => setFound(null), 2500);
    } else {
      notify(`${m.sender_nick} · ${new Date(Number(m.created_ts) * 1000).toLocaleString()}: ${String(m.content).slice(0, 200)}`, 'info', 9000);
    }
  };

  const send = async (e) => {
    e.preventDefault();
    const raw = input.trim();
    if (!raw || !session) return;
    setInput('');
    if (raw === '/help') return setShowHelp((v) => !v);
    if (raw.startsWith('/')) return onCommand(raw);
    const tempId = `tmp-${Date.now()}`;
    const reply = replyTo?.id && !String(replyTo.id).startsWith('tmp') ? Number(replyTo.id) : 0;
    setReplyTo(null);
    session.addPending({
      id: tempId,
      pending: true,
      user_id: me?.user_id,
      sender_nick: me?.display_nick,
      avatar_color: me?.avatar_color,
      avatar_preset: me?.avatar_preset,
      msg_type: 'CHAT',
      content: raw,
      reply_to: reply,
      created_ts: Math.floor(Date.now() / 1000),
    });
    try {
      await session.call('send_message', { content: raw, reply_to: reply });
      session.kick();
    } catch (err) {
      session.dropPending(tempId);
      setInput(raw);
      notify(err.message, 'error');
    }
  };

  const shareSnippet = async () => {
    try {
      const snippet = String(await invoke('extract_last_claude_snippet'));
      const preview = snippet.slice(0, 400);
      const more = snippet.length > 400 ? '\n…' : '';
      if (!(await confirmBox(t('chat.shareConfirm', { server: session.entry.name, preview: `${preview}${more}` })))) return;
      await session.call('send_message', { msg_type: 'SNIPPET', content: 'shared a Claude snippet', snippet_body: snippet });
      session.kick();
    } catch (err) {
      notify(String(err?.message || err), 'error');
    }
  };

  let lastDay = '';
  return (
    <div className="chat">
      {showSearch && session && <SearchPanel api={session.call} onJump={jumpTo} onClose={() => setShowSearch(false)} />}
      <div className="chat__list" ref={listRef} onScroll={onScroll}>
        {state.hasOlder ? (
          <div className="chat__older">{loadingOlder ? t('chat.loadingHistory') : t('chat.scrollOlder')}</div>
        ) : (
          <div className="chat__older">{t('chat.beginning')}</div>
        )}
        {state.server?.motd && (
          <div className="motd">
            <span className="motd__tag">{t('chat.pinned')}</span>
            {state.server.motd}
          </div>
        )}
        {messages.map((m) => {
          const d = dayOf(m);
          const sep =
            d && d !== lastDay ? (
              <div className="chat__day" key={`d-${d}`}>
                {d}
              </div>
            ) : null;
          if (d) lastDay = d;
          return (
            <Fragment key={m.id}>
              {sep}
              <Message
                m={m}
                quoted={m.reply_to ? byId.current.get(Number(m.reply_to)) : null}
                myId={me?.user_id}
                myNick={me?.display_nick}
                onReply={setReplyTo}
                onOpenSnippet={onOpenSnippet}
                highlighted={found === Number(m.id)}
              />
            </Fragment>
          );
        })}
        {showHelp && (
          <div className="help-card">
            {SLASH_HELP.map(([c, d]) => (
              <Fragment key={c}>
                <code>{c}</code>
                <span>{t(d)}</span>
              </Fragment>
            ))}
          </div>
        )}
      </div>
      {newCount > 0 && (
        <button type="button" className="chat__new" onClick={() => scrollToBottom(true)}>
          {t(newCount > 1 ? 'chat.newMany' : 'chat.newOne', { n: newCount })}
        </button>
      )}
      <form className="chat-composer" onSubmit={send}>
        {replyTo && (
          <div className="msg-quote chat-composer__reply">
            <span>{t('chat.replying', { nick: replyTo.sender_nick, text: String(replyTo.content).slice(0, 70) })}</span>
            <button type="button" className="msg-reply-btn" onClick={() => setReplyTo(null)}>
              ✕
            </button>
          </div>
        )}
        <div className="chat-composer__tools">
          <button type="button" className="deck-btn" onClick={() => setInput((v) => `${v}@claude `)}>
            🤖 @claude
          </button>
          <button type="button" className="deck-btn" onClick={shareSnippet}>
            {t('chat.shareSnippet')}
          </button>
          <button type="button" className={`deck-btn ${showSearch ? 'deck-btn--primary' : ''}`} onClick={() => setShowSearch((v) => !v)}>
            {t('chat.search')}
          </button>
          <button type="button" className="deck-btn" onClick={() => setShowHelp((v) => !v)}>
            /help
          </button>
        </div>
        <div className="chat-composer__row">
          <span className="chat-composer__prompt">❯</span>
          <input
            className="chat-composer__input"
            value={input}
            maxLength={2000}
            placeholder={state.me?.muted_until > Date.now() / 1000 ? t('chat.muted') : t('chat.placeholder')}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit" className="deck-btn deck-btn--primary">
            {t('chat.send')}
          </button>
        </div>
      </form>
    </div>
  );
}
