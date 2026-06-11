// Auto-scroll lock for the messages list: the view stays pinned to the newest
// message, easing toward the bottom with a slow, smooth animation that keeps
// up with both new messages and streaming tokens. It disengages the moment
// the user scrolls up to read older messages, and re-engages once they scroll
// all the way back down to the bottom.
//
// Returned API:
//   containerRef           attach to the scrollable messages container
//   onWheel / onTouchMove / onScroll   attach to the same container
//   lockToBottom()         engage the lock (e.g. after sending a message)
//   releaseLock()          disengage it (e.g. when opening a thinking block)
//   notifyContentChanged() nudge the animation after content grows

import { useEffect, useRef } from 'react';

// Per-frame catch-up fraction. Lower = slower and smoother. A far-behind
// jump uses a larger factor so the newest content never drops out of view.
const SCROLL_EASE = 0.085;
const SCROLL_EASE_FAR = 0.25;
// How close (px) to the bottom still counts as "at the bottom".
const BOTTOM_THRESHOLD = 15;

export function useAutoScroll() {
  const containerRef = useRef(null);
  const isLockedRef = useRef(true);
  const rafRef = useRef(null);

  const stopAnimation = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const animateToBottom = () => {
    const container = containerRef.current;
    if (!container || !isLockedRef.current) {
      rafRef.current = null;
      return;
    }

    const target = container.scrollHeight - container.clientHeight;
    const distance = target - container.scrollTop;

    // Close enough — settle exactly on the bottom and idle until new content.
    if (Math.abs(distance) < 0.5) {
      container.scrollTop = target;
      rafRef.current = null;
      return;
    }

    const factor = distance > container.clientHeight ? SCROLL_EASE_FAR : SCROLL_EASE;
    container.scrollTop = container.scrollTop + distance * factor;
    rafRef.current = requestAnimationFrame(animateToBottom);
  };

  const ensureAnimation = () => {
    if (isLockedRef.current && rafRef.current == null) {
      rafRef.current = requestAnimationFrame(animateToBottom);
    }
  };

  const isAtBottom = () => {
    const container = containerRef.current;
    if (!container) return true;
    return container.scrollHeight - container.scrollTop - container.clientHeight <= BOTTOM_THRESHOLD;
  };

  // Programmatic scrolling never fires wheel/touch events, so these handlers
  // only ever see genuine user gestures — a reliable way to break the lock.
  const onWheel = (e) => {
    if (e.deltaY < 0 && isLockedRef.current) {
      isLockedRef.current = false;
      stopAnimation();
    }
  };

  const onTouchMove = () => {
    if (isLockedRef.current && !isAtBottom()) {
      isLockedRef.current = false;
      stopAnimation();
    }
  };

  // Re-engage the lock the instant the user returns to the very bottom.
  const onScroll = () => {
    if (!isLockedRef.current && isAtBottom()) {
      isLockedRef.current = true;
      ensureAnimation();
    }
  };

  const lockToBottom = () => {
    isLockedRef.current = true;
    ensureAnimation();
  };

  const releaseLock = () => {
    isLockedRef.current = false;
    stopAnimation();
  };

  // Clean up the animation frame on unmount.
  useEffect(() => stopAnimation, []);

  return {
    containerRef,
    onWheel,
    onTouchMove,
    onScroll,
    lockToBottom,
    releaseLock,
    notifyContentChanged: ensureAnimation,
  };
}
