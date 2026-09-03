import { useEffect, useRef, useState } from 'react';
import katex from 'katex';

/** Formula popover: a MathLive field (loaded on first use) with a LaTeX source view. Enter inserts, Escape cancels. */
export function MathDialog({ initial, kind, onKindChange, onInsert, onClose }: { initial: string; kind: 'inline' | 'block'; onKindChange: (k: 'inline' | 'block') => void; onInsert: (latex: string) => void; onClose: () => void }) {
  const [latex, setLatex] = useState(initial);
  const [source, setSource] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previous = useRef<Element | null>(null);

  useEffect(() => {
    previous.current = document.activeElement;
    let cancelled = false;
    import('mathlive')
      .then((m) => {
        if (cancelled) return;
        const MF = m.MathfieldElement as unknown as { fontsDirectory: string | null; soundsDirectory: string | null };
        MF.fontsDirectory = null;
        MF.soundsDirectory = null;
        setReady(true);
      })
      .catch(() => setSource(true));
    return () => {
      cancelled = true;
      (previous.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  useEffect(() => {
    if (!ready || source) return;
    const el = fieldRef.current as (HTMLElement & { value: string }) | null;
    if (!el) return;
    el.value = latex;
    const onInput = () => setLatex(el.value);
    el.addEventListener('input', onInput);
    el.focus();
    return () => el.removeEventListener('input', onInput);
  }, [ready, source]);

  const validate = (): boolean => {
    try {
      katex.renderToString(latex, { throwOnError: true });
      setError(null);
      return true;
    } catch (err) {
      setError((err as Error).message.replace(/^KaTeX parse error: /, ''));
      return false;
    }
  };

  const submit = () => {
    if (!latex.trim()) {
      setError('Enter a formula');
      return;
    }
    if (validate()) onInsert(latex);
  };

  const preview = (() => {
    try {
      return katex.renderToString(latex || '\\text{formula}', { throwOnError: false, displayMode: kind === 'block' });
    } catch {
      return '';
    }
  })();

  return (
    <div
      className="math-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="math-dialog-h"
      ref={dialogRef}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        } else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement && e.shiftKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <h2 id="math-dialog-h">Formula</h2>
      {!source && ready ? (
        <math-field ref={fieldRef as never} aria-label="Formula, math input" class="math-field" math-virtual-keyboard-policy="manual" />
      ) : (
        <label>
          LaTeX source
          <textarea value={latex} onChange={(e) => setLatex(e.target.value)} rows={3} autoFocus aria-describedby="math-help" />
        </label>
      )}
      <p id="math-help" className="muted small">
        {source ? 'Type LaTeX; the preview updates as you type.' : 'Type the formula; use the LaTeX source view for exact control.'}
      </p>
      <div className="math-preview" aria-label="Preview" dangerouslySetInnerHTML={{ __html: preview }} />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="row">
        <label className="inline">
          <input type="checkbox" checked={source} onChange={(e) => setSource(e.target.checked)} /> Edit as LaTeX
        </label>
        <label className="inline">
          <input type="checkbox" checked={kind === 'block'} onChange={(e) => onKindChange(e.target.checked ? 'block' : 'inline')} /> Display on its own line
        </label>
        <span className="spacer" />
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" onClick={submit}>
          Insert
        </button>
      </div>
    </div>
  );
}
