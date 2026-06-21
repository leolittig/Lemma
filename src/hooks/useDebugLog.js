// Streams the model debug tap (every input prompt + output token, per phase)
// over the brain WebSocket into a list of entries for the floating debug window.
// While enabled it asks the server to emit debug events; it stops them on close.
//
// Entries are grouped by generation: each 'input' starts a new entry, each
// 'token' appends to the current one, and 'end' marks it complete. Tokens are
// buffered in a ref and flushed to state ~10x/sec so a long generation doesn't
// thrash React with thousands of renders.

import { useState, useEffect, useRef } from 'react';
import * as api from '../api/client';

let nextId = 1;

export function useDebugLog(enabled) {
  const [entries, setEntries] = useState([]);
  const entriesRef = useRef([]);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      entriesRef.current = [];
      setEntries([]);
      return undefined;
    }

    let cancelled = false;
    let socket = null;
    let reconnectTimer = null;

    api.setDebugMode(true).catch((err) => console.error('Enable debug failed:', err));

    const flushTimer = setInterval(() => {
      if (dirtyRef.current && !cancelled) {
        dirtyRef.current = false;
        setEntries(entriesRef.current.slice());
      }
    }, 100);

    const handle = (msg) => {
      if (msg.type !== 'debug' || !msg.data) return;
      const { phase, kind, text } = msg.data;
      const list = entriesRef.current;
      if (kind === 'input') {
        list.push({ id: nextId++, phase, input: text || '', output: '', done: false });
      } else if (kind === 'token') {
        let cur = list[list.length - 1];
        if (!cur || cur.done) {
          cur = { id: nextId++, phase, input: '', output: '', done: false };
          list.push(cur);
        }
        cur.output += text || '';
      } else if (kind === 'end') {
        const cur = list[list.length - 1];
        if (cur) cur.done = true;
      }
      // Cap memory: keep the most recent generations.
      if (list.length > 40) list.splice(0, list.length - 40);
      dirtyRef.current = true;
    };

    const connect = () => {
      if (cancelled) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}/api/brain/ws`);
      socket.onmessage = (event) => {
        if (cancelled) return;
        try { handle(JSON.parse(event.data)); } catch (err) { console.error('Debug WS parse error:', err); }
      };
      socket.onclose = () => { if (!cancelled) reconnectTimer = setTimeout(connect, 3000); };
      socket.onerror = () => socket && socket.close();
    };
    connect();

    return () => {
      cancelled = true;
      clearInterval(flushTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) { socket.onclose = null; socket.onerror = null; socket.close(); }
      api.setDebugMode(false).catch(() => {});
    };
  }, [enabled]);

  const clear = () => { entriesRef.current = []; setEntries([]); };

  return { entries, clear };
}
