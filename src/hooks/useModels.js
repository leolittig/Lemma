// Everything about models: which one is active, which are available locally,
// switching between them, and downloading new ones from Hugging Face.
//
// Download progress works by polling: starting a download seeds an entry in
// `downloads`, and the polling effect below keeps refreshing all entries from
// the backend until none is active anymore.

import { useState, useEffect } from 'react';
import * as api from '../api/client';
import { INITIAL_MODEL_NAME } from '../constants';

// Frontend-side sanitization of a Hugging Face repo id (the backend sanitizes
// again); strips hidden or non-repo characters.
const sanitizeRepoId = (raw) => raw.replace(/[^a-zA-Z0-9\-._/]/g, '').trim();

const downloadErrorStatus = (message) => ({
  status: 'error', progress: 0.0, downloaded_bytes: 0, total_bytes: 0, error_message: message,
});

export function useModels() {
  const [modelName, setModelName] = useState(INITIAL_MODEL_NAME);
  const [supportsThinking, setSupportsThinking] = useState(true);
  const [availableModels, setAvailableModels] = useState([]);
  const [isChangingModel, setIsChangingModel] = useState(false);
  // Download progress per repo id, mirrored from GET /download/status.
  const [downloads, setDownloads] = useState({});

  // Fetch the active model and the available models on mount, retrying every
  // 2s while the backend is still starting up (it loads a model before it
  // begins serving requests, which can take a while).
  useEffect(() => {
    let isMounted = true;
    let retryTimeoutId;

    const fetchInitialData = async () => {
      try {
        const modelData = await api.fetchActiveModel();
        if (modelData.model && isMounted) {
          setModelName(modelData.model);
          setSupportsThinking(modelData.supports_thinking !== false);
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

  // While any download is active, poll its progress and refresh the models
  // list when one completes.
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
          setDownloads(data.downloads);

          const completedNew = Object.entries(data.downloads).some(
            ([repo, dl]) => dl.status === 'completed' && !availableModels.includes(repo)
          );
          if (completedNew) {
            const mData = await api.fetchModels();
            if (mData.models && isMounted) {
              setAvailableModels(mData.models);
            }
          }

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
  }, [availableModels, downloads]);

  const refreshModels = async () => {
    try {
      const data = await api.fetchModels();
      if (data.models) setAvailableModels(data.models);
    } catch (err) {
      console.error('Error updating models list:', err);
    }
  };

  // Shared by selectModel and reloadModel: ask the backend to load `model`
  // (which also persists the default system prompt) and apply the result.
  // Returns true when the switch succeeded.
  const switchTo = async (model, systemPrompt) => {
    setIsChangingModel(true);
    try {
      const data = await api.selectModel(model, systemPrompt);
      if (!data) return false;
      setModelName(model);
      setSupportsThinking(data.supports_thinking !== false);
      return true;
    } catch (err) {
      console.error('Error changing model:', err);
      return false;
    } finally {
      setIsChangingModel(false);
    }
  };

  // Switch to a different model. No-ops when it's already active. The active
  // conversation is intentionally kept — the chat continues on the new model,
  // re-templated server-side on the next message.
  const selectModel = async (model, systemPrompt) => {
    if (model === modelName || isChangingModel) return false;
    return switchTo(model, systemPrompt);
  };

  // Re-load the currently active model. Unlike selectModel this doesn't bail
  // when the target equals the current model, so it forces a fresh load,
  // applying the current default system prompt. The conversation is kept.
  const reloadModel = async (systemPrompt) => {
    if (isChangingModel) return false;
    return switchTo(modelName, systemPrompt);
  };

  // Start downloading a model. Returns true when a download was started
  // (i.e. the input was a plausible repo id). Synchronous on purpose: the
  // placeholder entry below kicks off the polling effect; errors from the
  // actual request are folded into that entry as they arrive.
  const startDownload = (rawRepo) => {
    const repo = sanitizeRepoId(rawRepo);
    if (!repo) return false;

    // Seed a placeholder entry so the UI shows progress immediately and the
    // polling effect starts running.
    setDownloads((prev) => ({
      ...prev,
      [repo]: { status: 'downloading', progress: 0.0, downloaded_bytes: 0, total_bytes: 0, error_message: '' },
    }));

    (async () => {
      try {
        const result = await api.startModelDownload(repo);
        if (!result.ok) {
          setDownloads((prev) => ({ ...prev, [repo]: downloadErrorStatus(result.errorMessage) }));
        }
      } catch (err) {
        setDownloads((prev) => ({ ...prev, [repo]: downloadErrorStatus(err.message || 'Failed to connect.') }));
      }
    })();

    return true;
  };

  // Remove a failed download's entry from the list (the ✕ button).
  const dismissDownload = (repo) => {
    setDownloads((prev) => {
      const copy = { ...prev };
      delete copy[repo];
      return copy;
    });
  };

  return {
    modelName,
    supportsThinking,
    availableModels,
    isChangingModel,
    downloads,
    refreshModels,
    selectModel,
    reloadModel,
    startDownload,
    dismissDownload,
  };
}
