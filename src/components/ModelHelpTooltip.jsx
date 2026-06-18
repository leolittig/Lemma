// The little "?" next to the Model title in Settings. Hovering (desktop) or
// tapping (mobile) reveals a speech-bubble explaining model selection and
// listing the two recommended models. Each name links to its Hugging Face page,
// and the download icon beside it opens the Add Model dialog pre-filled with
// that repo id (via onPickRecommended, wired to the picker's onAddModel).
//
// The bubble is rendered through a portal on document.body with fixed
// positioning, so the Settings modal's `overflow: hidden` can't clip it. It
// prefers to sit above the "?"; if there isn't room up top it flips below.

import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

const HF_BASE = 'https://huggingface.co/';

const RECOMMENDED = [
  { repo: 'unsloth/gemma-4-12B-it-qat-GGUF', label: 'GGUF — Linux / Windows' },
  { repo: 'mlx-community/gemma-4-12B-it-8bit', label: 'MLX — macOS / Apple Silicon' },
];

const GAP = 8;       // space between the "?" and the bubble
const MARGIN = 8;    // keep the bubble at least this far from the viewport edge

export default function ModelHelpTooltip({ onPickRecommended }) {
  // Shown on hover (desktop) or while pinned by a click/tap (works on mobile,
  // where there is no hover). Either one keeps the bubble open.
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState(null); // {left, top, placement, arrowLeft}
  const btnRef = useRef(null);
  const bubbleRef = useRef(null);
  const hideTimer = useRef(null);
  const show = hovered || pinned;

  // The bubble lives in a portal (not inside this element), so moving the
  // cursor from the "?" onto the bubble would otherwise count as "leaving".
  // Track hover across both with a short close delay that re-entering cancels.
  const enter = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setHovered(true);
  };
  const leave = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHovered(false), 120);
  };

  // Place the bubble relative to the "?". Prefer above; flip below when the
  // bubble wouldn't clear the top of the viewport. Clamp horizontally so it
  // never runs off-screen.
  const updatePosition = useCallback(() => {
    const btn = btnRef.current;
    const bubble = bubbleRef.current;
    if (!btn || !bubble) return;
    const b = btn.getBoundingClientRect();
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;

    let placement = 'above';
    let top = b.top - GAP - bh;
    if (top < MARGIN) {
      placement = 'below';
      top = b.bottom + GAP;
    }

    let left = b.left;
    const maxLeft = window.innerWidth - MARGIN - bw;
    if (left > maxLeft) left = maxLeft;
    if (left < MARGIN) left = MARGIN;

    const center = b.left + b.width / 2;
    const arrowLeft = Math.max(10, Math.min(bw - 18, center - left));
    setPos({ left, top, placement, arrowLeft });
  }, []);

  // Recompute after the bubble mounts, and keep it pinned to the "?" while the
  // modal scrolls or the window resizes.
  useLayoutEffect(() => {
    if (!show) { setPos(null); return; }
    updatePosition();
    const onMove = () => updatePosition();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [show, updatePosition]);

  // While pinned, a click outside both the "?" and the bubble dismisses it.
  useEffect(() => {
    if (!pinned) return;
    const onDocClick = (e) => {
      if (btnRef.current?.contains(e.target) || bubbleRef.current?.contains(e.target)) return;
      setPinned(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [pinned]);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  const pick = (repo) => {
    setPinned(false);
    setHovered(false);
    onPickRecommended(repo);
  };

  const bubble = show ? createPortal(
    <div
      ref={bubbleRef}
      className={`model-help-bubble ${pos ? `placement-${pos.placement}` : ''}`}
      role="tooltip"
      style={pos
        ? { left: `${pos.left}px`, top: `${pos.top}px` }
        : { left: 0, top: 0, visibility: 'hidden' }}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      <p className="model-help-text">
        Choose the model that powers the whole system. Recommended and tested
        models:
      </p>
      <ul className="model-help-list">
        {RECOMMENDED.map((r) => (
          <li key={r.repo} className="model-help-item">
            <span className="model-help-note">{r.label}:</span>
            <div className="model-help-item-main">
              <a
                className="model-help-link"
                href={HF_BASE + r.repo}
                target="_blank"
                rel="noreferrer"
              >
                {r.repo}
              </a>
              <button
                type="button"
                className="model-help-dl"
                title={`Add ${r.repo}`}
                aria-label={`Add ${r.repo}`}
                onClick={() => pick(r.repo)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="2"
                     strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </button>
            </div>
          </li>
        ))}
      </ul>
      {pos && (
        <span className="model-help-arrow" style={{ left: `${pos.arrowLeft}px` }} />
      )}
    </div>,
    document.body,
  ) : null;

  return (
    <span className="model-help">
      <button
        type="button"
        ref={btnRef}
        className="model-help-btn"
        aria-label="About model selection"
        aria-expanded={show}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onClick={() => setPinned((v) => !v)}
      >
        ?
      </button>
      {bubble}
    </span>
  );
}
