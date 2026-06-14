// One message in the chat: the bubble itself, its attachments, and (for
// assistant messages from reasoning models) the collapsible thinking block.
//
// Two render paths for the text:
//   streaming  -> lib/markdown's renderTokens, so new words fade in
//                 individually without re-rendering the whole message.
//   completed  -> BubbleText (marked.parse into HTML), which can also dim
//                 words that fell out of the model's context window.

import React, { useRef, useEffect } from 'react';
import { marked, renderTokens } from '../lib/markdown';
import { parseThinking } from '../lib/thinking';
import BubbleText from './BubbleText';
import ThinkingBlock from './ThinkingBlock';
import BrainActivityBlock from './BrainActivityBlock';
import tailWiggleGif from '../assets/tail_wiggle.gif';

function StaticGif({ src, className, style, alt }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const img = new Image();
    img.src = src;
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      canvas.width = img.naturalWidth || 100;
      canvas.height = img.naturalHeight || 100;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
    };
  }, [src]);

  return <canvas ref={canvasRef} className={className} style={style} aria-label={alt} />;
}

export default function MessageBubble({
  message,
  index,
  isStreaming,
  isLastAssistant,
  isResponding,
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

  const brainActivityBlock = message.role === 'assistant' && message.brain_activity ? (
    <BrainActivityBlock activity={message.brain_activity} />
  ) : null;

  if (message.role !== 'assistant') {
    return (
      <div ref={registerRef(index)} className={cls} style={inlineStyle}>
        {brainActivityBlock}
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

  return (
    <div ref={registerRef(index)} className={cls} style={inlineStyle}>
      <div className="assistant-layout-row">
        <div className="assistant-indicator-container">
          {isLastAssistant && (
            <>
              <img
                src={tailWiggleGif}
                className="assistant-indicator-gif"
                style={{ display: isResponding ? 'block' : 'none' }}
                alt="Wiggling..."
              />
              <StaticGif
                src={tailWiggleGif}
                className="assistant-indicator-static"
                style={{ display: isResponding ? 'none' : 'block' }}
                alt="Stopped..."
              />
            </>
          )}
        </div>
        <div className="assistant-layout-column">
          {brainActivityBlock}
          {thinkingBlock}
          {hasContent ? (
            <div className="message-bubble">
              {attBlock}
              {textBlock}
              {animate && <span className="bubble-shine" aria-hidden="true" />}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
