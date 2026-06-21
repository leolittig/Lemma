// One message in the chat: the bubble itself, its attachments, and (for
// assistant messages from reasoning models) the collapsible thinking block.
//
// Two render paths for the text:
//   streaming  -> lib/markdown's renderTokens, so new words fade in
//                 individually without re-rendering the whole message.
//   completed  -> BubbleText (marked.parse into HTML), which can also dim
//                 words that fell out of the model's context window.

import React, { useRef, useEffect, useState } from 'react';
import { marked, renderTokens } from '../lib/markdown';
import { parseThinking } from '../lib/thinking';
import BubbleText from './BubbleText';
import ThinkingBlock from './ThinkingBlock';
import BrainActivityBlock from './BrainActivityBlock';
import tailWiggleGif from '../assets/tail_wiggle.gif';
import thinkingGif from '../assets/thinking.gif';
import writingGif from '../assets/writing.gif';

// Fallback play length if the GIF's real duration can't be measured, and how
// often the idle wiggle repeats.
const IDLE_WIGGLE_MS = 2500;
const IDLE_WIGGLE_EVERY_MS = 10000;

// Frame 1 of a GIF as a still PNG data URL. The idle rest state uses this in a
// plain <img> — the same element/styling as the playing gif — so swapping
// between resting and wiggling never shifts the tail's position.
function gifFirstFrameUrl(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || 360;
        c.height = img.naturalHeight || 360;
        c.getContext('2d').drawImage(img, 0, 0);
        resolve(c.toDataURL('image/png'));
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

let tailStillPromise = null;
const getTailStill = () => {
  if (!tailStillPromise) tailStillPromise = gifFirstFrameUrl(tailWiggleGif);
  return tailStillPromise;
};

// Sum a GIF's frame delays to get one full loop's duration (ms). Playing for
// exactly this long lands the animation back on frame 1, so the idle wiggle
// starts and ends on the resting frame. Returns null if it can't be parsed.
async function gifLoopDurationMs(src) {
  try {
    const buf = new Uint8Array(await (await fetch(src)).arrayBuffer());
    if (String.fromCharCode(buf[0], buf[1], buf[2]) !== 'GIF') return null;
    let i = 13; // after 6-byte header + 7-byte logical screen descriptor
    const packed = buf[10];
    if (packed & 0x80) i += 3 * (1 << ((packed & 0x07) + 1)); // global color table
    let total = 0;
    while (i < buf.length) {
      const block = buf[i];
      if (block === 0x21) { // extension
        if (buf[i + 1] === 0xF9) total += (buf[i + 4] | (buf[i + 5] << 8)) * 10; // GCE delay (1/100s)
        i += 2;
        while (buf[i]) i += buf[i] + 1;
        i += 1;
      } else if (block === 0x2C) { // image descriptor
        const lp = buf[i + 9];
        i += 10;
        if (lp & 0x80) i += 3 * (1 << ((lp & 0x07) + 1)); // local color table
        i += 1; // LZW min code size
        while (buf[i]) i += buf[i] + 1;
        i += 1;
      } else break; // trailer (0x3B) or unknown
    }
    return total || null;
  } catch {
    return null;
  }
}

let tailDurationPromise = null;
const getTailDuration = () => {
  if (!tailDurationPromise) tailDurationPromise = gifLoopDurationMs(tailWiggleGif);
  return tailDurationPromise;
};

// The tail wiggle as an in-memory Blob. Each idle play mints a fresh object URL
// from it so the browser decodes a NEW copy starting at frame 1 — re-using the
// cached <img> src resumes the shared GIF timeline instead (the "+1 frame each
// play" drift).
let tailBlobPromise = null;
const getTailBlob = () => {
  if (!tailBlobPromise) {
    tailBlobPromise = fetch(tailWiggleGif).then((r) => r.blob()).catch(() => null);
  }
  return tailBlobPromise;
};

let writingDurationPromise = null;
const getWritingDuration = () => {
  if (!writingDurationPromise) writingDurationPromise = gifLoopDurationMs(writingGif);
  return writingDurationPromise;
};

let thinkingDurationPromise = null;
const getThinkingDuration = () => {
  if (!thinkingDurationPromise) thinkingDurationPromise = gifLoopDurationMs(thinkingGif);
  return thinkingDurationPromise;
};

// The little tail mascot, which reflects the model's state:
//   loading  -> thinking.gif  (sent, but not yet writing in the chat: routing,
//               memory query, reasoning)
//   writing  -> writing.gif   (actively streaming tokens into the bubble)
//   idle     -> tail_wiggle    static for 10s, then plays exactly one loop
//               (frame 1 -> frame 1), then static again — repeating
//
// `displayMode` lags the requested `mode`: the thinking and writing gifs are
// never cut mid-loop — each plays out its current loop before the indicator
// switches to the next state's gif.
function AssistantIndicator({ mode }) {
  const [displayMode, setDisplayMode] = useState(mode);
  const [wiggling, setWiggling] = useState(false);
  const [playUrl, setPlayUrl] = useState(null); // fresh object URL per idle play
  const [still, setStill] = useState(null); // frozen frame-1 data URL
  const tailDurationRef = useRef(IDLE_WIGGLE_MS);
  // Loop durations of the gifs that must finish before switching away.
  const loopDurationsRef = useRef({ loading: null, writing: null });
  const startedAtRef = useRef(performance.now()); // when the current gif started
  const wroteRef = useRef(false); // did this turn produce output (enter writing)?
  const blobRef = useRef(null);   // the tail gif Blob, for minting fresh URLs
  const playUrlRef = useRef(null); // current object URL (to revoke)

  useEffect(() => {
    let active = true;
    getTailDuration().then((ms) => { if (active && ms) tailDurationRef.current = ms; });
    getThinkingDuration().then((ms) => { if (active && ms) loopDurationsRef.current.loading = ms; });
    getWritingDuration().then((ms) => { if (active && ms) loopDurationsRef.current.writing = ms; });
    getTailStill().then((url) => { if (active) setStill(url); });
    getTailBlob().then((b) => { if (active) blobRef.current = b; });
    return () => {
      active = false;
      if (playUrlRef.current) URL.revokeObjectURL(playUrlRef.current);
    };
  }, []);

  // Remember that the turn reached the writing phase, so we always show the
  // writing gif (for >= 1 full loop) even when the response streams faster than
  // one loop. Cleared once we settle back to idle.
  useEffect(() => { if (mode === 'writing') wroteRef.current = true; }, [mode]);

  // Reset the play clock whenever the displayed gif changes (so the
  // finish-the-loop math below is measured from this gif's start).
  useEffect(() => {
    startedAtRef.current = performance.now();
    if (displayMode === 'idle') wroteRef.current = false;
  }, [displayMode]);

  // The next gif to show after the current one. Crucially, after loading we
  // route through writing whenever the turn produced output — so a fast reply
  // never skips straight from thinking to idle.
  const nextDisplay = (current, requested) => {
    if (current === 'loading' && (wroteRef.current || requested === 'writing')) return 'writing';
    return requested;
  };

  // Advance displayMode toward the requested mode, letting the thinking/writing
  // gif finish its current loop before switching (so neither is cut mid-loop,
  // and writing always plays at least one full loop).
  useEffect(() => {
    const target = nextDisplay(displayMode, mode);
    if (target === displayMode) return undefined;
    const dur = loopDurationsRef.current[displayMode];
    if (dur) {
      const elapsed = performance.now() - startedAtRef.current;
      const remaining = dur - (elapsed % dur); // time left in the current loop
      const t = setTimeout(() => setDisplayMode(target), remaining);
      return () => clearTimeout(t);
    }
    setDisplayMode(target);
    return undefined;
  }, [mode, displayMode]);

  useEffect(() => {
    if (displayMode !== 'idle') {
      setWiggling(false);
      return undefined;
    }
    let waitTimer;
    let stopTimer;
    let cancelled = false;
    const loop = () => {
      // Disabled (static) for 10s...
      waitTimer = setTimeout(() => {
        if (cancelled) return;
        // ...then play exactly one loop from a guaranteed frame 1 by minting a
        // fresh object URL (a new resource decodes from the start)...
        if (blobRef.current) {
          if (playUrlRef.current) URL.revokeObjectURL(playUrlRef.current);
          playUrlRef.current = URL.createObjectURL(blobRef.current);
          setPlayUrl(playUrlRef.current);
        }
        setWiggling(true);
        stopTimer = setTimeout(() => {
          if (cancelled) return;
          setWiggling(false); // ...and disable again, then repeat.
          loop();
        }, tailDurationRef.current);
      }, IDLE_WIGGLE_EVERY_MS);
    };
    setWiggling(false);
    loop();
    return () => { cancelled = true; clearTimeout(waitTimer); clearTimeout(stopTimer); };
  }, [displayMode]);

  if (displayMode === 'loading') {
    return <img src={thinkingGif} className="assistant-indicator-gif" alt="Thinking…" draggable="false" />;
  }
  if (displayMode === 'writing') {
    return <img src={writingGif} className="assistant-indicator-gif" alt="Writing…" draggable="false" />;
  }
  // idle: a fresh object URL each play guarantees a frame-1 start; the rest
  // state is the frozen frame-1 still, so there's no drift between plays.
  return wiggling
    ? <img key={playUrl} src={playUrl || tailWiggleGif} className="assistant-indicator-gif" alt="" draggable="false" />
    : <img src={still || tailWiggleGif} className="assistant-indicator-gif" alt="" draggable="false" />;
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
  liveRoutingFiles, // files routing is reading live (only set on the in-flight turn)
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

  // Live tags during the in-flight turn. Prefer the routing WebSocket feed
  // (liveRoutingFiles) so they reveal as routing decides each file in phase 1;
  // fall back to the files the response header reports, so they still show even
  // if the WS update lands late. The block renders only when memory is actually
  // used: live tags present, or the final activity has files.
  const isActiveTurn = isLastAssistant && isResponding;
  const wsFiles = liveRoutingFiles || [];
  const headerFiles = message.brain_activity?.files_read || [];
  const liveFiles = isActiveTurn ? (wsFiles.length > 0 ? wsFiles : headerFiles) : [];
  const showBrain = message.role === 'assistant'
    && (message.brain_activity || liveFiles.length > 0);
  const brainActivityBlock = showBrain ? (
    <BrainActivityBlock activity={message.brain_activity} liveFiles={liveFiles} live={isActiveTurn} />
  ) : null;

  // Indicator state: loading until the model writes the answer, writing while it
  // streams, idle otherwise. (parsed.answer is empty during routing/reasoning.)
  const indicatorMode = isResponding && isLastAssistant
    ? (parsed.answer ? 'writing' : 'loading')
    : 'idle';

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
          {isLastAssistant && <AssistantIndicator mode={indicatorMode} />}
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
