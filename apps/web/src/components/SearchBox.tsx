import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';

/** Search box shown on every page. Milestone 4 adds reference parsing and direct-hit redirects. */
export function SearchBox() {
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (term) navigate(`/search?q=${encodeURIComponent(term)}`);
  };
  return (
    <form role="search" className="searchbox" onSubmit={submit}>
      <label htmlFor="global-search" className="visually-hidden">
        Search bills, notes, and RCW
      </label>
      <input
        id="global-search"
        type="search"
        name="q"
        placeholder="Bill number, RCW, or words (e.g. SHB 2402)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoComplete="off"
      />
      <button type="submit">Search</button>
    </form>
  );
}
