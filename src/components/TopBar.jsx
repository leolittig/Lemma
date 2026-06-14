// The app bar: sidebar toggle and New Chat on the left, the model picker in
// the center, the settings gear on the right.

import React from 'react';
import ModelPicker from './ModelPicker';
import lemmaLogo from '../assets/LemmaLogo.png';

export default function TopBar({
  sidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  onOpenSettings,
  onToggleBrainExplorer,
  showBrainExplorer,
  brainProcessing, // true while the memory model is updating the brain
  modelPickerProps, // forwarded to ModelPicker (see App.jsx)
}) {
  return (
    <header className="top-bar">
      <div className="topbar-left">
        <button
          className="topbar-icon-btn"
          onClick={onToggleSidebar}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={sidebarCollapsed ? 'Expand' : 'Collapse'}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2"></rect>
            <line x1="9" y1="4" x2="9" y2="20"></line>
          </svg>
        </button>
        <button
          className={`topbar-new-btn ${sidebarCollapsed ? 'collapsed' : ''}`}
          onClick={onNewChat}
          aria-label="New chat"
          title="New chat"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          <span className="topbar-new-label">New chat</span>
        </button>
        <img src={lemmaLogo} className="topbar-logo" alt="LEMMA" />
      </div>
      <ModelPicker {...modelPickerProps} />
      {onToggleBrainExplorer && (
        <div className="brain-toolbar-cluster">
          {brainProcessing && (
            <span
              className="brain-updating-spinner"
              role="status"
              aria-label="Updating memory"
              title="Updating memory…"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10"></polyline>
                <polyline points="1 20 1 14 7 14"></polyline>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
              </svg>
            </span>
          )}
          <button
            id="brain-toggle-btn"
            className={`brain-toggle-btn${showBrainExplorer ? ' active' : ''}`}
            onClick={onToggleBrainExplorer}
            aria-label={showBrainExplorer ? 'Close brain explorer' : 'Open brain explorer'}
            title="Brain Explorer"
          >
            Brain
          </button>
        </div>
      )}
      <button className="settings-btn" onClick={onOpenSettings} aria-label="Open settings">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      </button>
    </header>
  );
}
