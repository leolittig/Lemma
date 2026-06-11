// The settings dialog: default instructions (system prompt), temperature,
// context window size, the smart-context toggle, and max response length.
//
// Values are read from and written to the useSettings hook (passed in as
// `settings`); everything persists immediately, so "Save and reload" only
// matters for re-loading the model with the current instructions applied.

import React, { useRef, useEffect } from 'react';
import Modal from './Modal';
import * as api from '../api/client';
import ToggleSwitch from './ToggleSwitch';
import { adjustTextareaHeight } from '../lib/textarea';
import {
  CTX_STEPS, CTX_DEFAULT_INDEX,
  MAX_TOKENS_STEPS, MAX_TOKENS_DEFAULT_INDEX,
} from '../constants';

// One labelled slider row: "Label    value" above a track with tick marks.
function SliderField({ label, valueText, ticks, min, max, step, value, onChange }) {
  return (
    <div className="settings-field">
      <div className="settings-label-row">
        <label className="settings-label">{label}</label>
        <span className="settings-value">{valueText}</span>
      </div>
      <div className="slider-wrap">
        <div className="slider-track" />
        <div className="slider-ticks" aria-hidden="true">
          {ticks.map((left, i) => (
            <span key={i} className="slider-tick" style={{ left }} />
          ))}
        </div>
        <input
          type="range"
          className="settings-slider"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}

// Evenly spaced tick positions, one per step.
const stepTicks = (steps) => steps.map((_, i) => `${(i / (steps.length - 1)) * 100}%`);

// Map a saved token count back to its slider position, falling back to the
// default step for anything unrecognised.
const stepIndex = (steps, savedValue, defaultIndex) => {
  const i = steps.indexOf(parseInt(savedValue, 10));
  return i === -1 ? defaultIndex : i;
};

export default function SettingsModal({ open, onClose, settings, onReloadModel }) {
  const {
    systemPrompt, setSystemPrompt,
    temperature, setTemperature,
    contextSize, setContextSize,
    maxTokens, setMaxTokens,
    smartContext, setSmartContext,
    brainEnabled, setBrainEnabled,
  } = settings;

  // Keep the instructions textarea sized to its content, also right after the
  // modal opens (the delayed second pass runs once layout has settled).
  const textareaRef = useRef(null);
  useEffect(() => {
    adjustTextareaHeight(textareaRef.current);
    const timer = setTimeout(() => adjustTextareaHeight(textareaRef.current), 50);
    return () => clearTimeout(timer);
  }, [systemPrompt, open]);

  const ctxIndex = stepIndex(CTX_STEPS, contextSize, CTX_DEFAULT_INDEX);
  const maxTokensIndex = stepIndex(MAX_TOKENS_STEPS, maxTokens, MAX_TOKENS_DEFAULT_INDEX);
  const currentMaxTokens = MAX_TOKENS_STEPS[maxTokensIndex];

  const handleResetBrain = async () => {
    const confirmReset = window.confirm("Are you sure you want to completely reset the brain? This will delete all custom memories and restore default starting hubs.");
    if (!confirmReset) return;
    try {
      await api.resetBrain("active");
      alert("Brain memory successfully reset.");
    } catch (err) {
      console.error("Failed to reset brain:", err);
      alert("Failed to reset brain. See console for details.");
    }
  };

  return (
    <Modal title="Settings" open={open} onClose={onClose}>
      <div className="settings-body">
        <div className="settings-field">
          <label className="settings-label">Instructions</label>
          <textarea
            ref={textareaRef}
            className="settings-textarea"
            value={systemPrompt}
            onChange={(e) => {
              setSystemPrompt(e.target.value);
              adjustTextareaHeight(e.target);
            }}
            rows={1}
          />
        </div>
        <SliderField
          label="Temperature"
          valueText={temperature.toFixed(2)}
          ticks={['50%']}
          min="0" max="2" step="0.05"
          value={temperature}
          onChange={(v) => setTemperature(parseFloat(v))}
        />
        <SliderField
          label="Context Window"
          valueText={`${CTX_STEPS[ctxIndex].toLocaleString()} tokens`}
          ticks={stepTicks(CTX_STEPS)}
          min="0" max={CTX_STEPS.length - 1} step="1"
          value={ctxIndex}
          onChange={(v) => setContextSize(String(CTX_STEPS[parseInt(v, 10)]))}
        />
        <div className="settings-field">
          <div className="settings-toggle-row">
            <label className="settings-label">Smart context window</label>
            <ToggleSwitch
              on={smartContext}
              onToggle={() => setSmartContext((v) => !v)}
              label="smart context window"
            />
          </div>
        </div>
        <SliderField
          label="Max Response Length"
          valueText={currentMaxTokens === 0 ? 'Unlimited' : `${currentMaxTokens.toLocaleString()} tokens`}
          ticks={stepTicks(MAX_TOKENS_STEPS)}
          min="0" max={MAX_TOKENS_STEPS.length - 1} step="1"
          value={maxTokensIndex}
          onChange={(v) => setMaxTokens(String(MAX_TOKENS_STEPS[parseInt(v, 10)]))}
        />
        <div className="settings-section-divider" />
        <label className="settings-section-title">Brain Configuration</label>
        <div className="settings-field">
          <div className="settings-toggle-row">
            <label className="settings-label">Enable memory brain</label>
            <ToggleSwitch
              on={brainEnabled}
              onToggle={() => setBrainEnabled((v) => !v)}
              label="enable memory brain"
            />
          </div>
        </div>
        {brainEnabled && (
          <div className="settings-field">
            <div className="settings-toggle-row">
              <label className="settings-label" style={{ color: '#ef4444' }}>Clear and reset brain</label>
              <button
                className="settings-action-btn danger"
                onClick={handleResetBrain}
                style={{
                  padding: '0.4rem 0.9rem',
                  fontSize: '0.8rem',
                  fontWeight: '600',
                  color: '#ef4444',
                  background: 'rgba(239, 68, 68, 0.08)',
                  border: 'none',
                  borderRadius: '999px',
                  cursor: 'pointer',
                  transition: 'background 0.2s',
                }}
                onMouseOver={(e) => e.target.style.background = 'rgba(239, 68, 68, 0.16)'}
                onMouseOut={(e) => e.target.style.background = 'rgba(239, 68, 68, 0.08)'}
              >
                Reset Brain
              </button>
            </div>
          </div>
        )}
        <div className="settings-actions">
          <button className="settings-action-btn secondary" onClick={onReloadModel}>
            Save and reload
          </button>
        </div>
      </div>
    </Modal>
  );
}
