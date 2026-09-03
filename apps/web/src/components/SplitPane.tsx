import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

interface Props {
  left: ReactNode;
  right: ReactNode;
  /** Label for the collapsed left rail. */
  railLabel: string;
  storageKey?: string;
  collapsed: boolean;
  onCollapsedChange: (c: boolean) => void;
  /** Tab labels used when the viewport is too narrow for two panes. */
  tabs?: [string, string];
}

const MIN = 20;
const MAX = 80;

export function SplitPane({ left, right, railLabel, storageKey = 'split.pos', collapsed, onCollapsedChange, tabs = ['Bill', 'Note'] }: Props) {
  const [pos, setPos] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(storageKey));
      return v >= MIN && v <= MAX ? v : 50;
    } catch {
      return 50;
    }
  });
  const [tab, setTab] = useState<0 | 1>(0);
  const [narrow, setNarrow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 63.99em)');
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(pos));
    } catch {
      /* ignore */
    }
  }, [pos, storageKey]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!dragging.current || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setPos(Math.min(MAX, Math.max(MIN, pct)));
  }, []);
  const stop = useCallback(() => {
    dragging.current = false;
    document.body.classList.remove('dragging');
  }, []);
  useEffect(() => {
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', stop);
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', stop);
    };
  }, [onPointerMove, stop]);

  if (narrow) {
    return (
      <div className="split narrow" ref={ref}>
        <div className="tabs" role="tablist" aria-label="Panes">
          {tabs.map((t, i) => (
            <button key={t} type="button" role="tab" aria-selected={tab === i} id={`pane-tab-${i}`} aria-controls={`pane-${i}`} onClick={() => setTab(i as 0 | 1)}>
              {t}
            </button>
          ))}
        </div>
        <div id="pane-0" role="tabpanel" aria-labelledby="pane-tab-0" hidden={tab !== 0} className="pane pane-left">
          {left}
        </div>
        <div id="pane-1" role="tabpanel" aria-labelledby="pane-tab-1" hidden={tab !== 1} className="pane pane-right">
          {right}
        </div>
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="split collapsed" ref={ref}>
        <div className="rail">
          <button type="button" className="rail-btn" onClick={() => onCollapsedChange(false)} aria-label={`Expand the ${railLabel} pane`} title="Expand">
            <span className="rail-label">{railLabel}</span>
            <span aria-hidden="true">▸</span>
          </button>
        </div>
        <div className="pane pane-right">{right}</div>
      </div>
    );
  }

  return (
    <div className="split" ref={ref} style={{ gridTemplateColumns: `${pos}% 0.6rem minmax(0, 1fr)`, position: 'relative' }}>
      <div className="pane pane-left">{left}</div>
      <div
        className="splitter"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(pos)}
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-label="Resize panes (arrow keys resize, Home collapses the bill pane, End widens it)"
        tabIndex={0}
        onPointerDown={(e) => {
          dragging.current = true;
          document.body.classList.add('dragging');
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setPos((p) => Math.max(MIN, p - 2));
          else if (e.key === 'ArrowRight') setPos((p) => Math.min(MAX, p + 2));
          else if (e.key === 'Home') onCollapsedChange(true);
          else if (e.key === 'End') setPos(MAX);
          else return;
          e.preventDefault();
        }}
        onDoubleClick={() => setPos(50)}
      />
      <button type="button" className="splitter-collapse" style={{ left: `calc(${pos}% + 0.3rem)` }} onClick={() => onCollapsedChange(true)} aria-label={`Collapse the ${railLabel} pane`} title="Collapse">
        ◂
      </button>
      <div className="pane pane-right">{right}</div>
    </div>
  );
}
