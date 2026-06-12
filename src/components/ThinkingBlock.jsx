// Collapsible panel for a reasoning model's thinking phase, shown above the
// final answer. Starts collapsed; while the model is still mid-reasoning the
// label pulses ("Thinking…"). Opening it releases the auto-scroll lock (via
// onToggle) so the view doesn't yank back down while the user reads.

import React, { useState } from 'react';
import { marked } from '../lib/markdown';

export default function ThinkingBlock({ thinking, streaming, onToggle }) {
  const [open, setOpen] = useState(false);

  const hasText = thinking.trim().length > 0;
  return (
    <div className={`thinking-block ${open ? 'open' : ''} ${streaming ? 'thinking-live' : ''}`}>
      <button
        type="button"
        className="thinking-toggle-row"
        onClick={() => {
          const nextOpen = !open;
          setOpen(nextOpen);
          if (nextOpen && onToggle) {
            onToggle();
          }
        }}
      >
        <svg className="thinking-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
        <span className="thinking-label">{streaming ? 'Thinking…' : 'Thoughts'}</span>
      </button>
      {open && hasText && (
        <div
          className="thinking-content"
          dangerouslySetInnerHTML={{ __html: marked.parse(thinking) }}
        />
      )}
    </div>
  );
}
