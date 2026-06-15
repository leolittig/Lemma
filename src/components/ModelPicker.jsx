import React from 'react';

export default function ModelPicker({
  modelName,
  availableModels = [],
  isChangingModel,
  onSelectModel,
  onAddModel,
}) {
  const handleChange = (e) => {
    const val = e.target.value;
    if (val === 'ADD_MODEL') {
      onAddModel();
    } else {
      onSelectModel(val);
    }
  };

  const displayModels = availableModels.includes(modelName)
    ? availableModels
    : [modelName, ...availableModels];

  return (
    <div className="model-selector-wrapper">
      <select
        className="model-picker-select"
        value={modelName}
        onChange={handleChange}
        disabled={isChangingModel}
      >
        {displayModels.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        <option value="ADD_MODEL">Add model</option>
      </select>
    </div>
  );
}

