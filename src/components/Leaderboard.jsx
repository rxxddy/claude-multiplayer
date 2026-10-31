import { useCallback, useEffect, useRef, useState } from 'react';
import { OperatorCard } from './OperatorCard';
import { useT } from '../i18n';

const FILTERS = [
  ['', 'board.all'],
  ['online', 'board.online'],
  ['owner', 'board.owner'],
  ['admin', 'board.admins'],
];
const PAGE = 48;

/**
 * Server-paginated leaderboard. Refetches the loaded pages only when the server's members_rev changes,
 * so thousands of members cost one small request per change instead of a full list every sync.
 */
export default function Leaderboard({ session, membersRev, me, onOpen }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);
  const pageBusy = useRef(false);
  const lastRevLoad = useRef(0);
  const query = (filter || q.trim()).trim();

  const load = useCallback(
    async (pageCount) => {
      if (!session) return;
      const id = ++reqId.current;
      setLoading(true);
      try {
        const all = [];
        let tot = 0;
        for (let p = 1; p <= pageCount; p++) {
          const r = await session.call('members', { q: query || undefined, page: p, limit: PAGE });
          tot = r.total || 0;
          all.push(...(r.items || []));
          if ((r.items || []).length < PAGE) break;
        }
        if (id === reqId.current) {
          setItems(all);
          setTotal(tot);
        }
      } catch {
        /* keep previous list on transient errors */
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [session, query]
  );

  // debounce typing; reset paging on new query
  useEffect(() => {
    const timer = setTimeout(() => {
      setPages(1);
      load(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, load]);

  // members_rev changes often on busy servers: refresh at most every 5s, and only the first visible pages
  useEffect(() => {
    if (!membersRev) return undefined;
    const wait = Math.max(0, 5000 - (Date.now() - lastRevLoad.current));
    const timer = setTimeout(() => {
      lastRevLoad.current = Date.now();
      load(Math.min(pages, 3));
    }, wait);
    return () => clearTimeout(timer);
  }, [membersRev]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = (e) => {
    const el = e.currentTarget;
    if (!loading && !pageBusy.current && items.length < total && el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      const next = pages + 1;
      const id = reqId.current;
      pageBusy.current = true;
      setPages(next);
      session
        .call('members', { q: query || undefined, page: next, limit: PAGE })
        .finally(() => {
          pageBusy.current = false;
        })
        .then((r) => {
          if (id !== reqId.current) return;
          setItems((prev) => {
            const seen = new Set(prev.map((x) => x.user_id));
            return [...prev, ...(r.items || []).filter((x) => !seen.has(x.user_id))];
          });
        });
    }
  };

  return (
    <div className="lb">
      <div className="section-header">
        <span>{t('board.title', { n: total.toLocaleString() })}</span>
        <span className="tabular">{t('board.showdown')}</span>
      </div>
      <div className="lb__tools">
        <input
          className="deck-input"
          placeholder={t('board.search')}
          value={q}
          onChange={(e) => {
            setFilter('');
            setQ(e.target.value);
          }}
        />
        <div className="lb__filters">
          {FILTERS.map(([v, l]) => (
            <button
              key={l}
              type="button"
              className={`chip ${filter === v && (v || !q) ? 'chip--on' : ''}`}
              onClick={() => {
                setQ('');
                setFilter(v);
              }}
            >
              {t(l)}
            </button>
          ))}
        </div>
      </div>
      <div className="operators-grid operators-grid--scroll" onScroll={onScroll}>
        {items.map((op) => (
          <OperatorCard key={op.user_id} op={op} isMe={Number(op.user_id) === Number(me?.user_id)} onOpen={onOpen} />
        ))}
        {!loading && items.length === 0 && <div className="arcade-dim">{t('board.noMatch')}</div>}
        {loading && items.length === 0 && <div className="arcade-dim">{t('board.loading')}</div>}
      </div>
    </div>
  );
}
