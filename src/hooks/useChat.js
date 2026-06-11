// The send flow: take what's in the composer, persist + send it, and stream
// the model's reply into the open conversation message by message.
//
// Receives the other feature hooks it coordinates: `conversations`
// (useConversations), `settings` (useSettings), `attachments`
// (useAttachments), and `scroll` (useAutoScroll).

import { useState, useRef } from 'react';
import * as api from '../api/client';

export function useChat({ conversations, settings, attachments, scroll }) {
  const [inputText, setInputText] = useState('');
  const [isResponding, setIsResponding] = useState(false);
  const abortRef = useRef(null);

  const send = async (e) => {
    e.preventDefault();
    const text = inputText.trim();
    const ready = attachments.pendingAttachments.filter((a) => !a.uploading);
    if ((!text && ready.length === 0) || isResponding) return;
    // Don't send while any upload is still in flight.
    if (attachments.pendingAttachments.some((a) => a.uploading)) return;

    // Ensure there's a conversation to attach this message to.
    let cid = conversations.activeIdRef.current;
    if (!cid) {
      try {
        cid = await conversations.create();
        conversations.setActiveId(cid);
      } catch (err) {
        console.error('Could not create conversation:', err);
        return;
      }
    }

    // Show the user's bubble immediately. The server only needs the refs; the
    // local bubble keeps previewUrl (an object URL) so images render instantly
    // instead of waiting on a /uploads round-trip.
    const displayAttachments = ready.map(({ id, kind, filename, previewUrl }) => ({
      id, kind, filename, previewUrl,
    }));
    setInputText('');
    attachments.clearAttachments();
    conversations.setHistory((prev) => [...prev, { role: 'user', text, attachments: displayAttachments }]);
    scroll.lockToBottom();
    setIsResponding(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const body = buildChatBody(cid, text, ready, settings);
      const res = await api.sendChatMessage(body, controller.signal);
      if (!res.ok) {
        throw new Error(`Server returned status ${res.status}`);
      }

      // The backend reports which message ranges fell out of the model's
      // context in response headers (see server/routes/chat.py).
      conversations.setOutOfContext(parseTrimmedRanges(res));

      // Add a placeholder assistant message, then fill it as chunks stream in.
      conversations.setHistory((prev) => [...prev, { role: 'assistant', text: '', attachments: [] }]);
      await streamInto(res, (replySoFar) => {
        conversations.setHistory((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', text: replySoFar, attachments: [] };
          return updated;
        });
      });
    } catch (error) {
      // Aborting via the stop button is expected — keep whatever streamed so far.
      if (error.name !== 'AbortError') {
        console.error('Error fetching chat response:', error);
      }
    } finally {
      abortRef.current = null;
      setIsResponding(false);
      conversations.refresh(); // pick up the auto-title and new ordering
    }
  };

  // Stop the in-flight response: aborts the streaming fetch, which ends the
  // read loop and settles isResponding in send's finally block.
  const stop = () => {
    abortRef.current?.abort();
  };

  return { inputText, setInputText, isResponding, setIsResponding, send, stop };
}

// The /chat request body: the message plus the current generation settings.
function buildChatBody(cid, text, readyAttachments, settings) {
  const parsedContext = parseInt(settings.contextSize, 10);
  const parsedMaxTokens = parseInt(settings.maxTokens, 10);
  return {
    conversation_id: cid,
    text,
    attachments: readyAttachments.map(({ id, kind, filename }) => ({ id, kind, filename })),
    temperature: settings.temperature,
    // '' or non-numeric => null, i.e. unlimited context window.
    max_kv_size: Number.isFinite(parsedContext) && parsedContext > 0 ? parsedContext : null,
    enable_thinking: settings.thinkingEnabled,
    max_tokens: Number.isFinite(parsedMaxTokens) ? parsedMaxTokens : null,
    smart_context: settings.smartContext,
    brain_mode: settings.brainMode,
  };
}

// The out-of-context ranges from the response headers, or null when the
// whole conversation fit.
function parseTrimmedRanges(res) {
  if (res.headers.get('X-Context-Trimmed') !== '1') return null;
  try {
    const parsed = JSON.parse(res.headers.get('X-Context-Out-Ranges') || '[]');
    return Array.isArray(parsed) && parsed.length ? { ranges: parsed } : null;
  } catch {
    return null;
  }
}

// Read the streamed reply, calling onUpdate with the accumulated text after
// every chunk.
async function streamInto(res, onUpdate) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let reply = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    reply += decoder.decode(value, { stream: true });
    onUpdate(reply);
  }
}
