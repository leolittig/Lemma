// The message input area: pending attachment chips, the thinking toggle, the
// attach button, the auto-growing textarea, and the send/stop button.
// All state lives in App (and the useAttachments hook); this only renders it.

import React, { useRef, useEffect } from 'react';
import ToggleSwitch from './ToggleSwitch';
import { adjustTextareaHeight } from '../lib/textarea';

export default function Composer({
  inputText,
  onInputChange,
  onSubmit,        // form submit handler (sends the message)
  onStop,          // aborts the in-flight response
  isResponding,
  supportsThinking,
  thinkingEnabled,
  onToggleThinking,
  attachments,     // from useAttachments
}) {
  const textareaRef = useRef(null);

  useEffect(() => {
    adjustTextareaHeight(textareaRef.current);
  }, [inputText]);

  // Enter sends; Shift+Enter inserts a newline.
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isResponding) return;
      const form = e.target.form;
      if (form) {
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      }
    }
  };

  return (
    <form onSubmit={onSubmit} className="composer">
      {attachments.pendingAttachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.pendingAttachments.map((a) => (
            <div key={a.id} className={`attachment-chip ${a.uploading ? 'uploading' : ''}`}>
              {a.kind === 'image' && a.previewUrl ? (
                <img className="chip-thumb" src={a.previewUrl} alt={a.filename} />
              ) : (
                <span className="chip-icon">{a.kind === 'audio' ? '♪' : '⎙'}</span>
              )}
              <span className="chip-name">{a.filename}</span>
              {a.uploading && <span className="chip-spinner" aria-label="Uploading" />}
              <button
                type="button"
                className="chip-remove"
                onClick={() => attachments.removeAttachment(a.id)}
                aria-label="Remove attachment"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-row">
        <input
          ref={attachments.fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,audio/*"
          multiple
          style={{ display: 'none' }}
          onChange={attachments.onFileSelect}
        />
        {supportsThinking && (
          <div className="thinking-toggle-container">
            <span className="thinking-toggle-label">Thinking</span>
            <ToggleSwitch on={thinkingEnabled} onToggle={onToggleThinking} label="thinking" />
          </div>
        )}
        <button type="button" className="attach-btn" onClick={attachments.openFilePicker} aria-label="Attach image or audio">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
          </svg>
        </button>
        <textarea
          ref={textareaRef}
          value={inputText}
          onChange={(e) => {
            onInputChange(e.target.value);
            adjustTextareaHeight(e.target);
          }}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <button
          type="button"
          onClick={isResponding ? onStop : onSubmit}
          aria-label={isResponding ? 'Stop generating' : 'Send message'}
        >
          {isResponding ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <rect x="6" y="6" width="12" height="12" rx="2.5"></rect>
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"></line>
              <polyline points="12 5 19 12 12 19"></polyline>
            </svg>
          )}
        </button>
      </div>
    </form>
  );
}
