// The Assistant entity view: persona, tone, and the user's response
// preferences. A simple markdown editor over Assistant.md (not a graph node).

import React, { useState, useEffect, useRef } from 'react';
import * as api from '../api/client';
import { marked } from '../lib/markdown';

export default function BrainAssistant({ brainMode }) {
  const [content, setContent] = useState('');
  const [tab, setTab] = useState('preview');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const serverRef = useRef('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.fetchBrainFile(brainMode, 'Assistant')
      .then((d) => {
        if (cancelled) return;
        setContent(d.content || '');
        serverRef.current = d.content || '';
        setLoading(false);
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [brainMode]);

  const save = async () => {
    setSaving(true);
    try {
      await api.saveBrainFile(brainMode, 'Assistant', content);
      serverRef.current = content;
    } catch (err) {
      alert('Could not save. Keep the --- frontmatter block (created/updated/type) intact.');
    } finally {
      setSaving(false);
    }
  };

  const dirty = content !== serverRef.current;

  if (loading) {
    return <div className="brain-view-pane"><div className="brain-view-empty">Loading assistant…</div></div>;
  }

  return (
    <div className="brain-view-pane brain-assistant-pane">
      <div className="brain-assistant-head">
        <h2 className="brain-view-title">Assistant</h2>
        <p className="brain-view-sub">How I should respond — persona, tone, and your preferences (timezone, units, style).</p>
      </div>
      <div className="brain-editor-tabs">
        <button className={`brain-editor-tab-btn ${tab === 'preview' ? 'active' : ''}`} onClick={() => setTab('preview')}>Preview</button>
        <button className={`brain-editor-tab-btn ${tab === 'edit' ? 'active' : ''}`} onClick={() => setTab('edit')}>Edit</button>
      </div>
      {tab === 'preview' ? (
        <div
          className="brain-assistant-content brain-editor-preview markdown-body"
          dangerouslySetInnerHTML={{ __html: marked.parse(content || '*No content*') }}
        />
      ) : (
        <textarea
          className="brain-assistant-content brain-assistant-textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      )}
      <div className="brain-editor-actions">
        <button className="brain-editor-save-btn" onClick={save} disabled={saving || !dirty}>
          Save
        </button>
      </div>
    </div>
  );
}
