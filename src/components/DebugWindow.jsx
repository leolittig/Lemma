// A floating, draggable, resizable window that shows every token the model
// sees (input prompt) and produces (output), grouped by phase: routing, chat
// (incl. the thinking process), post-processing, and title. Driven by
// useDebugLog. Opened via the Debug toggle in settings.

import React, { useRef, useState, useEffect } from 'react';

const PHASE_LABELS = {
  routing: 'Routing (memory query)',
  chat: 'Chat reply (thinking + answer)',
  'post-processing': 'Post-processing (memory write)',
  title: 'Title generation',
  brain: 'Brain',
};

export default function DebugWindow({ entries, onClear, onClose }) {
  const [pos, setPos] = useState({ x: Math.max(20, window.innerWidth - 480), y: 80 });
  const [autoScroll, setAutoScroll] = useState(true);
  const bodyRef = useRef(null);

  // Drag from the header.
  const onHeaderMouseDown = (e) => {
    if (e.target.closest('button')) return; // don't drag when hitting a button
    e.preventDefault();
    const start = { mx: e.clientX, my: e.clientY, x: pos.x, y: pos.y };
    const onMove = (ev) => {
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - 120, start.x + ev.clientX - start.mx)),
        y: Math.max(0, Math.min(window.innerHeight - 40, start.y + ev.clientY - start.my)),
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Keep pinned to the bottom as new tokens stream, unless the user scrolled up.
  useEffect(() => {
    if (autoScroll && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const onBodyScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAutoScroll(atBottom);
  };

  return (
    <div className="debug-window" style={{ left: pos.x, top: pos.y }}>
      <div className="debug-window-header" onMouseDown={onHeaderMouseDown}>
        <span className="debug-window-title">Model Debug — input &amp; output tokens</span>
        <div className="debug-window-actions">
          <button className="debug-window-btn" onClick={onClear} title="Clear">Clear</button>
          <button className="debug-window-btn" onClick={onClose} title="Close" aria-label="Close debug window">×</button>
        </div>
      </div>
      <div className="debug-window-body" ref={bodyRef} onScroll={onBodyScroll}>
        {entries.length === 0 ? (
          <div className="debug-window-empty">Waiting for model activity… send a message.</div>
        ) : (
          entries.map((e) => (
            <div key={e.id} className={`debug-entry debug-phase-${e.phase}`}>
              <div className="debug-entry-head">
                <span className="debug-entry-phase">{PHASE_LABELS[e.phase] || e.phase}</span>
                <span className="debug-entry-status">{e.done ? 'done' : 'streaming…'}</span>
              </div>
              {e.input && (
                <>
                  <div className="debug-entry-label">INPUT</div>
                  <pre className="debug-entry-text debug-entry-input">{e.input}</pre>
                </>
              )}
              {(e.output || !e.done) && (
                <>
                  <div className="debug-entry-label">OUTPUT</div>
                  <pre className="debug-entry-text debug-entry-output">{e.output}</pre>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
