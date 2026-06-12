// Full-screen overlay with a spinner, shown while the backend is swapping
// models (unloading the old one and loading the new one into memory).

import React from 'react';

export default function ModelLoadingOverlay() {
  return (
    <div className="model-loading-overlay">
      <div className="model-loading-spinner"></div>
      <div className="model-loading-text">Loading Model...</div>
    </div>
  );
}
