// Every call to the backend API lives in this file, so the frontend's
// network surface is visible in one place. The endpoints are implemented in
// the backend's server/routes/ package (one module per area).
//
// In development Vite proxies these paths to the FastAPI server on port 8000
// (see vite.config.js); in production the same server serves the built app,
// so the relative paths work in both modes.

const postJSON = (url, body, options = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...options,
  });

// Models

export async function fetchActiveModel() {
  const res = await fetch('/model');
  if (!res.ok) throw new Error('Model fetch failed');
  return res.json(); // { model, supports_thinking }
}

export async function fetchModels() {
  const res = await fetch('/models');
  if (!res.ok) throw new Error('Models fetch failed');
  return res.json(); // { models: [...] }
}

// Switch to (or reload) a model. Also persists the default system prompt.
// Returns the response data on success, or null when the backend rejected the
// model (it restores the previous one itself in that case).
export async function selectModel(model, systemPrompt) {
  const res = await postJSON('/model', { model, system_prompt: systemPrompt });
  return res.ok ? res.json() : null;
}

// Ask the backend to start downloading a model from Hugging Face.
// Returns { ok: true } or { ok: false, errorMessage } for API-level failures;
// network failures throw (the caller turns those into an error status too).
export async function startModelDownload(repo) {
  const res = await postJSON('/download', { model: repo });
  if (res.ok) return { ok: true };

  // Pull the most useful error message out of whatever the server sent.
  let errorMessage = 'Failed to start download.';
  try {
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      const errData = await res.json();
      errorMessage = errData.message || errData.detail || errorMessage;
    } else {
      errorMessage = (await res.text()).substring(0, 100) || errorMessage;
    }
  } catch {
    // Keep the default message when the error body itself can't be parsed.
  }
  return { ok: false, errorMessage };
}

export async function fetchDownloadStatus() {
  const res = await fetch('/download/status');
  return res.json(); // { downloads: { [repo]: {status, progress, ...} } }
}

// Conversations

export async function fetchConversations() {
  const res = await fetch('/conversations');
  if (!res.ok) throw new Error('Conversations fetch failed');
  return res.json(); // { conversations: [...] }
}

// One conversation with all its messages, or null when it doesn't exist.
export async function fetchConversation(id) {
  const res = await fetch(`/conversations/${id}`);
  return res.ok ? res.json() : null;
}

// Create a conversation and return its id.
export async function createConversation(model, systemPrompt) {
  const res = await postJSON('/conversations', { model, system_prompt: systemPrompt });
  const { id } = await res.json();
  return id;
}

export async function renameConversation(id, title) {
  await postJSON(`/conversations/${id}`, { title }, { method: 'PATCH' });
}

export async function deleteConversation(id) {
  await fetch(`/conversations/${id}`, { method: 'DELETE' });
}

// Empty a conversation in place (keeps the sidebar tile).
export async function clearConversation(id) {
  await fetch(`/conversations/${id}/clear`, { method: 'POST' });
}

// Chat and uploads

// Send one user turn. Returns the raw Response: the caller reads the reply
// from the body stream and the context-trimming info from the headers.
// `signal` aborts generation when the user hits Stop.
export function sendChatMessage(body, signal) {
  return postJSON('/chat', body, { signal });
}

// Upload one attachment; returns its record { id, kind, filename }.
export async function uploadAttachment(file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/upload', { method: 'POST', body: form });
  return res.json();
}
