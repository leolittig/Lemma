// One message in the chat: the bubble itself, its attachments, and (for
// assistant messages from reasoning models) the collapsible thinking block.
//
// Two render paths for the text:
//   streaming  -> lib/markdown's renderTokens, so new words fade in
//                 individually without re-rendering the whole message.
//   completed  -> BubbleText (marked.parse into HTML), which can also dim
//                 words that fell out of the model's context window.

import React from 'react';
import { marked, renderTokens } from '../lib/markdown';
import { parseThinking } from '../lib/thinking';
import BubbleText from './BubbleText';
import ThinkingBlock from './ThinkingBlock';

export default function MessageBubble({
  message,
  index,
  isStreaming,
  animate,        // false for history loaded from the server (no fly-in)
  fullyOut,       // true when this message fell out of the model's context
  registerRef,    // from useMessageFlip, for the slide-up reflow animation
  onThinkingOpened, // releases the auto-scroll lock
}) {
  // Deterministic random vertical offset for the fly-in (between -40 and +40px),
  // derived from the index so it's stable across re-renders.
  const randomY = Math.floor((Math.sin(index * 12.9898) * 0.5 + 0.5) * 80) - 40;
  const inlineStyle = { '--random-y': `${randomY}px` };
  const cls = `${message.role}${animate ? '' : ' no-anim'}${fullyOut ? ' out-of-context' : ''}`;

  const atts = message.attachments || [];
  const attBlock = atts.length > 0 ? (
    <div className="bubble-attachments">
      {atts.map((a, i) =>
        a.kind === 'image' ? (
          <img key={i} className="bubble-image" src={a.previewUrl || `/uploads/${a.id}`} alt={a.filename || 'image'} />
        ) : a.kind === 'audio' ? (
          <audio key={i} className="bubble-audio" controls src={`/uploads/${a.id}`} />
        ) : (
          <a key={i} className="bubble-file" href={`/uploads/${a.id}`} target="_blank" rel="noopener noreferrer">
            {a.filename || 'file'}
          </a>
        )
      )}
    </div>
  ) : null;

  // Reasoning models wrap their thinking in special tags; show it in a
  // collapsible block, separate from the final answer. Only assistant output
  // is parsed this way.
  const parsed = message.role === 'assistant'
    ? parseThinking(message.text)
    : { thinking: null, answer: message.text, done: true };
  const thinkingBlock = parsed.thinking !== null ? (
    <ThinkingBlock
      thinking={parsed.thinking}
      streaming={isStreaming && !parsed.done}
      onToggle={onThinkingOpened}
    />
  ) : null;

  const hasContent = parsed.answer || attBlock;

  const textBlock = isStreaming
    ? (parsed.answer
      ? <div className="bubble-text">{renderTokens(marked.lexer(parsed.answer), `msg-${index}`)}</div>
      : null)
    : (parsed.answer
      ? <BubbleText text={parsed.answer} dimFrac={fullyOut ? 1 : 0} />
      : null);

  return (
    <div ref={registerRef(index)} className={cls} style={inlineStyle}>
      {thinkingBlock}
      {hasContent ? (
        <div className="message-bubble">
          {attBlock}
          {textBlock}
          {animate && <span className="bubble-shine" aria-hidden="true" />}
        </div>
      ) : null}
    </div>
  );
}
