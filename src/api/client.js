// Every call to the backend API lives in this file, so the frontend's
// network surface is visible in one place. The endpoints are implemented in
// the backend's server/routes/ package (one module per area).
//
// In development Vite proxies these paths to the FastAPI server on port 8000
// (see vite.config.js); in production the same server serves the built app,
// so the relative paths work in both modes.

// Monkey-patch window.fetch to inject X-Profile header globally
const originalFetch = window.fetch;
window.fetch = function (url, options = {}) {
  const profile = localStorage.getItem('active_profile') || 'default';
  options.headers = options.headers || {};
  options.headers['X-Profile'] = profile;
  return originalFetch(url, options);
};

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

// Brain

export async function fetchBrainGraph(mode) {
  const res = await fetch(`/api/brain/graph?mode=${encodeURIComponent(mode)}`);
  if (!res.ok) throw new Error('Brain graph fetch failed');
  return res.json(); // { nodes: [...], links: [...], processing: bool }
}

// The live activity feed for the background memory update — drives the app-bar
// spinner and the brain view's real-time log.
export async function fetchBrainActivity() {
  const res = await fetch('/api/brain/activity');
  if (!res.ok) throw new Error('Brain activity fetch failed');
  return res.json(); // { processing: bool, events: [...], stream: "" }
}

// Whether the brain has been set up (root node named), and the user's name.
export async function fetchBrainStatus(mode) {
  const res = await fetch(`/api/brain/status?mode=${encodeURIComponent(mode)}`);
  if (!res.ok) throw new Error('Brain status fetch failed');
  return res.json(); // { initialized, user_name }
}

// Create the single root node named after the user (first-boot prompt).
export async function initBrain(mode, name) {
  const res = await postJSON(`/api/brain/init?mode=${encodeURIComponent(mode)}`, { name });
  if (!res.ok) throw new Error('Brain init failed');
  return res.json();
}

// The Calendar entity: a chronological list of dated entries.
export async function fetchBrainCalendar(mode) {
  const res = await fetch(`/api/brain/calendar?mode=${encodeURIComponent(mode)}`);
  if (!res.ok) throw new Error('Brain calendar fetch failed');
  return res.json(); // { events: [...] }
}

// The Journal entity: day sections (newest first).
export async function fetchBrainJournal(mode) {
  const res = await fetch(`/api/brain/journal?mode=${encodeURIComponent(mode)}`);
  if (!res.ok) throw new Error('Brain journal fetch failed');
  return res.json(); // { days: [...] }
}

// Where the off-grid entities reference a node (via @mentions).
export async function fetchBrainNodeRefs(mode, filename) {
  const res = await fetch(`/api/brain/node_refs?mode=${encodeURIComponent(mode)}&filename=${encodeURIComponent(filename)}`);
  if (!res.ok) throw new Error('Brain node refs fetch failed');
  return res.json(); // { calendar:[], journal:[], assistant:bool }
}

export async function fetchBrainFile(mode, filename) {
  const res = await fetch(`/api/brain/file?mode=${encodeURIComponent(mode)}&filename=${encodeURIComponent(filename)}`);
  if (!res.ok) throw new Error('Brain file fetch failed');
  return res.json(); // { content: "..." }
}

export async function saveBrainFile(mode, filename, content) {
  const res = await postJSON(`/api/brain/file?mode=${encodeURIComponent(mode)}&filename=${encodeURIComponent(filename)}`, { content });
  return res.json();
}

export async function deleteBrainFile(mode, filename) {
  const res = await fetch(`/api/brain/file?mode=${encodeURIComponent(mode)}&filename=${encodeURIComponent(filename)}`, { method: 'DELETE' });
  return res.json();
}

export async function renameBrainFile(mode, oldFilename, newFilename) {
  const res = await postJSON(`/api/brain/rename?mode=${encodeURIComponent(mode)}`, {
    old_filename: oldFilename,
    new_filename: newFilename,
  });
  if (!res.ok) {
    let msg = 'Brain file rename failed';
    try {
      const errData = await res.json();
      msg = errData.detail || errData.message || msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export async function resetBrain(mode) {
  const res = await postJSON(`/api/brain/reset?mode=${encodeURIComponent(mode)}`);
  if (!res.ok) throw new Error('Brain reset failed');
  return res.json();
}

export async function setBrainMode(mode) {
  const res = await postJSON('/api/brain/mode', { mode });
  return res.json();
}

export async function deleteProfile(profileName) {
  const res = await fetch(`/api/profile/${encodeURIComponent(profileName)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete profile');
  return res.json();
}

export async function editCalendarEvent(mode, ts, text, newText) {
  const res = await postJSON(`/api/brain/calendar/edit?mode=${encodeURIComponent(mode)}`, {
    ts,
    text,
    new_text: newText,
  });
  if (!res.ok) {
    let msg = 'Edit calendar event failed';
    try {
      const errData = await res.json();
      msg = errData.detail || errData.message || msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export async function deleteCalendarEvent(mode, ts, text) {
  const res = await postJSON(`/api/brain/calendar/delete?mode=${encodeURIComponent(mode)}`, {
    ts,
    text,
  });
  if (!res.ok) {
    let msg = 'Delete calendar event failed';
    try {
      const errData = await res.json();
      msg = errData.detail || errData.message || msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

