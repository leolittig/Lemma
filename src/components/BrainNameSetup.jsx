// First-boot (and post-reset) prompt for the brain: asks only for the user's
// name, then creates the single root node. Shown when the brain is enabled but
// not yet initialized.

import React, { useState } from 'react';
import * as api from '../api/client';

export default function BrainNameSetup({ brainMode, onDone }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.initBrain(brainMode, clean);
      onDone(clean);
    } catch (err) {
      setError('Could not set up the brain. Please try again.');
      setBusy(false);
    }
  };

  return (
    <div className="brain-setup-overlay">
      <form className="brain-setup-inner" onSubmit={submit}>
        <h1 className="brain-setup-title">What's your name?</h1>
        <input
          className="brain-setup-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Type your name"
          autoFocus
          maxLength={40}
        />
        {error && <div className="brain-setup-error">{error}</div>}
        <button className="brain-setup-btn" type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create brain'}
        </button>
      </form>
    </div>
  );
}
