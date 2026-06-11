// Collapsible panel for brain activity on assistant messages. Shows which
// brain files were read, written, or deleted during the response, plus the
// routing reasoning. Modelled after ThinkingBlock.jsx.

import React, { useState } from 'react';

export default function BrainActivityBlock({ activity }) {
  const [open, setOpen] = useState(false);

  if (!activity) return null;

  const { routing_reasoning: reasoning, files_read, files_written, files_deleted } = activity;
  const hasContent = reasoning || files_read?.length || files_written?.length || files_deleted?.length;
  if (!hasContent) return null;

  return (
    <div className={`brain-activity-block ${open ? 'open' : ''}`}>
      <button
        type="button"
        id="brain-activity-toggle"
        className="brain-activity-toggle-row"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="brain-activity-icon" aria-hidden="true">🧠</span>
        <span className="brain-activity-label">Brain Activity</span>
        <svg className="brain-activity-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </button>
      {open && (
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
                  <span key={i} className="brain-chip brain-chip-read">{f}</span>
                ))}
              </div>
            </div>
          )}
          {files_written?.length > 0 && (
            <div className="brain-activity-files">
              <span className="brain-activity-section-label">Written</span>
              <div className="brain-activity-chips">
                {files_written.map((f, i) => (
                  <span key={i} className="brain-chip brain-chip-written">{f}</span>
                ))}
              </div>
            </div>
          )}
          {files_deleted?.length > 0 && (
            <div className="brain-activity-files">
              <span className="brain-activity-section-label">Deleted</span>
              <div className="brain-activity-chips">
                {files_deleted.map((f, i) => (
                  <span key={i} className="brain-chip brain-chip-deleted">{f}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
