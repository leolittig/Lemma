// Full-screen overlay with a spinner, shown while the backend is swapping
// models (unloading the old one and loading the new one into memory). Load
// time isn't reliably measurable, so this is a spinner rather than a bar.

import React from 'react';

export default function ModelLoadingOverlay({ isUnloading }) {
  return (
    <div className="model-loading-overlay">
      <div className="model-loading-spinner"></div>
      <div className="model-loading-text">{isUnloading ? 'Unloading model…' : 'Loading model…'}</div>
    </div>
  );
}
