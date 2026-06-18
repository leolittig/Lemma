import React, { useState, useRef, useEffect } from 'react';

// Pretty label for an option: "<name>  ·  MLX" plus an "(unavailable)" hint for
// models whose engine isn't installed on this machine.
const optionText = (m) => {
  const tag = (m.format || '').toUpperCase();
  const base = tag ? `${tag}  ·  ${m.label}` : m.label;
  return m.compatible === false ? `${base} (unavailable)` : base;
};

export default function ModelPicker({
  modelName,
  availableModels = [],
  isChangingModel,
  onSelectModel,
  onAddModel,
  onDeleteModel,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (id) => {
    if (id !== modelName) {
      onSelectModel(id);
    }
    setIsOpen(false);
  };

  const handleDelete = (e, m) => {
    e.stopPropagation();
    if (onDeleteModel) {
      // The prompt is handled inside onDeleteModel in App.jsx, but the user requested:
      // "prompt the user if theyre sure"
      // Since App.jsx already prompts, it's safe to just call it. But to be safe, I'll pass it.
      onDeleteModel(m.id);
    }
  };

  // Make sure the active model always appears, even before the list loads or if
  // it isn't in the local catalog yet. (Skip if it's 'none')
  const hasActive = modelName === 'none' || availableModels.some((m) => m.id === modelName);
  const displayModels = hasActive || !modelName
    ? availableModels
    : [{ id: modelName, label: modelName, format: '', compatible: true }, ...availableModels];

  const active = modelName !== 'none' ? displayModels.find((m) => m.id === modelName) : null;

  return (
    <div className="model-selector-wrapper" style={{ width: '100%', marginBottom: '0' }}>
      <div className="model-picker-container" ref={containerRef}>
        <button
          type="button"
          className="model-picker-trigger"
          disabled={isChangingModel}
          onClick={() => setIsOpen(!isOpen)}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {active ? optionText(active) : 'No model'}
          </span>
          <svg className={`chevron-icon ${isOpen ? 'open' : ''}`} viewBox="0 0 24 24">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {isOpen && (
          <div className="model-picker-dropdown">
            <div
              className={`model-picker-item ${modelName === 'none' || !modelName ? 'active' : ''}`}
              onClick={() => handleSelect('none')}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexGrow: 1 }}>
                No model
              </span>
            </div>
            {displayModels.map((m) => {
              const isSelected = m.id === modelName;
              return (
                <div
                  key={m.id}
                  className={`model-picker-item ${isSelected ? 'active' : ''} ${m.compatible === false ? 'disabled' : ''}`}
                  onClick={() => m.compatible !== false && handleSelect(m.id)}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexGrow: 1 }}>
                    {optionText(m)}
                  </span>
                  {availableModels.some(am => am.id === m.id) && (
                    <button
                      type="button"
                      className="model-trash-btn"
                      title="Delete model"
                      onClick={(e) => handleDelete(e, m)}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18"></path>
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}
            <div
              className="model-picker-item add-model"
              onClick={() => {
                setIsOpen(false);
                onAddModel();
              }}
            >
              <span>Add model…</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
            </div>
          </div>
        )}
      </div>

      {active && active.compatible === false && (
        <div className="model-picker-warning" style={{ marginTop: '8px' }}>
          This model needs the {active.engine === 'llama' ? 'llama.cpp' : 'MLX'} engine,
          which isn’t installed on this system.
        </div>
      )}
    </div>
  );
}
