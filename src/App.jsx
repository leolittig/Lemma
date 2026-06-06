import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import katex from 'katex';
import 'katex/dist/katex.min.css';

// Configure marked to parse LaTeX math formulas using KaTeX
marked.use(markedKatex({
  throwOnError: false
}));

// Render the model name for the app bar. Each '-' separated word is normally
// capitalised, but once a word ends with the letter 'b' (case insensitive) that
// word and every word after it are dimmed and left in their original casing.
const renderModelName = (name) => {
  if (!name) return null;
  const baseName = name.split('/').pop() || name;
  const parts = baseName.split('-');
  let dim = false;
  return parts.map((word, i) => {
    if (!dim && /b$/i.test(word)) dim = true;
    const text = dim ? word : word.charAt(0).toUpperCase() + word.slice(1);
    return (
      <span key={i} className={dim ? 'model-name-dim' : undefined}>
        {text}{i < parts.length - 1 ? ' ' : ''}
      </span>
    );
  });
};

// Helper to decode HTML entities created by marked
const decodeEntities = (text) => {
  if (!text) return '';
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
};

// Recursive token renderer for streaming markdown to allow word-by-word fade in without blinking
const renderTextWords = (text, keyPath) => {
  const decodedText = decodeEntities(text);
  const words = decodedText.split(/(\s+)/);
  return words.map((word, index) => {
    if (/^\s+$/.test(word)) {
      return <span key={`${keyPath}-w-${index}`}>{word}</span>;
    }
    return (
      <span key={`${keyPath}-w-${index}-${word}`} className="word-fade">
        {word}
      </span>
    );
  });
};

