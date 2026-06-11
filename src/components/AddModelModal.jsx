// Dialog for downloading a new model: enter a Hugging Face repo id and hit
// Download. The actual download (and its progress display in the model
// picker) is handled by useModels; this dialog only collects the repo id.

import React, { useState } from 'react';
import Modal from './Modal';

export default function AddModelModal({ open, onClose, onDownload }) {
  const [repoInput, setRepoInput] = useState('');

  // onDownload returns true when a download actually started (the input
  // sanitized to a non-empty repo id); only then is the field cleared.
  const submit = () => {
    if (onDownload(repoInput)) {
      setRepoInput('');
    }
  };

  return (
    <Modal title="Add Model" open={open} onClose={onClose}>
      <div className="add-model-body">
        <div className="settings-field">
          <label className="settings-label">Hugging Face Repo ID</label>
          <div className="add-model-row">
            <input
              className="add-model-input"
              type="text"
              placeholder="e.g.: mlx-community/model"
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            <button type="button" className="settings-action-btn" onClick={submit}>
              Download
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
