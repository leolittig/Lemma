// The conversation list (sidebar) and the currently open conversation:
// its id, its messages, and the out-of-context display state.
//
// Parameters:
//   getDefaults()  -> { model, systemPrompt } for newly created chats.
//   onOpened()     called after switching to an existing conversation
//                  (App locks the auto-scroll and clears pending attachments).
//   onCleared()    called when the visible chat is emptied (new chat, or the
//                  only chat was deleted).

import { useState, useRef, useEffect } from 'react';
import * as api from '../api/client';

export function useConversations({ getDefaults, onOpened, onCleared }) {
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [history, setHistory] = useState([]);
  // Read the active id from inside async flows without stale closures.
  const activeIdRef = useRef(null);
  activeIdRef.current = activeId;

  // Message-index ranges that fell out of the model's context on the last
  // turn ({ ranges: [[start, end), ...] }), or null when everything fit.
  const [outOfContext, setOutOfContext] = useState(null);
  // Messages with index >= this get the entrance fly-in; lower indices are
  // already-saved history loaded from the server and should appear instantly.
  const [animateFromIndex, setAnimateFromIndex] = useState(0);

  const refresh = async () => {
    try {
      const data = await api.fetchConversations();
      setConversations(data.conversations || []);
      return data.conversations || [];
    } catch (err) {
      console.error('Error fetching conversations:', err);
      return [];
    }
  };

  const load = async (id) => {
    try {
      const conv = await api.fetchConversation(id);
      if (!conv) return;
      setActiveId(id);
      setHistory((conv.messages || []).map((m) => ({
        role: m.role,
        text: m.text,
        attachments: m.attachments || [],
        brain_activity: m.brain_activity || null,
      })));
      setAnimateFromIndex((conv.messages || []).length);
      setOutOfContext(parseStoredRanges(conv.context_out_ranges));
      onOpened();
    } catch (err) {
      console.error('Error loading conversation:', err);
    }
  };

  const create = async () => {
    const { model, systemPrompt } = getDefaults();
    const id = await api.createConversation(model, systemPrompt);
    await refresh();
    return id;
  };

  // Reset the visible chat to an empty state (after new chat / clear).
  const showEmptyChat = () => {
    setHistory([]);
    setAnimateFromIndex(0);
    setOutOfContext(null);
    onCleared();
  };

  const newChat = async () => {
    try {
      setActiveId(await create());
      showEmptyChat();
    } catch (err) {
      console.error('Error creating conversation:', err);
    }
  };

  const select = (id) => {
    if (id !== activeIdRef.current) load(id);
  };

  const rename = async (id, title) => {
    try {
      await api.renameConversation(id, title);
      refresh();
    } catch (err) {
      console.error('Error renaming conversation:', err);
    }
  };

  const remove = async (id) => {
    try {
      // Deleting the only chat would leave the list empty, so instead clear it
      // in place: empty its messages and reset its name, keeping the tile.
      if (conversations.length <= 1) {
        await api.clearConversation(id);
        // Reset the tile name immediately, then confirm against the server.
        setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: '' } : c)));
        await refresh();
        if (id === activeIdRef.current) showEmptyChat();
        return;
      }
      await api.deleteConversation(id);
      const list = await refresh();
      if (id === activeIdRef.current) {
        if (list.length > 0) load(list[0].id);
        else newChat();
      }
    } catch (err) {
      console.error('Error deleting conversation:', err);
    }
  };

  // On mount (once the backend is up), open the most recent conversation or
  // start a fresh one. Retries while the backend is still loading the model.
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        const data = await api.fetchConversations();
        if (cancelled) return;
        const list = data.conversations || [];
        setConversations(list);
        if (list.length > 0) load(list[0].id);
        else newChat();
      } catch (err) {
        if (!cancelled) setTimeout(init, 2000);
      }
    };
    init();
    return () => { cancelled = true; };
  }, []);

  return {
    conversations,
    activeId,
    setActiveId,
    activeIdRef,
    history,
    setHistory,
    outOfContext,
    setOutOfContext,
    animateFromIndex,
    refresh,
    create,
    newChat,
    select,
    rename,
    remove,
  };
}

// The ranges persisted on the conversation row (JSON string or null).
function parseStoredRanges(json) {
  try {
    const parsed = json ? JSON.parse(json) : null;
    return Array.isArray(parsed) && parsed.length ? { ranges: parsed } : null;
  } catch {
    return null;
  }
}
