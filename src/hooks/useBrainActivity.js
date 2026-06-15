// Establishes a WebSocket connection to the backend's brain activity feed so the UI
// can show a global "updating memory" spinner (in the app bar) and a real-time log
// of what the memory model is doing (in the Brain Explorer). Automatically reconnects
// if the connection drops. Only runs while the brain is enabled.

import { useState, useEffect } from 'react';
import * as api from '../api/client';

const EMPTY = { processing: false, events: [], stream: '' };

export function useBrainActivity(enabled) {
  const [activity, setActivity] = useState(EMPTY);

  useEffect(() => {
    if (!enabled) {
      setActivity(EMPTY);
      return;
    }

    let socket = null;
    let reconnectTimeout = null;
    let cancelled = false;

    // 1. Fetch initial activity status immediately
    api.fetchBrainActivity()
      .then((data) => {
        if (!cancelled) {
          setActivity({
            processing: !!data.processing,
            events: data.events || [],
            stream: data.stream || '',
          });
        }
      })
      .catch((err) => console.error('Initial brain activity fetch failed:', err));

    // 2. Connect to WebSocket
    const connect = () => {
      if (cancelled) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      const wsUrl = `${protocol}//${host}/api/brain/ws`;

      socket = new WebSocket(wsUrl);

      socket.onmessage = (event) => {
        if (cancelled) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'activity') {
            const data = msg.data;
            setActivity({
              processing: !!data.processing,
              events: data.events || [],
              stream: data.stream || '',
            });
          } else if (msg.type === 'graph_changed') {
            window.dispatchEvent(new CustomEvent('brain-graph-changed'));
          }
        } catch (err) {
          console.error('Error parsing WebSocket message:', err);
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
        // Reconnect after 3 seconds
        reconnectTimeout = setTimeout(connect, 3000);
      };

      socket.onerror = (err) => {
        console.error('WebSocket connection error:', err);
        socket.close();
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
    };
  }, [enabled]);

  return activity;
}
