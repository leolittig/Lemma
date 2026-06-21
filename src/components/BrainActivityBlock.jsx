// Collapsible panel for brain activity on assistant messages. Shows which
// brain files were read, written, or deleted during the response, plus the
// routing reasoning. Modelled after ThinkingBlock.jsx.

import React, { useState, useEffect, useRef } from 'react';
import { Brain } from 'lucide-react';

// Memory file names use underscores for spaces; show them as spaces to the user.
const label = (name) => String(name).replace(/_/g, ' ');

export default function BrainActivityBlock({ activity, liveFiles = [], live = false }) {
  const [open, setOpen] = useState(false);

  // Live tags revealed as routing decides each file. They're driven by the
  // WebSocket feed (liveFiles) and kept mounted for one beat after the turn
  // ends so they can fade out instead of vanishing.
  const [chips, setChips] = useState([]);
  const [exiting, setExiting] = useState(false);
  const exitTimer = useRef(null);

  useEffect(() => {
    if (live && liveFiles.length > 0) {
      if (exitTimer.current) { clearTimeout(exitTimer.current); exitTimer.current = null; }
      setExiting(false);
      setChips(liveFiles);
    } else if (chips.length > 0 && !exiting) {
      // Turn ended: fade the chips out, then unmount them.
      setExiting(true);
      exitTimer.current = setTimeout(() => {
        setChips([]);
        setExiting(false);
        exitTimer.current = null;
      }, 450);
    }
    // liveFiles identity changes each render; compare by contents.
  }, [live, liveFiles.join('')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (exitTimer.current) clearTimeout(exitTimer.current); }, []);

  const liveChipsEl = chips.length > 0 ? (
    <span className={`brain-activity-live-chips${exiting ? ' exiting' : ''}`} aria-hidden="true">
      {chips.map((f, i) => (
        <span key={f + i} className="brain-chip brain-chip-read">{label(f)}</span>
      ))}
    </span>
  ) : null;

  const { routing_reasoning: reasoning, files_read, files_written, files_deleted } = activity || {};
  const hasFiles = !!(files_read?.length || files_written?.length || files_deleted?.length);

  // Only render when memory was actually used — no speculative icon.
  if (!hasFiles && !liveChipsEl) return null;

  // One structure for both the live (tags only, no panel yet) and final
  // (expandable) states, so the icon is the same node throughout and fades in
  // once instead of re-mounting when the header arrives.
  return (
    <div className={`brain-activity-block ${open && hasFiles ? 'open' : ''}`}>
      <button
        type="button"
        id="brain-activity-toggle"
        className={`brain-activity-toggle-row${hasFiles ? '' : ' brain-activity-status-row'}`}
        onClick={hasFiles ? () => setOpen((v) => !v) : undefined}
      >
        <Brain className="brain-activity-icon" size={20} strokeWidth={2} aria-label="Brain Activity" />
        {liveChipsEl}
      </button>
      {open && hasFiles && (
        <div className="brain-activity-content">
          {reasoning && (
            <div className="brain-activity-reasoning">
              <span className="brain-activity-section-label">Routing</span>
              <p className="brain-activity-reasoning-text">{reasoning}</p>
            </div>
          )}
          {files_read?.length > 0 && (
            <div className="brain-activity-files">
              <span className="brain-activity-section-label">Read</span>
              <div className="brain-activity-chips">
                {files_read.map((f, i) => (
                  <span key={i} className="brain-chip brain-chip-read">{label(f)}</span>
                ))}
              </div>
            </div>
          )}
          {files_written?.length > 0 && (
            <div className="brain-activity-files">
              <span className="brain-activity-section-label">Written</span>
              <div className="brain-activity-chips">
                {files_written.map((f, i) => (
                  <span key={i} className="brain-chip brain-chip-written">{label(f)}</span>
                ))}
              </div>
            </div>
          )}
          {files_deleted?.length > 0 && (
            <div className="brain-activity-files">
              <span className="brain-activity-section-label">Deleted</span>
              <div className="brain-activity-chips">
                {files_deleted.map((f, i) => (
                  <span key={i} className="brain-chip brain-chip-deleted">{label(f)}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