const renderToken = (token, keyPath) => {
  switch (token.type) {
    case 'paragraph':
      return <p key={keyPath}>{renderTokens(token.tokens, `${keyPath}-p`)}</p>;
    case 'heading': {
      const Tag = `h${token.depth}`;
      return <Tag key={keyPath}>{renderTokens(token.tokens, `${keyPath}-h`)}</Tag>;
    }
    case 'list': {
      const Tag = token.ordered ? 'ol' : 'ul';
      return <Tag key={keyPath}>{renderTokens(token.items, `${keyPath}-l`)}</Tag>;
    }
    case 'list_item':
      return <li key={keyPath}>{renderTokens(token.tokens, `${keyPath}-li`)}</li>;
    case 'strong':
      return <strong key={keyPath}>{renderTokens(token.tokens, `${keyPath}-strong`)}</strong>;
    case 'em':
      return <em key={keyPath}>{renderTokens(token.tokens, `${keyPath}-em`)}</em>;
    case 'codespan':
      return <code key={keyPath}>{decodeEntities(token.text)}</code>;
    case 'code':
      return (
        <pre key={keyPath}>
          <code>{decodeEntities(token.text)}</code>
        </pre>
      );
    case 'br':
      return <br key={keyPath} />;
    case 'space':
      return null;
    case 'hr':
      return <hr key={keyPath} />;
    case 'blockquote':
      return <blockquote key={keyPath}>{renderTokens(token.tokens, `${keyPath}-bq`)}</blockquote>;
    case 'link':
      return (
        <a
          key={keyPath}
          href={token.href}
          title={token.title || undefined}
          target="_blank"
          rel="noopener noreferrer"
        >
          {renderTokens(token.tokens, `${keyPath}-a`)}
        </a>
      );
    case 'image':
      return <img key={keyPath} src={token.href} alt={token.text} title={token.title || undefined} />;
    case 'del':
      return <del key={keyPath}>{renderTokens(token.tokens, `${keyPath}-del`)}</del>;
    case 'escape':
      return <span key={keyPath}>{decodeEntities(token.text)}</span>;
    case 'inlineMath':
      return (
        <span
          key={keyPath}
          dangerouslySetInnerHTML={{
            __html: katex.renderToString(token.text, { displayMode: false, throwOnError: false })
          }}
        />
      );
    case 'blockMath':
      return (
        <div
          key={keyPath}
          dangerouslySetInnerHTML={{
            __html: katex.renderToString(token.text, { displayMode: true, throwOnError: false })
          }}
        />
      );
    case 'table':
      return (
        <div key={keyPath} className="table-container">
          <table>
            <thead>
              <tr>
                {token.header.map((cell, colIndex) => {
                  const align = token.align[colIndex];
                  const style = align ? { textAlign: align } : {};
                  return (
                    <th key={`${keyPath}-th-${colIndex}`} style={style}>
                      {cell.tokens ? renderTokens(cell.tokens, `${keyPath}-th-${colIndex}-c`) : cell.text}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {token.rows.map((row, rowIndex) => (
                <tr key={`${keyPath}-tr-${rowIndex}`}>
                  {row.map((cell, colIndex) => {
                    const align = token.align[colIndex];
                    const style = align ? { textAlign: align } : {};
                    return (
                      <td key={`${keyPath}-td-${rowIndex}-${colIndex}`} style={style}>
                        {cell.tokens ? renderTokens(cell.tokens, `${keyPath}-td-${rowIndex}-${colIndex}-c`) : cell.text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'text':
      if (token.tokens) {
        return renderTokens(token.tokens, `${keyPath}-t`);
      }
      return renderTextWords(token.text, keyPath);
    default:
      return <span key={keyPath}>{decodeEntities(token.text || token.raw)}</span>;
  }
};

const renderTokens = (tokens, keyPrefix) => {
  if (!tokens) return null;
  return tokens.map((token, index) => renderToken(token, `${keyPrefix}-${index}`));
};

const adjustTextareaHeight = (textarea) => {
  if (!textarea) return;
  textarea.style.height = 'auto';
  const scrollHeight = textarea.scrollHeight;
  // Ensure height is at least 48px, and add 2px to account for the border in border-box styling.
  const targetHeight = Math.max(48, scrollHeight + 2);
  textarea.style.height = `${targetHeight}px`;
  
  // Hide scrollbar if it hasn't reached max-height (200px)
  if (targetHeight >= 200) {
    textarea.style.overflowY = 'auto';
  } else {
    textarea.style.overflowY = 'hidden';
  }
};

// Discrete context-window options (tokens). The slider snaps to these by index;
// the default is the middle step. Doubling each step keeps the low end (where
// most useful values live) as well-spaced as the high end.
const CTX_STEPS = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];
const CTX_DEFAULT_INDEX = Math.floor(CTX_STEPS.length / 2); // 4 → 8192

export default function App() {
  const [history, setHistory] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isResponding, setIsResponding] = useState(false);
  const [modelName, setModelName] = useState('mlx-community/gemma-4-12B-it-8bit');
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const [showSettings, setShowSettings] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState(() => localStorage.getItem('system_prompt') || '');
  // Generation params sent with each /chat message. Persisted to localStorage so
  // they survive reloads. Temperature defaults to 1.0; context window is a string
  // ('' = unlimited) so the field can be cleared.
  const [temperature, setTemperature] = useState(() => {
    const saved = localStorage.getItem('temperature');
    return saved !== null ? parseFloat(saved) : 1.0;
  });
  const [contextSize, setContextSize] = useState(() => {
    const saved = localStorage.getItem('context_size');
    return saved !== null ? saved : String(CTX_STEPS[CTX_DEFAULT_INDEX]);
  });
  const settingsTextareaRef = useRef(null);
  const overlayMouseDownRef = useRef(false);

  const [availableModels, setAvailableModels] = useState([]);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [isChangingModel, setIsChangingModel] = useState(false);
  const modelSelectorRef = useRef(null);

  const [downloads, setDownloads] = useState({});
  const [showAddModel, setShowAddModel] = useState(false);
  const [newModelRepo, setNewModelRepo] = useState('');

  const handleOverlayMouseDown = (e) => {
    overlayMouseDownRef.current = (e.target === e.currentTarget);
  };

  const handleOverlayMouseUp = (e) => {
    if (e.target === e.currentTarget && overlayMouseDownRef.current) {
      setShowSettings(false);
    }
  };

  const addModelOverlayMouseDownRef = useRef(false);

  const handleAddModelOverlayMouseDown = (e) => {
    addModelOverlayMouseDownRef.current = (e.target === e.currentTarget);
  };

  const handleAddModelOverlayMouseUp = (e) => {
    if (e.target === e.currentTarget && addModelOverlayMouseDownRef.current) {
      setShowAddModel(false);
    }
  };

  useEffect(() => {
    adjustTextareaHeight(settingsTextareaRef.current);
    const timer = setTimeout(() => {
      adjustTextareaHeight(settingsTextareaRef.current);
    }, 50);
    return () => clearTimeout(timer);
  }, [systemPrompt, showSettings]);

  // Persist generation params live so they survive reloads and apply to the
  // next message without needing a restart.
  useEffect(() => {
    localStorage.setItem('temperature', String(temperature));
  }, [temperature]);

  useEffect(() => {
    if (contextSize === '') localStorage.removeItem('context_size');
    else localStorage.setItem('context_size', contextSize);
  }, [contextSize]);

  // Fetch active model and available models list on mount with auto-retry if backend is starting up
  useEffect(() => {
    let isMounted = true;
    let retryTimeoutId;

    const fetchInitialData = async () => {
      try {
        // Fetch current active model
        const modelRes = await fetch('/model');
        if (!modelRes.ok) throw new Error('Model fetch failed');
        const modelData = await modelRes.json();
        if (modelData.model && isMounted) {
          setModelName(modelData.model);
        }

        // Fetch all available models
        const modelsRes = await fetch('/models');
        if (!modelsRes.ok) throw new Error('Models fetch failed');
        const modelsData = await modelsRes.json();
        if (modelsData.models && isMounted) {
          setAvailableModels(modelsData.models);
        }
      } catch (err) {
        console.error('Error fetching models data (backend might still be starting up), retrying in 2s...', err);
        if (isMounted) {
          retryTimeoutId = setTimeout(fetchInitialData, 2000);
        }
      }
    };

    fetchInitialData();

    return () => {
      isMounted = false;
      if (retryTimeoutId) clearTimeout(retryTimeoutId);
    };
  }, []);

  // Handle click outside model selector to close dropdown
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (modelSelectorRef.current && !modelSelectorRef.current.contains(e.target)) {
        setShowModelPicker(false);
      }
    };
    if (showModelPicker) {
      document.addEventListener('click', handleClickOutside);
    }
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [showModelPicker]);

  // Polling for model download progress
  useEffect(() => {
    const hasActive = Object.values(downloads).some(
      (d) => d.status === 'downloading'
    );
    if (!hasActive) return;

    let timeoutId;
    let isMounted = true;

    const poll = async () => {
      try {
        const res = await fetch('/download/status');
        const data = await res.json();
        if (!isMounted) return;

        if (data.downloads) {
          setDownloads(data.downloads);

          // Update models list if any completed
          let shouldRefresh = false;
          Object.entries(data.downloads).forEach(([repo, dl]) => {
            if (dl.status === 'completed' && !availableModels.includes(repo)) {
              shouldRefresh = true;
            }
          });

          if (shouldRefresh) {
            const mRes = await fetch('/models');
            const mData = await mRes.json();
            if (mData.models && isMounted) {
              setAvailableModels(mData.models);
            }
          }

          const stillActive = Object.values(data.downloads).some(
            (d) => d.status === 'downloading'
          );
          if (stillActive) {
            timeoutId = setTimeout(poll, 1500);
          }
        }
      } catch (err) {
        console.error('Error polling download status:', err);
        if (isMounted) timeoutId = setTimeout(poll, 2000);
      }
    };

    timeoutId = setTimeout(poll, 1500);

    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
    };
  }, [availableModels, downloads]);

  const handleModelSelect = async (selectedModel) => {
    if (selectedModel === modelName || isChangingModel) return;
    setIsChangingModel(true);
    setShowModelPicker(false);
    try {
      const res = await fetch('/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: selectedModel, system_prompt: systemPrompt }),
      });
      if (res.ok) {
        setModelName(selectedModel);
        setHistory([]); // Reset conversation when active model changes
        setIsResponding(false); // Reset responding state if model changed
      }
    } catch (err) {
      console.error('Error changing model:', err);
    } finally {
      setIsChangingModel(false);
    }
  };

  const handleToggleModelPicker = async () => {
    const nextState = !showModelPicker;
    setShowModelPicker(nextState);
    if (nextState) {
      try {
        const modelsRes = await fetch('/models');
        if (modelsRes.ok) {
          const modelsData = await modelsRes.json();
          if (modelsData.models) {
            setAvailableModels(modelsData.models);
          }
        }
      } catch (err) {
        console.error('Error updating models list:', err);
      }
    }
  };

  const handleStartDownload = async () => {
    // Sanitize in the frontend by removing any hidden or non-repo characters
    const repo = newModelRepo.replace(/[^a-zA-Z0-9\-._/]/g, '').trim();
    if (!repo) return;

    setShowAddModel(false);
    setNewModelRepo('');
    
    // Add initial placeholder to downloads state to trigger polling
    setDownloads((prev) => ({
      ...prev,
      [repo]: { status: 'downloading', progress: 0.0, downloaded_bytes: 0, total_bytes: 0, error_message: '' }
    }));
    setShowModelPicker(true);

    try {
      const res = await fetch('/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: repo }),
      });
      if (!res.ok) {
        let errMsg = 'Failed to start download.';
        try {
          const contentType = res.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            const errData = await res.json();
            errMsg = errData.message || errData.detail || errMsg;
          } else {
            const text = await res.text();
            errMsg = text.substring(0, 100) || errMsg;
          }
        } catch (e) {
          // ignore parsing error and keep default
        }
        setDownloads((prev) => ({
          ...prev,
          [repo]: { status: 'error', progress: 0.0, downloaded_bytes: 0, total_bytes: 0, error_message: errMsg }
        }));
        return;
      }
    } catch (err) {
      setDownloads((prev) => ({
        ...prev,
        [repo]: { status: 'error', progress: 0.0, downloaded_bytes: 0, total_bytes: 0, error_message: err.message || 'Failed to connect.' }
      }));
    }
  };

  useEffect(() => {
    adjustTextareaHeight(textareaRef.current);
  }, [inputText]);

  // Auto-scroll lock: the view stays pinned to the newest message, easing
  // toward the bottom with a slow, smooth animation that keeps up with both new
  // messages and streaming tokens. It disengages the moment the user scrolls up
  // to read older messages, and re-engages once they scroll all the way back
  // down to the bottom.
  const messagesContainerRef = useRef(null);
  const isLockedRef = useRef(true);
  const scrollRafRef = useRef(null);

  // Per-frame catch-up fraction. Lower = slower and smoother. A far-behind
  // jump uses a larger factor so the newest content never drops out of view.
  const SCROLL_EASE = 0.085;
  const SCROLL_EASE_FAR = 0.25;
  const BOTTOM_THRESHOLD = 15;

  const stopScrollAnimation = () => {
    if (scrollRafRef.current != null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
  };

  const animateScrollToBottom = () => {
    const container = messagesContainerRef.current;
    if (!container || !isLockedRef.current) {
      scrollRafRef.current = null;
      return;
    }

    const target = container.scrollHeight - container.clientHeight;
    const distance = target - container.scrollTop;

    // Close enough — settle exactly on the bottom and idle until new content.
    if (Math.abs(distance) < 0.5) {
      container.scrollTop = target;
      scrollRafRef.current = null;
      return;
    }

    const factor = distance > container.clientHeight ? SCROLL_EASE_FAR : SCROLL_EASE;
    container.scrollTop = container.scrollTop + distance * factor;
    scrollRafRef.current = requestAnimationFrame(animateScrollToBottom);
  };

  const ensureScrollAnimation = () => {
    if (isLockedRef.current && scrollRafRef.current == null) {
      scrollRafRef.current = requestAnimationFrame(animateScrollToBottom);
    }
  };

  const isAtBottom = () => {
    const container = messagesContainerRef.current;
    if (!container) return true;
    return container.scrollHeight - container.scrollTop - container.clientHeight <= BOTTOM_THRESHOLD;
  };

  // Programmatic scrolling never fires wheel/touch events, so these handlers
  // only ever see genuine user gestures — a reliable way to break the lock.
  const handleWheel = (e) => {
    if (e.deltaY < 0 && isLockedRef.current) {
      isLockedRef.current = false;
      stopScrollAnimation();
    }
  };

  const handleTouchMove = () => {
    if (isLockedRef.current && !isAtBottom()) {
      isLockedRef.current = false;
      stopScrollAnimation();
    }
  };

  // Re-engage the lock the instant the user returns to the very bottom.
  const handleScroll = () => {
    if (!isLockedRef.current && isAtBottom()) {
      isLockedRef.current = true;
      ensureScrollAnimation();
    }
  };

  // Follow new messages and streaming tokens while the lock is engaged.
  useEffect(() => {
    ensureScrollAnimation();
  }, [history]);

  // Clean up the animation frame on unmount.
  useEffect(() => stopScrollAnimation, []);

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

  // FLIP reflow: before the list is long enough to scroll, the container is
  // bottom-anchored, so appending a message shoves the existing bubbles upward
  // in a single instant jump. We record each bubble's position before the new
  // one lands and animate it from its old spot to its new spot, so the whole
  // stack slides up smoothly instead of snapping. (Once the list overflows, the
  // scroll loop preserves viewport positions, so deltas are ~0 and this no-ops.)
  const messageRefs = useRef(new Map());
  const prevTopsRef = useRef(new Map());
  const prevMsgCountRef = useRef(0);

  const registerMessageRef = (key) => (el) => {
    if (el) messageRefs.current.set(key, el);
    else messageRefs.current.delete(key);
  };

  useLayoutEffect(() => {
    const grew = history.length > prevMsgCountRef.current;
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
    prevMsgCountRef.current = history.length;
  }, [history]);

  const handleRestart = async () => {
    try {
      const res = await fetch('/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system_prompt: systemPrompt }),
      });
      if (res.ok) {
        localStorage.setItem('system_prompt', systemPrompt);
        setHistory([]);
        setShowSettings(false);
      }
    } catch (err) {
      console.error('Error restarting chat:', err);
    }
  };

  // Re-load the currently active model. Unlike handleModelSelect this doesn't
  // bail when the target equals the current model, so it forces a fresh load,
  // applying the current system prompt and resetting the conversation.
  const handleReloadModel = async () => {
    if (isChangingModel) return;
    setIsChangingModel(true);
    setShowSettings(false);
    try {
      const res = await fetch('/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName, system_prompt: systemPrompt }),
      });
      if (res.ok) {
        localStorage.setItem('system_prompt', systemPrompt);
        setHistory([]);
        setIsResponding(false);
      }
    } catch (err) {
      console.error('Error reloading model:', err);
    } finally {
      setIsChangingModel(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const text = inputText.trim();
    if (!text || isResponding) return;

    setInputText('');
    setHistory((prev) => [...prev, { role: 'user', text }]);
    isLockedRef.current = true;
    ensureScrollAnimation();
    setIsResponding(true);

    try {
      const parsedContext = parseInt(contextSize, 10);
      const res = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          temperature,
          // '' or non-numeric => null, i.e. unlimited context window.
          max_kv_size: Number.isFinite(parsedContext) && parsedContext > 0 ? parsedContext : null,
        }),
      });

      if (!res.ok) {
        throw new Error(`Server returned status ${res.status}`);
      }

      // Add a placeholder message for the assistant that we will update with streamed content
      setHistory((prev) => [...prev, { role: 'assistant', text: '' }]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let reply = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        reply += decoder.decode(value, { stream: true });

        setHistory((prev) => {
          const updated = [...prev];
          if (updated.length > 0) {
            updated[updated.length - 1] = { role: 'assistant', text: reply };
          }
          return updated;
        });
      }
    } catch (error) {
      console.error('Error fetching chat response:', error);
    } finally {
      setIsResponding(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isResponding) return;
      // Submit the form programmatically
      const form = e.target.form;
      if (form) {
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      }
    }
  };

  // Derive the context-window slider position (an index into CTX_STEPS) from the
  // saved token count, falling back to the middle step for anything unrecognised.
  const ctxIndexRaw = CTX_STEPS.indexOf(parseInt(contextSize, 10));
  const ctxIndex = ctxIndexRaw === -1 ? CTX_DEFAULT_INDEX : ctxIndexRaw;
  const ctxTokens = CTX_STEPS[ctxIndex];

  return (
    <div className="app-container">
      <header className="top-bar">
        <div className="model-selector-wrapper" ref={modelSelectorRef}>
          <button
            className={`model-picker-toggle ${showModelPicker ? 'active' : ''}`}
            onClick={handleToggleModelPicker}
            aria-label="Select model"
            disabled={isChangingModel}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="chevron-icon">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          <span className="model-title-container">
            <span className="model-title">{renderModelName(modelName)}</span>
            <span className="model-tooltip">{modelName}</span>
          </span>
          {showModelPicker && (
            <div className="model-picker-dropdown">
              {availableModels.map((m) => (
                <button
                  key={m}
                  className={`model-picker-item ${m === modelName ? 'selected' : ''}`}
                  onClick={() => handleModelSelect(m)}
                >
                  <span className="model-item-full">{m}</span>
                  {m === modelName && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="check-icon">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  )}
                </button>
              ))}
              
              {/* Show active or failed downloads */}
              {Object.entries(downloads).map(([repo, dl]) => {
                if (dl.status === 'completed' || availableModels.includes(repo)) {
                  return null;
                }
                return (
                  <div key={repo} className="model-picker-download-item">
                    <div className="model-download-info">
                      <span className="model-item-full" title={repo}>{repo}</span>
                      {dl.status === 'downloading' && (
                        <span className="model-download-percent">{dl.progress}%</span>
                      )}
                    </div>
                    {dl.status === 'downloading' && (
                      <div className="model-download-progress-bg">
                        <div className="model-download-progress-bar" style={{ width: `${dl.progress}%` }}></div>
                      </div>
                    )}
                    {dl.status === 'error' && (
                      <div className="model-download-error">
                        <span>Error: {dl.error_message}</span>
                        <button
                          className="model-download-dismiss-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDownloads((prev) => {
                              const copy = { ...prev };
                              delete copy[repo];
                              return copy;
                            });
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              
              <button
                className="model-picker-add-btn"
                onClick={() => {
                  setShowModelPicker(false);
                  setShowAddModel(true);
                }}
                aria-label="Add Model"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
              </button>
            </div>
          )}
        </div>
        <button className="settings-btn" onClick={() => setShowSettings(true)} aria-label="Open settings">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        </button>
      </header>
      <div className="messages-area">
      <div
        id="messages"
        ref={messagesContainerRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onTouchMove={handleTouchMove}
      >
        {history.map((msg, index) => {
          const isLast = index === history.length - 1;
          const isStreaming = isLast && msg.role === 'assistant' && isResponding;

          // Deterministic random vertical offset based on index (between -40px and +40px)
          const randomY = Math.floor((Math.sin(index * 12.9898) * 0.5 + 0.5) * 80) - 40;
          const inlineStyle = { '--random-y': `${randomY}px` };

          if (isStreaming) {
            const tokens = marked.lexer(msg.text);
            return (
              <div key={index} ref={registerMessageRef(index)} className="assistant" style={inlineStyle}>
                {renderTokens(tokens, `msg-${index}`)}
              </div>
            );
          }

          return (
            <div
              key={index}
              ref={registerMessageRef(index)}
              className={msg.role}
              style={inlineStyle}
              dangerouslySetInnerHTML={{ __html: marked.parse(msg.text) }}
            />
          );
        })}
        <div ref={messagesEndRef} />
      </div>
        <div className="messages-fade" aria-hidden="true" />
      </div>
      <form onSubmit={handleSubmit}>
        <textarea
          ref={textareaRef}
          value={inputText}
          onChange={(e) => {
            setInputText(e.target.value);
            adjustTextareaHeight(e.target);
          }}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <button type="submit" disabled={isResponding}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="5" y1="12" x2="19" y2="12"></line>
            <polyline points="12 5 19 12 12 19"></polyline>
          </svg>
        </button>
      </form>

      <div
        className={`settings-overlay ${showSettings ? 'visible' : ''}`}
        onMouseDown={handleOverlayMouseDown}
        onMouseUp={handleOverlayMouseUp}
      >
        <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
          <div className="settings-header">
            <h3 className="settings-title">Settings</h3>
            <button className="close-btn" onClick={() => setShowSettings(false)} aria-label="Close settings">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <div className="settings-body">
            <div className="settings-field">
              <label className="settings-label">Instructions</label>
              <textarea
                ref={settingsTextareaRef}
                className="settings-textarea"
                value={systemPrompt}
                onChange={(e) => {
                  setSystemPrompt(e.target.value);
                  adjustTextareaHeight(e.target);
                }}
                rows={1}
              />
            </div>
            <div className="settings-field">
              <div className="settings-label-row">
                <label className="settings-label">Temperature</label>
                <span className="settings-value">{temperature.toFixed(2)}</span>
              </div>
              <div className="slider-wrap">
                <div className="slider-track" />
                <div className="slider-ticks" aria-hidden="true">
                  <span className="slider-tick" style={{ left: '50%' }} />
                </div>
                <input
                  type="range"
                  className="settings-slider"
                  min="0"
                  max="2"
                  step="0.05"
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                />
              </div>
            </div>
            <div className="settings-field">
              <div className="settings-label-row">
                <label className="settings-label">Context Window</label>
                <span className="settings-value">{ctxTokens.toLocaleString()} tokens</span>
              </div>
              <div className="slider-wrap">
                <div className="slider-track" />
                <div className="slider-ticks" aria-hidden="true">
                  {CTX_STEPS.map((_, i) => (
                    <span
                      key={i}
                      className="slider-tick"
                      style={{ left: `${(i / (CTX_STEPS.length - 1)) * 100}%` }}
                    />
                  ))}
                </div>
                <input
                  type="range"
                  className="settings-slider"
                  min="0"
                  max={CTX_STEPS.length - 1}
                  step="1"
                  value={ctxIndex}
                  onChange={(e) => setContextSize(String(CTX_STEPS[parseInt(e.target.value, 10)]))}
                />
              </div>
            </div>
            <div className="settings-actions">
              <button className="settings-action-btn secondary" onClick={handleReloadModel}>
                Reload Model
              </button>
              <button className="settings-action-btn" onClick={handleRestart}>
                Restart Chat
              </button>
            </div>
          </div>
        </div>
      </div>
      {isChangingModel && (
        <div className="model-loading-overlay">
          <div className="model-loading-spinner"></div>
          <div className="model-loading-text">Loading Model...</div>
        </div>
      )}

      {showAddModel && (
        <div
          className="settings-overlay visible"
          onMouseDown={handleAddModelOverlayMouseDown}
          onMouseUp={handleAddModelOverlayMouseUp}
        >
          <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="settings-header">
              <h3 className="settings-title">Add Model</h3>
              <button className="close-btn" onClick={() => setShowAddModel(false)} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', padding: '1.5rem', width: '100%', boxSizing: 'border-box' }}>
              <div className="settings-field" style={{ margin: '0' }}>
                <label className="settings-label">Hugging Face Repo ID</label>
                <div style={{ display: 'flex', gap: '0.75rem', width: '100%', alignItems: 'center' }}>
                  <input
                    type="text"
                    placeholder="e.g.: mlx-community/model"
                    value={newModelRepo}
                    onChange={(e) => setNewModelRepo(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleStartDownload();
                      }
                    }}
                    style={{
                      flex: 1,
                      padding: '0.75rem 1.1rem',
                      borderRadius: '10rem',
                      border: '1px solid rgba(0, 0, 0, 0.12)',
                      fontSize: '1rem',
                      fontFamily: 'inherit',
                      outline: 'none',
                      boxShadow: '0 2px 6px rgba(0, 0, 0, 0.02)',
                      boxSizing: 'border-box'
                    }}
                  />
                  <button
                    type="button"
                    className="settings-action-btn"
                    onClick={handleStartDownload}
                    style={{
                      width: 'auto',
                      height: 'auto',
                      borderRadius: '10rem',
                      padding: '0.75rem 1.1rem',
                      fontSize: '1rem',
                      fontWeight: '400',
                      flexShrink: 0,
                      boxSizing: 'border-box'
                    }}
                  >
                    Download
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
