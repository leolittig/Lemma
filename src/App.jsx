import React, { useState, useRef, useEffect } from 'react';
import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import katex from 'katex';
import 'katex/dist/katex.min.css';

// Configure marked to parse LaTeX math formulas using KaTeX
marked.use(markedKatex({
  throwOnError: false
}));

// Helper to format the model name according to rules
const formatModelName = (name) => {
  if (!name) return '';
  const baseName = name.split('/').pop() || name;
  const parts = baseName.split('-');
  return parts
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
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

export default function App() {
  const [history, setHistory] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isResponding, setIsResponding] = useState(false);
  const [modelName, setModelName] = useState('mlx-community/gemma-4-12B-it-8bit');
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const [showSettings, setShowSettings] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState(() => localStorage.getItem('system_prompt') || '');
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
        body: JSON.stringify({ model: selectedModel }),
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

  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const messagesContainerRef = useRef(null);

  const scrollToBottom = (behavior = 'auto') => {
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: behavior
      });
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior });
    }
  };

  const handleScroll = () => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const threshold = 15;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
    setShouldAutoScroll((prev) => (prev !== atBottom ? atBottom : prev));
  };

  useEffect(() => {
    if (shouldAutoScroll) {
      scrollToBottom(isResponding ? 'auto' : 'smooth');
    }
  }, [history, shouldAutoScroll]);

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

  const handleSubmit = async (e) => {
    e.preventDefault();
    const text = inputText.trim();
    if (!text || isResponding) return;

    setInputText('');
    setHistory((prev) => [...prev, { role: 'user', text }]);
    setShouldAutoScroll(true);
    setIsResponding(true);

    try {
      const res = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
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
            <span className="model-title">{formatModelName(modelName)}</span>
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
      <div id="messages" ref={messagesContainerRef} onScroll={handleScroll}>
        {history.map((msg, index) => {
          const isLast = index === history.length - 1;
          const isStreaming = isLast && msg.role === 'assistant' && isResponding;

          if (isStreaming) {
            const tokens = marked.lexer(msg.text);
            return (
              <div key={index} className="assistant">
                {renderTokens(tokens, `msg-${index}`)}
              </div>
            );
          }

          return (
            <div
              key={index}
              className={msg.role}
              dangerouslySetInnerHTML={{ __html: marked.parse(msg.text) }}
            />
          );
        })}
        <div ref={messagesEndRef} />
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
              <label className="settings-label">Identity</label>
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
            <div className="settings-actions">
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
              <h3 className="settings-title">Add Hugging Face Model</h3>
              <button className="close-btn" onClick={() => setShowAddModel(false)} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', padding: '1.5rem', width: '100%', boxSizing: 'border-box' }}>
              <div className="settings-field" style={{ margin: '0' }}>
                <label className="settings-label">Hugging Face Repository ID</label>
                <div style={{ display: 'flex', gap: '0.75rem', width: '100%', alignItems: 'center' }}>
                  <input
                    type="text"
                    placeholder="e.g., mlx-community/gemma-4-e4b-it-4bit"
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
                      borderRadius: '0.8rem',
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
                      borderRadius: '2rem',
                      padding: '0.75rem 1.4rem',
                      fontSize: '0.95rem',
                      fontWeight: '600',
                      flexShrink: 0
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
