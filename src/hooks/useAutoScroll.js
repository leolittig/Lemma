// Auto-scroll lock for the messages list: the view stays pinned to the newest
// message, easing toward the bottom with a slow, smooth animation that keeps
// up with both new messages and streaming tokens. It disengages the moment the
// user scrolls up to read older messages, and re-engages when they scroll all
// the way back down to the bottom. It also re-engages when the next message is
// sent (lockToBottom).
//
// `reengageAtBottom` (default true) controls the scroll-to-bottom re-engage:
// pass false to keep the lock off until lockToBottom() is called explicitly
// (used by the brain activity log, which only re-pins per memory update).
//
// Returned API:
//   containerRef           attach to the scrollable messages container
//   onWheel / onTouchMove / onScroll   attach to the same container
//   lockToBottom()         engage the lock (e.g. after sending a message)
//   releaseLock()          disengage it (e.g. when opening a thinking block)
//   notifyContentChanged() nudge the animation after content grows

import { useEffect, useRef, useCallback, useMemo } from 'react';

// Per-frame catch-up fraction. Lower = slower and smoother. A far-behind
// jump uses a larger factor so the newest content never drops out of view.
const SCROLL_EASE = 0.085;
const SCROLL_EASE_FAR = 0.25;
// How close (px) to the bottom still counts as "at the bottom".
const BOTTOM_THRESHOLD = 15;

export function useAutoScroll({ reengageAtBottom = true } = {}) {
  const containerRef = useRef(null);
  const isLockedRef = useRef(true);
  const rafRef = useRef(null);
  const expectedScrollTopRef = useRef(null);
  const lastScrollTopRef = useRef(0);

  const stopAnimation = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const animateToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container || !isLockedRef.current) {
      rafRef.current = null;
      return;
    }

    const target = container.scrollHeight - container.clientHeight;
    const distance = target - container.scrollTop;

    // Close enough — settle exactly on the bottom and idle until new content.
    if (Math.abs(distance) < 0.5) {
      expectedScrollTopRef.current = target;
      container.scrollTop = target;
      rafRef.current = null;
      return;
    }

    const factor = distance > container.clientHeight ? SCROLL_EASE_FAR : SCROLL_EASE;
    const nextScrollTop = container.scrollTop + distance * factor;
    expectedScrollTopRef.current = nextScrollTop;
    container.scrollTop = nextScrollTop;
    rafRef.current = requestAnimationFrame(animateToBottom);
  }, []);

  const ensureAnimation = useCallback(() => {
    if (isLockedRef.current && rafRef.current == null) {
      animateToBottom();
    }
  }, [animateToBottom]);

  const isAtBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;
    return container.scrollHeight - container.scrollTop - container.clientHeight <= BOTTOM_THRESHOLD;
  }, []);

  // Wheel and touch moves are now fully handled by the unified onScroll handler,
  // but we keep the empty handlers here to satisfy the expected interface.
  const onWheel = useCallback(() => {}, []);
  const onTouchMove = useCallback(() => {}, []);

  // Disengage the lock when the user scrolls away from the bottom, and (unless
  // disabled) re-engage it when they scroll all the way back down.
  const onScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    // If the scroll is programmatic (caused by our own updates), ignore it.
    if (expectedScrollTopRef.current !== null) {
      const diff = Math.abs(container.scrollTop - expectedScrollTopRef.current);
      if (diff < 2.0) {
        lastScrollTopRef.current = container.scrollTop;
        return;
      }
    }

    const atBottom = isAtBottom();
    const lastScrollTop = lastScrollTopRef.current;
    lastScrollTopRef.current = container.scrollTop;

    if (isLockedRef.current) {
      // Disengage the lock only if the user scrolls UP (scrollTop decreases) and is not at bottom.
      if (container.scrollTop < lastScrollTop && !atBottom) {
        isLockedRef.current = false;
        stopAnimation();
      }
    } else if (atBottom && reengageAtBottom) {
      isLockedRef.current = true;
      ensureAnimation();
    }
  }, [isAtBottom, stopAnimation, ensureAnimation, reengageAtBottom]);

  const lockToBottom = useCallback(() => {
    isLockedRef.current = true;
    const container = containerRef.current;
    if (container) {
      const target = container.scrollHeight - container.clientHeight;
      expectedScrollTopRef.current = target;
      container.scrollTop = target;
      lastScrollTopRef.current = target;
    }
    ensureAnimation();
  }, [ensureAnimation]);

  const releaseLock = useCallback(() => {
    isLockedRef.current = false;
    stopAnimation();
  }, [stopAnimation]);

  // Clean up the animation frame on unmount.
  useEffect(() => stopAnimation, [stopAnimation]);

  return useMemo(() => ({
    containerRef,
    onWheel,
    onTouchMove,
    onScroll,
    lockToBottom,
    releaseLock,
    notifyContentChanged: ensureAnimation,
  }), [onWheel, onTouchMove, onScroll, lockToBottom, releaseLock, ensureAnimation]);
}
