// Dialog for downloading a new model. Step 1: enter a Hugging Face repo id and
// look it up. Step 2: pick what to download — one of the repo's GGUF quant
// variants (llama.cpp), or the full repo (MLX safetensors). Active downloads
// show a live progress bar here; the actual download is run by useModels.

import React, { useState, useEffect } from 'react';
import Modal from './Modal';
import * as api from '../api/client';

const fmtBytes = (n) => {
  if (!n) return '';
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(n / 1024 ** 2).toFixed(0)} MB`;
};

// One row in the live downloads list.
function DownloadRow({ dlKey, dl, onDismiss, onCancel, onRestart }) {
  // Floor, never round: the backend caps in-flight progress at 99.9%, so
  // rounding would show 100% before the download is actually 'completed'.
  const pct = Math.floor(dl.progress || 0);
  const done = dl.status === 'completed';
  const errored = dl.status === 'error';
  const downloading = dl.status === 'downloading';
  const name = dlKey.split('/').slice(-1)[0];
  return (
    <div className="dl-row">
      <div className="dl-row-head">
        <span className="dl-row-name" title={dlKey}>{name}</span>
        <span className="dl-row-actions">
          {(downloading || errored) && (
            <button className="dl-row-action" onClick={() => onRestart(dlKey)} aria-label="Restart download" title="Restart download">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
          )}
          {downloading && (
            <button className="dl-row-action cancel" onClick={() => onCancel(dlKey)} aria-label="Cancel download" title="Cancel download">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
          {(done || errored) && (
            <button className="dl-row-dismiss" onClick={() => onDismiss(dlKey)} aria-label="Dismiss">×</button>
          )}
        </span>
      </div>
      {errored ? (
        <div className="dl-row-error">{dl.error_message || 'Download failed.'}</div>
      ) : (
        <>
          <div className="dl-progress">
            <div className="dl-progress-fill" style={{ width: `${done ? 100 : pct}%` }} />
          </div>
          <div className="dl-row-sub">
            {done ? 'Downloaded' : `${pct}%`}
            {dl.total_bytes ? ` · ${fmtBytes(dl.total_bytes)}` : ''}
          </div>
        </>
      )}
    </div>
  );
}

export default function AddModelModal({ open, prefill = '', onClose, onDownload, downloads = {}, onDismissDownload, onCancelDownload, onRestartDownload }) {
  const [repoInput, setRepoInput] = useState('');
  const [files, setFiles] = useState(null);   // { repo, is_mlx, gguf, mmproj }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Reset the lookup when the dialog is closed so it opens fresh next time.
  useEffect(() => {
    if (!open) {
      setRepoInput('');
      setFiles(null);
      setError('');
      setLoading(false);
    }
  }, [open]);

  // When opened from a recommended-model shortcut, drop its repo id into the
  // field ready to look up. (Opening from the plain "Add model…" passes no
  // prefill, leaving the reset above to clear it.)
  useEffect(() => {
    if (open && prefill) setRepoInput(prefill);
  }, [open, prefill]);

  const lookup = async () => {
    const repo = repoInput.trim();
    if (!repo) return;
    setLoading(true);
    setError('');
    setFiles(null);
    try {
      const data = await api.fetchRepoFiles(repo);
      setFiles(data);
    } catch (err) {
      setError(err.message || 'Could not read that repository.');
    } finally {
      setLoading(false);
    }
  };

  const download = (filename) => {
    if (files) onDownload(files.repo, filename);
  };

  const dlEntries = Object.entries(downloads);
  const hasFiles = files && (files.gguf?.length || files.is_mlx);

  return (
    <Modal title="Add Model" open={open} onClose={onClose} className="add-model-modal">
      <div className="add-model-body">
        <div className="settings-field">
          <label className="settings-label">Hugging Face Repo ID</label>
          <div className="add-model-row">
            <input
              className="add-model-input"
              type="text"
              placeholder="e.g.: unsloth/gemma-4-12B-it-qat-GGUF"
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && lookup()}
            />
            <button type="button" className="settings-action-btn" onClick={lookup} disabled={loading}>
              {loading ? 'Looking…' : 'Look up'}
            </button>
          </div>
          {error && <div className="add-model-error">{error}</div>}
        </div>

        {files && !hasFiles && !loading && (
          <div className="add-model-empty">No loadable model files found in this repository.</div>
        )}

        {hasFiles && (
          <div className="add-model-variants">
            {files.mmproj?.length > 0 && (
              <div className="add-model-note">
                Includes a vision projector (mmproj) — image input will be supported.
              </div>
            )}
            {files.gguf?.length > 0 && (
              <>
                <div className="settings-label">GGUF variants</div>
                {files.gguf.map((g) => (
                  <div className="variant-row" key={g.filename}>
                    <div className="variant-info">
                      <span className="variant-name">{g.filename}</span>
                      <span className="variant-size">{fmtBytes(g.size)}</span>
                    </div>
                    <button className="settings-action-btn" onClick={() => download(g.filename)}>
                      Download
                    </button>
                  </div>
                ))}
              </>
            )}
            {files.is_mlx && (
              <div className="variant-row">
                <div className="variant-info">
                  <span className="variant-name">Full repository (MLX)</span>
                  <span className="variant-size">{files.mlx_size ? fmtBytes(files.mlx_size) : 'safetensors'}</span>
                </div>
                <button className="settings-action-btn" onClick={() => download(undefined)}>
                  Download
                </button>
              </div>
            )}
          </div>
        )}

        {dlEntries.length > 0 && (
          <div className="add-model-downloads">
            <div className="settings-label">Downloads</div>
            {dlEntries.map(([key, dl]) => (
              <DownloadRow key={key} dlKey={key} dl={dl}
                onDismiss={onDismissDownload}
                onCancel={onCancelDownload}
                onRestart={onRestartDownload} />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
