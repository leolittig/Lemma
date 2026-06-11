// iOS-style on/off switch, used for the composer's Thinking toggle and the
// settings modal's Smart context toggle. `label` feeds the accessibility
// strings ("Disable thinking", "thinking: on").

import React from 'react';

export default function ToggleSwitch({ on, onToggle, label }) {
  return (
    <button
      type="button"
      className={`thinking-switch ${on ? 'on' : 'off'}`}
      onClick={onToggle}
      aria-label={`${on ? 'Disable' : 'Enable'} ${label}`}
      aria-pressed={on}
      title={`${label}: ${on ? 'on' : 'off'}`}
    >
      <div className="thinking-switch-handle" />
    </button>
  );
}
