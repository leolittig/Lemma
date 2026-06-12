// Polls the backend's brain activity feed so the UI can show a global
// "updating memory" spinner (in the app bar) and a real-time log of what the
// memory model is doing (in the Brain Explorer). Polls quickly while an update
// is in flight and backs off when idle. Only runs while the brain is enabled.

import { useState, useEffect, useRef } from 'react';
import * as api from '../api/client';

const EMPTY = { processing: false, events: [], stream: '' };

export function useBrainActivity(enabled) {
  const [activity, setActivity] = useState(EMPTY);
  const processingRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setActivity(EMPTY);
      return;
    }

    let cancelled = false;
    let timer = null;

    const poll = async () => {
      try {
        const data = await api.fetchBrainActivity();
        if (cancelled) return;
        processingRef.current = !!data.processing;
        setActivity({
          processing: !!data.processing,
          events: data.events || [],
          stream: data.stream || '',
        });
      } catch {
        // Transient errors (e.g. server restarting) — just try again.
      } finally {
        if (!cancelled) {
          // Tight loop while working, relaxed loop while idle.
          timer = setTimeout(poll, processingRef.current ? 600 : 2000);
        }
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);

  return activity;
}
