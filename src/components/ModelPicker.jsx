// The model selector in the top bar: the current model's name, a dropdown of
// locally available models, live progress for in-flight downloads, and the
// "+" button that opens the Add Model dialog.
//
// The open/closed state is controlled by App (it also needs to open the
// dropdown after a download starts); this component handles the click-outside
// dismissal itself.

import React, { useRef, useEffect } from 'react';
import { renderModelName } from '../lib/modelName';

export default function ModelPicker({
  open,
  onToggle,          // toggle button clicked (App refreshes the list on open)
  onClose,           // dismissed by clicking outside
  modelName,
  availableModels,
  downloads,
  isChangingModel,
  onSelectModel,
  onDismissDownload, // remove a failed download from the list
  onAddModel,        // open the Add Model dialog
}) {
  const wrapperRef = useRef(null);

  // Close the dropdown when clicking anywhere outside it.
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        onClose();
      }
    };
    if (open) {
      document.addEventListener('click', handleClickOutside);
    }
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [open, onClose]);

  return (
    <div className="model-selector-wrapper" ref={wrapperRef}>
      <button
        className={`model-picker-toggle ${open ? 'active' : ''}`}
        onClick={onToggle}
        aria-label="Select model"
        disabled={isChangingModel}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="chevron-icon">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
      <span className="model-title-container">
        <span className="model-title">{renderModelName(modelName)}</span>
        <span className="model-tooltip">{modelName}</span>
      </span>
      {open && (
        <div className="model-picker-dropdown">
          {availableModels.map((m) => (
            <button
              key={m}
              className={`model-picker-item ${m === modelName ? 'selected' : ''}`}
              onClick={() => onSelectModel(m)}
            >
              <span className="model-item-full">{m}</span>
              {m === modelName && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="check-icon">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              )}
            </button>
          ))}

          {/* Active or failed downloads (completed ones appear in the list above). */}
          {Object.entries(downloads).map(([repo, dl]) => {
            if (dl.status === 'completed' || availableModels.includes(repo)) {
              return null;
            }
            return (
              <div key={repo} className="model-picker-download-item">
                <div className="model-download-info">
                  <span className="model-item-full" title={repo}>{repo}</span>
                  {dl.status === 'downloading' && (
                    <span className="model-download-percent">{dl.progress}%</span>
                  )}
                </div>
                {dl.status === 'downloading' && (
                  <div className="model-download-progress-bg">
                    <div className="model-download-progress-bar" style={{ width: `${dl.progress}%` }}></div>
                  </div>
                )}
                {dl.status === 'error' && (
                  <div className="model-download-error">
                    <span>Error: {dl.error_message}</span>
                    <button
                      className="model-download-dismiss-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDismissDownload(repo);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          <button
            className="model-picker-add-btn"
            onClick={onAddModel}
            aria-label="Add Model"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
