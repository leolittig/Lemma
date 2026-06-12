// The scrollable list of messages, plus the soft fade at its bottom edge.
// Scroll behavior (the auto-scroll lock) comes from useAutoScroll in App;
// this component just wires its ref and handlers to the container.

import React, { useEffect } from 'react';
import MessageBubble from './MessageBubble';

export default function MessageList({
  history,
  isResponding,
  outOfContext,     // { ranges: [[start, end), ...] } or null
  animateFromIndex, // messages with index >= this play the entrance fly-in
  registerMessageRef,
  scroll,           // from useAutoScroll: containerRef + event handlers
  onThinkingOpened,
}) {
  // Measure the OS scrollbar width once and expose it as a CSS variable, so the
  // bottom fade overlay can inset its right edge to avoid painting over the
  // scrollbar. (Returns 0 for overlay-style scrollbars, which is correct.)
  useEffect(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;overflow:scroll;width:100px;height:100px;';
    document.body.appendChild(probe);
    const width = probe.offsetWidth - probe.clientWidth;
    document.body.removeChild(probe);
    document.documentElement.style.setProperty('--scrollbar-width', `${width}px`);
  }, []);

  return (
    <div className="messages-area">
      <div
        id="messages"
        ref={scroll.containerRef}
        onScroll={scroll.onScroll}
        onWheel={scroll.onWheel}
        onTouchMove={scroll.onTouchMove}
      >
        {history.map((msg, index) => {
          const isLast = index === history.length - 1;
          // Messages that fell into a gap between the kept context bands are
          // out of context: their bubble is tinted and their words dimmed.
          const fullyOut = !!(outOfContext &&
            outOfContext.ranges.some(([s, e]) => index >= s && index < e));
          return (
            <MessageBubble
              key={index}
              message={msg}
              index={index}
              isStreaming={isLast && msg.role === 'assistant' && isResponding}
              animate={index >= animateFromIndex}
              fullyOut={fullyOut}
              registerRef={registerMessageRef}
              onThinkingOpened={onThinkingOpened}
            />
          );
        })}
        <div />
      </div>
      <div className="messages-fade" aria-hidden="true" />
    </div>
  );
}
