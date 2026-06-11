// FLIP reflow animation for the message list.
//
// Before the list is long enough to scroll, the container is bottom-anchored,
// so appending a message shoves the existing bubbles upward in a single
// instant jump. We record each bubble's position before the new one lands and
// animate it from its old spot to its new spot, so the whole stack slides up
// smoothly instead of snapping. (Once the list overflows, the scroll loop
// preserves viewport positions, so deltas are ~0 and this no-ops.)
//
// Usage: const registerMessageRef = useMessageFlip(history);
// then give each message wrapper ref={registerMessageRef(index)}.

import { useRef, useLayoutEffect } from 'react';

export function useMessageFlip(history) {
  const messageRefs = useRef(new Map());
  const prevTopsRef = useRef(new Map());
  const prevCountRef = useRef(0);

  const registerMessageRef = (key) => (el) => {
    if (el) messageRefs.current.set(key, el);
    else messageRefs.current.delete(key);
  };

  useLayoutEffect(() => {
    const grew = history.length > prevCountRef.current;
    const newTops = new Map();
    messageRefs.current.forEach((el, key) => {
      // Measure with offsetTop (pure layout position) rather than
      // getBoundingClientRect: the latter is viewport-relative, so it folds in
      // the scroll position and any in-flight `translate` from an ongoing
      // animation. Both corrupt the stored "previous position" and make the
      // next send compute a wrong delta — which showed up as bubbles dipping
      // down a frame before sliding up. offsetTop ignores scroll and transforms.
      if (el && el.isConnected) newTops.set(key, el.offsetTop);
    });

    if (grew) {
      newTops.forEach((newTop, key) => {
        const prevTop = prevTopsRef.current.get(key);
        if (prevTop === undefined) return; // the brand-new bubble — let it fly in
        const dy = prevTop - newTop;
        if (Math.abs(dy) < 0.5) return; // didn't actually move (e.g. overflowing)

        const el = messageRefs.current.get(key);
        if (!el) return;
        // Use the independent `translate` property (not `transform`): a bubble
        // that's still mid-entrance has its `transform` owned by the keyframe
        // animation, which would override an inline `transform`. `translate`
        // composes on top of `transform`, so the FLIP shift applies even while
        // the bubble is flying in (e.g. the just-sent message when the assistant
        // placeholder lands a moment later).
        // Invert: jump it back to where it was, with no transition...
        el.style.transition = 'none';
        el.style.translate = `0 ${dy}px`;
        void el.offsetHeight; // force the inverted position to take hold
        // ...then play: release it to its new position over a slow ease.
        requestAnimationFrame(() => {
          el.style.transition = 'translate 0.7s cubic-bezier(0.16, 1, 0.3, 1)';
          el.style.translate = '0 0';
        });
      });
    }

    prevTopsRef.current = newTops;
    prevCountRef.current = history.length;
  }, [history]);

  return registerMessageRef;
}
