// The settings dialog: default instructions (system prompt), temperature,
// context window size, the smart-context toggle, and max response length.
//
// Values are read from and written to the useSettings hook (passed in as
// `settings`); everything persists immediately, so "Save and reload" only
// matters for re-loading the model with the current instructions applied.

import React, { useRef, useEffect, useState } from 'react';
import Modal from './Modal';
import * as api from '../api/client';
import ToggleSwitch from './ToggleSwitch';
import ModelPicker from './ModelPicker';
import ModelHelpTooltip from './ModelHelpTooltip';
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

export default function SettingsModal({ open, onClose, settings, downloads = {}, onCancelDownload, onRestartDownload, onReloadModel, onReset, modelPickerProps }) {
  const {
    systemPrompt, setSystemPrompt,
    temperature, setTemperature,
    contextSize, setContextSize,
    maxTokens, setMaxTokens,
    smartContext, setSmartContext,
    pauseBrainWriting, setPauseBrainWriting,
    detailedLogs, setDetailedLogs,
    thinkingEnabled, setThinkingEnabled,
    debugMode, setDebugMode,
  } = settings;

  // Keep the instructions textarea sized to its content, also right after the
  // modal opens (the delayed second pass runs once layout has settled).
  const textareaRef = useRef(null);
  useEffect(() => {
    adjustTextareaHeight(textareaRef.current);
    const timer = setTimeout(() => adjustTextareaHeight(textareaRef.current), 50);
    return () => clearTimeout(timer);
  }, [systemPrompt, open]);

  // The active (in-flight) downloads, and the mean of their progress, shown in
  // the collapsible Downloads area under the model picker.
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const activeDownloads = Object.entries(downloads).filter(([, d]) => d.status === 'downloading');
  const hasActiveDownloads = activeDownloads.length > 0;
  // Floor, never round: the backend caps an in-flight download at 99.9%, and
  // rounding that to 100% would make an unfinished download look complete.
  const meanDownloadPct = hasActiveDownloads
    ? Math.floor(activeDownloads.reduce((sum, [, d]) => sum + (d.progress || 0), 0) / activeDownloads.length)
    : 0;

  // Collapse the panel whenever there's nothing downloading, so it can't be
  // left open and empty after downloads finish.
  useEffect(() => {
    if (!hasActiveDownloads) setDownloadsOpen(false);
  }, [hasActiveDownloads]);

  const ctxIndex = stepIndex(CTX_STEPS, contextSize, CTX_DEFAULT_INDEX);
  const maxTokensIndex = stepIndex(MAX_TOKENS_STEPS, maxTokens, MAX_TOKENS_DEFAULT_INDEX);
  const currentMaxTokens = MAX_TOKENS_STEPS[maxTokensIndex];

  const handleResetBrain = async () => {
    const confirmReset = window.confirm("Are you sure you want to completely reset the brain? This will delete all custom memories and restore default starting hubs.");
    if (!confirmReset) return;
    try {
      await api.resetBrain("active");
      alert("Brain memory successfully reset.");
      if (onReset) onReset();
    } catch (err) {
      console.error("Failed to reset brain:", err);
      alert("Failed to reset brain. See console for details.");
    }
  };

  return (
    <Modal title="Settings" open={open} onClose={onClose}>
      <div className="settings-body">
        <div className="settings-field">
          <div className="settings-label-with-help">
            <label className="settings-label">Model</label>
            <ModelHelpTooltip onPickRecommended={modelPickerProps.onAddModel} />
          </div>
          <ModelPicker {...modelPickerProps} />

          <div className="settings-downloads">
            <button
              type="button"
              className="downloads-toggle"
              disabled={!hasActiveDownloads}
              aria-expanded={downloadsOpen}
              onClick={() => setDownloadsOpen((v) => !v)}
            >
              <span className="downloads-toggle-main">
                <svg className="downloads-icon" width="15" height="15" viewBox="0 0 24 24"
                     fill="none" stroke="currentColor" strokeWidth="2"
                     strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Downloads
                {hasActiveDownloads && (
                  <span className="downloads-count">{activeDownloads.length}</span>
                )}
              </span>
              <span className="downloads-toggle-right">
                {hasActiveDownloads && (
                  <span className="downloads-pct">{meanDownloadPct}%</span>
                )}
                <svg className={`chevron-icon ${downloadsOpen ? 'open' : ''}`} viewBox="0 0 24 24">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </span>
            </button>

            {hasActiveDownloads && downloadsOpen && (
              <div className="downloads-list">
                {activeDownloads.map(([key, d]) => {
                  const pct = Math.floor(d.progress || 0);
                  const name = key.split('/').slice(-1)[0];
                  return (
                    <div className="downloads-item" key={key}>
                      <div className="downloads-item-head">
                        <span className="downloads-item-name" title={key}>{name}</span>
                        <span className="downloads-item-actions">
                          <span className="downloads-item-pct">{pct}%</span>
                          <button
                            type="button"
                            className="downloads-item-btn"
                            title="Restart download"
                            aria-label="Restart download"
                            onClick={() => onRestartDownload && onRestartDownload(key)}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                                 stroke="currentColor" strokeWidth="2"
                                 strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="23 4 23 10 17 10" />
                              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="downloads-item-btn cancel"
                            title="Cancel download"
                            aria-label="Cancel download"
                            onClick={() => onCancelDownload && onCancelDownload(key)}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                                 stroke="currentColor" strokeWidth="2"
                                 strokeLinecap="round" strokeLinejoin="round">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </span>
                      </div>
                      <div className="dl-progress">
                        <div className="dl-progress-fill" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="settings-field">
          <div className="settings-toggle-row">
            <label className="settings-label">Enable thinking (when supported)</label>
            <ToggleSwitch
              on={thinkingEnabled}
              onToggle={() => setThinkingEnabled((v) => !v)}
              label="Enable thinking (when supported)"
            />
          </div>
        </div>
        <div className="settings-section-divider" />
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
            <label className="settings-label">Pause brain writing</label>
            <ToggleSwitch
              on={pauseBrainWriting}
              onToggle={() => setPauseBrainWriting((v) => !v)}
              label="pause brain writing"
            />
          </div>
        </div>
        <div className="settings-field">
          <div className="settings-toggle-row">
            <label className="settings-label">Detailed memory logs</label>
            <ToggleSwitch
              on={detailedLogs}
              onToggle={() => setDetailedLogs((v) => !v)}
              label="detailed memory logs"
            />
          </div>
        </div>
        <div className="settings-section-divider" />
        <label className="settings-section-title">Developer</label>
        <div className="settings-field">
          <div className="settings-toggle-row">
            <label className="settings-label">Debug window (every model token)</label>
            <ToggleSwitch
              on={debugMode}
              onToggle={() => setDebugMode((v) => !v)}
              label="debug window"
            />
          </div>
        </div>
        <div className="settings-footer-actions">
          <button className="settings-action-btn secondary" onClick={onReloadModel}>
            Save and reload
          </button>
          <button className="settings-action-btn danger-text" onClick={handleResetBrain}>
            Reset Brain
          </button>
        </div>
      </div>
    </Modal>
  );
}
