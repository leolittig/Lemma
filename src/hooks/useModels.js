// Everything about models: which one is active, which are available locally,
// switching between them, and downloading new ones from Hugging Face.
//
// Available models are rich entries ({ id, label, format, engine, compatible })
// so the picker can flag what this machine's engine can't run. Download progress
// works by polling; the models list is refreshed only when a download finishes
// (not on a timer), so opening Settings no longer hammers GET /models.

import { useState, useEffect, useCallback } from 'react';
import * as api from '../api/client';
import { INITIAL_MODEL_NAME } from '../constants';

// Frontend-side sanitization of a Hugging Face repo id (the backend sanitizes
// again); strips hidden or non-repo characters.
const sanitizeRepoId = (raw) => raw.replace(/[^a-zA-Z0-9\-._/]/g, '').trim();

// The status-map key a download is tracked under (matches the backend).
const downloadKey = (repo, filename) => (filename ? `${repo}/${filename}` : repo);

const downloadErrorStatus = (message) => ({
  status: 'error', progress: 0.0, downloaded_bytes: 0, total_bytes: 0, error_message: message,
});

export function useModels() {
  const [modelName, setModelName] = useState(INITIAL_MODEL_NAME);
  const [supportsThinking, setSupportsThinking] = useState(true);
  const [supportsVision, setSupportsVision] = useState(true);
  const [supportsAudio, setSupportsAudio] = useState(true);
  const [availableModels, setAvailableModels] = useState([]);
  const [changingToModel, setChangingToModel] = useState(null);
  // Download progress per download key, mirrored from GET /download/status.
  const [downloads, setDownloads] = useState({});

  const applyModelData = (data) => {
    setSupportsThinking(data.supports_thinking !== false);
    setSupportsVision(data.supports_vision !== false);
    setSupportsAudio(data.supports_audio !== false);
  };

  // Fetch the active model and the available models on mount, retrying every
  // 2s while the backend is still starting up (it loads a model before it
  // begins serving requests, which can take a while).
  useEffect(() => {
    let isMounted = true;
    let retryTimeoutId;

    const fetchInitialData = async () => {
      try {
        const modelData = await api.fetchActiveModel();
        if (modelData.model !== undefined && isMounted) {
          setModelName(modelData.model || 'none');
          applyModelData(modelData);
        }

        const modelsData = await api.fetchModels();
        if (modelsData.models && isMounted) {
          setAvailableModels(modelsData.models);
        }
      } catch (err) {
        console.error('Error fetching models data (backend might still be starting up), retrying in 2s...', err);
        if (isMounted) {
          retryTimeoutId = setTimeout(fetchInitialData, 2000);
        }
      }
    };

    fetchInitialData();

    return () => {
      isMounted = false;
      if (retryTimeoutId) clearTimeout(retryTimeoutId);
    };
  }, []);

  const refreshModels = useCallback(async () => {
    try {
      const data = await api.fetchModels();
      if (data.models) setAvailableModels(data.models);
    } catch (err) {
      console.error('Error updating models list:', err);
    }
  }, []);

  // While any download is active, poll its progress and refresh the models
  // list once a download completes (the only time the list can change).
  useEffect(() => {
    const hasActive = Object.values(downloads).some((d) => d.status === 'downloading');
    if (!hasActive) return;

    let timeoutId;
    let isMounted = true;

    const poll = async () => {
      try {
        const data = await api.fetchDownloadStatus();
        if (!isMounted) return;

        if (data.downloads) {
          const completed = Object.values(data.downloads).some(
            (dl) => dl.status === 'completed'
          );
          setDownloads(data.downloads);
          if (completed) refreshModels();

          const stillActive = Object.values(data.downloads).some(
            (d) => d.status === 'downloading'
          );
          if (stillActive) {
            timeoutId = setTimeout(poll, 1500);
          }
        }
      } catch (err) {
        console.error('Error polling download status:', err);
        if (isMounted) timeoutId = setTimeout(poll, 2000);
      }
    };

    timeoutId = setTimeout(poll, 1500);

    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
    };
  }, [downloads, refreshModels]);

  // Shared by selectModel and reloadModel: ask the backend to load `model`
  // (which also persists the default system prompt) and apply the result.
  // Returns true when the switch succeeded.
  const switchTo = async (model, systemPrompt) => {
    setChangingToModel(model);
    try {
      const data = await api.selectModel(model, systemPrompt);
      if (!data) return false;
      setModelName(model);
      applyModelData(data);
      return true;
    } catch (err) {
      console.error('Error changing model:', err);
      return false;
    } finally {
      setChangingToModel(null);
    }
  };

  // Switch to a different model. No-ops when it's already active. The active
  // conversation is intentionally kept — the chat continues on the new model,
  // re-templated server-side on the next message.
  const selectModel = async (model, systemPrompt) => {
    if (model === modelName || changingToModel !== null) return false;
    return switchTo(model, systemPrompt);
  };

  // Re-load the currently active model. Unlike selectModel this doesn't bail
  // when the target equals the current model, so it forces a fresh load,
  // applying the current default system prompt. The conversation is kept.
  const reloadModel = async (systemPrompt) => {
    if (changingToModel !== null) return false;
    return switchTo(modelName, systemPrompt);
  };

  // Start downloading a model (whole repo, or one GGUF variant via `filename`).
  // Returns true when a download was started. Synchronous on purpose: the
  // placeholder entry below kicks off the polling effect; errors from the
  // actual request are folded into that entry as they arrive.
  const startDownload = (rawRepo, filename) => {
    const repo = sanitizeRepoId(rawRepo);
    if (!repo) return false;
    const key = downloadKey(repo, filename);

    // Seed a placeholder entry so the UI shows progress immediately and the
    // polling effect starts running.
    setDownloads((prev) => ({
      ...prev,
      [key]: { status: 'downloading', progress: 0.0, downloaded_bytes: 0, total_bytes: 0, error_message: '' },
    }));

    (async () => {
      try {
        const result = await api.startModelDownload(repo, filename);
        if (!result.ok) {
          setDownloads((prev) => ({ ...prev, [key]: downloadErrorStatus(result.errorMessage) }));
        }
      } catch (err) {
        setDownloads((prev) => ({ ...prev, [key]: downloadErrorStatus(err.message || 'Failed to connect.') }));
      }
    })();

    return true;
  };

  // Remove a failed/finished download's entry from the list (the ✕ button).
  const dismissDownload = (key) => {
    setDownloads((prev) => {
      const copy = { ...prev };
      delete copy[key];
      return copy;
    });
  };

  // Cancel an in-flight download: stop it, delete its partial files, and drop
  // its entry from the list.
  const cancelDownload = async (key) => {
    try {
      await api.cancelDownload(key);
    } catch (err) {
      console.error('Error cancelling download:', err);
    }
    dismissDownload(key);
  };

  // Restart a download from scratch: wipe what's on disk and re-seed the
  // placeholder so the polling effect picks it back up.
  const restartDownload = async (key) => {
    setDownloads((prev) => ({
      ...prev,
      [key]: { status: 'downloading', progress: 0.0, downloaded_bytes: 0, total_bytes: 0, error_message: '' },
    }));
    try {
      await api.restartDownload(key);
    } catch (err) {
      setDownloads((prev) => ({ ...prev, [key]: downloadErrorStatus(err.message || 'Failed to restart.') }));
    }
  };

  // Delete a model from disk and refresh the list.
  const removeModel = async (modelId) => {
    try {
      await api.deleteModel(modelId);
      await refreshModels();
      // If we deleted the currently active model, switch to 'none'
      if (modelId === modelName) {
        setModelName('none');
      }
      return true;
    } catch (err) {
      console.error('Error deleting model:', err);
      alert(`Failed to delete model: ${err.message}`);
      return false;
    }
  };

  return {
    modelName,
    supportsThinking,
    supportsVision,
    supportsAudio,
    availableModels,
    isChangingModel: changingToModel !== null,
    changingToModel,
    downloads,
    refreshModels,
    selectModel,
    reloadModel,
    startDownload,
    dismissDownload,
    cancelDownload,
    restartDownload,
    removeModel,
  };
}
