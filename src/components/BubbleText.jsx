// Renders a completed message's markdown/KaTeX into the bubble, then dims the
// leading `dimFrac` of its words (0 = none, 1 = the whole message is out of
// context). Imperative because dimming walks the rendered DOM after
// marked.parse. (Streaming messages render through lib/markdown's
// renderTokens instead — see MessageBubble.jsx.)

import React, { useRef, useLayoutEffect } from 'react';
import { marked } from '../lib/markdown';

// Dim the leading `frac` (0..1) of a rendered message's words to show they fell
// out of the model's context. Each visible word becomes a span and rendered math
// (.katex) counts as one atomic unit, so we can dim a precise prefix. Runs over
// the already-rendered DOM, so markdown and KaTeX stay intact.
const dimLeadingWords = (root, frac) => {
  if (!root || frac <= 0) return;
  // Collect, in document order, a "dim this unit" action for every word and
  // every atomic .katex element. Words are wrapped in spans as we go.
  const actions = [];
  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.classList && child.classList.contains('katex')) {
          actions.push(() => child.classList.add('word-out'));
        } else {
          walk(child);
        }
      } else if (child.nodeType === Node.TEXT_NODE) {
        if (!/\S/.test(child.textContent)) continue;
        const frag = document.createDocumentFragment();
        for (const part of child.textContent.split(/(\s+)/)) {
          if (part === '') continue;
          if (/^\s+$/.test(part)) {
            frag.appendChild(document.createTextNode(part));
            continue;
          }
          const span = document.createElement('span');
          span.textContent = part;
          frag.appendChild(span);
          actions.push(() => span.classList.add('word-out'));
        }
        child.parentNode.replaceChild(frag, child);
      }
    }
  };
  walk(root);

  const dimCount = Math.min(actions.length, Math.round(frac * actions.length));
  for (let i = 0; i < dimCount; i++) actions[i]();
};

export default function BubbleText({ text, dimFrac }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = marked.parse(text);
    dimLeadingWords(el, dimFrac);
  }, [text, dimFrac]);
  return <div className="bubble-text" ref={ref} />;
}
