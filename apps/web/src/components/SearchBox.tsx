import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { isBareReference, parse, urlFor } from '@wa-leg/billref';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

const CURRENT_BIENNIUM = '2025-26';

interface Suggestion {
  kind: string;
  bill_key?: string;
  display?: string;
  label?: string;
  title?: string;
  status?: string;
  url?: string;
  note_id?: string;
}

/** Search box on every page: parses references locally and redirects on an exact bare reference (search.md 4.1). */
export function SearchBox() {
  const [q, setQ] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const navigate = useNavigate();
  const { principal } = useSession();
  const listId = useId();
  const timer = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!principal || q.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try {
        const res = await api<{ suggestions: Suggestion[] }>('/search/suggest', { query: { q: q.trim(), biennium: CURRENT_BIENNIUM, size: 8 } });
        setSuggestions(res.suggestions);
        setOpen(true);
        setActive(-1);
      } catch {
        setSuggestions([]);
      }
    }, 180);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [q, principal]);

  const go = async (term: string) => {
    const t = term.trim();
    if (!t) return;
    setOpen(false);
    const opts = { currentBiennium: CURRENT_BIENNIUM };
    const p = parse(t, opts);
    if (p.ref && isBareReference(t, opts) && p.ref.kind === 'bill' && p.ref.confidence === 'exact') {
      // Confirm with the resolver so a missing bill lands on results rather than an empty page.
      try {
        const r = await api<{ resolved: { url: string } | null }>('/bills/resolve', { query: { ref: t, biennium: CURRENT_BIENNIUM } });
        if (r.resolved?.url) {
          navigate(r.resolved.url);
          return;
        }
      } catch {
        /* fall through to results */
      }
    } else if (p.ref && isBareReference(t, opts) && p.ref.kind === 'amendment' && p.ref.drafterNumber) {
      try {
        const r = await api<{ resolved: { url: string } | null }>('/bills/resolve', { query: { ref: t, biennium: CURRENT_BIENNIUM } });
        if (r.resolved?.url) {
          navigate(r.resolved.url);
          return;
        }
      } catch {
        /* fall through */
      }
    } else if (p.ref && isBareReference(t, opts) && (p.ref.kind === 'rcw' || p.ref.kind === 'fiscal_note_package' || p.ref.kind === 'initiative' || p.ref.kind === 'session_law')) {
      // External references open in the results page with the direct card and any bills that touch them.
      const ext = urlFor(p.ref);
      void ext;
    }
    navigate(`/search?q=${encodeURIComponent(t)}`);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (active >= 0 && suggestions[active]?.url) {
      navigate(suggestions[active]!.url!);
      setOpen(false);
      return;
    }
    void go(q);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, -1));
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <form role="search" className="searchbox" onSubmit={submit} autoComplete="off">
      <label htmlFor="global-search" className="visually-hidden">
        Search bills, notes, and RCW
      </label>
      <div className="search-wrap">
        <input
          id="global-search"
          ref={inputRef}
          type="search"
          name="q"
          placeholder="Bill number, RCW, or words (e.g. SHB 2402)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => suggestions.length && setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          role="combobox"
          aria-expanded={open && suggestions.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        />
        {open && suggestions.length > 0 && (
          <ul id={listId} role="listbox" className="suggest" aria-label="Suggestions">
            {suggestions.map((s, i) => (
              <li key={`${s.bill_key ?? s.note_id ?? i}`} id={`${listId}-${i}`} role="option" aria-selected={i === active} className={i === active ? 'active' : ''} onMouseDown={() => s.url && navigate(s.url)}>
                <span className="sug-kind">{s.kind === 'fiscal_note' ? 'Note' : 'Bill'}</span>
                <span className="sug-display">{s.label ?? s.display}</span>
                {s.title && <span className="sug-title"> {s.title}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button type="submit">Search</button>
    </form>
  );
}
