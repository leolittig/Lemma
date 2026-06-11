// Shared dialog shell: dimmed overlay, white card, title row with a close
// button. Used by SettingsModal and AddModelModal; pass the dialog body as
// children.
//
// The overlay closes only when both mousedown AND mouseup happen on it, so a
// drag that starts inside the card and ends outside doesn't dismiss it.

import React, { useRef } from 'react';

export default function Modal({ title, open, onClose, children }) {
  const mouseDownOnOverlayRef = useRef(false);

  const handleMouseDown = (e) => {
    mouseDownOnOverlayRef.current = (e.target === e.currentTarget);
  };

  const handleMouseUp = (e) => {
    if (e.target === e.currentTarget && mouseDownOnOverlayRef.current) {
      onClose();
    }
  };

  return (
    <div
      className={`settings-overlay ${open ? 'visible' : ''}`}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
    >
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h3 className="settings-title">{title}</h3>
          <button className="close-btn" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
