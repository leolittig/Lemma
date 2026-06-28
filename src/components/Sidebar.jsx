import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';

// Conversation history sidebar. Presentational: all state lives in App; this
// renders the list and emits select / new / rename / delete events.
export default function Sidebar({
  conversations,
  activeId,
  collapsed,
  onSelect,
  onRename,
  onDelete,
  profiles = [],
  activeProfile = 'default',
  onSwitchProfile,
  onCreateProfile,
  onDeleteProfile,
}) {
  // Which conversation is being renamed inline, and its draft title.
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState('');

  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const profileMenuRef = useRef(null);

  useEffect(() => {
    if (!showProfileMenu) return;
    const handleClickOutside = (e) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target)) {
        setShowProfileMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showProfileMenu]);

  const activeProfileObj = profiles.find(p => p.id === activeProfile) || { id: activeProfile, name: activeProfile };

  const getAvatarColor = (name) => {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash % 360);
    return `hsl(${hue}, 65%, 45%)`;
  };

  // FLIP reflow for the tile list: when a new chat is prepended (or the order
  // changes), each surviving tile is measured before and after the change, then
  // animated from its old position to its new one — so the list slides down
  // gracefully instead of snapping while the new tile flies in at the top.
  const itemRefs = useRef(new Map());
  const prevTopsRef = useRef(new Map());

  const registerItemRef = (id) => (el) => {
    if (el) itemRefs.current.set(id, el);
    else itemRefs.current.delete(id);
  };

  useLayoutEffect(() => {
    const newTops = new Map();
    itemRefs.current.forEach((el, id) => {
      if (el && el.isConnected) newTops.set(id, el.offsetTop);
    });
    newTops.forEach((newTop, id) => {
      const prevTop = prevTopsRef.current.get(id);
      if (prevTop === undefined) return; // brand-new tile — let it fly in
      const dy = prevTop - newTop;
      if (Math.abs(dy) < 0.5) return;
      const el = itemRefs.current.get(id);
      if (!el) return;
      // Drive the shift through a CSS var consumed by the inner pill AND the
      // ::before glow (see CSS), never the outer tile. Translating the outer
      // would make it a stacking context and let its glow ride over neighbours;
      // keeping the outer untransformed preserves the global glow-below-text
      // layering even mid-slide. `translate` composes with the entrance
      // `transform` without clobbering it.
      el.classList.remove('flip-playing');
      el.style.setProperty('--flip-dy', `${dy}px`);
      void el.offsetHeight;
      requestAnimationFrame(() => {
        el.classList.add('flip-playing');
        el.style.setProperty('--flip-dy', '0px');
      });
    });
    prevTopsRef.current = newTops;
  }, [conversations]);

  const startRename = (conv) => {
    setEditingId(conv.id);
    setDraft(conv.title || '');
  };

  const commitRename = () => {
    if (editingId) {
      const title = draft.trim();
      if (title) onRename(editingId, title);
    }
    setEditingId(null);
    setDraft('');
  };

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-list">
        {conversations.length === 0 && (
          <div className="sidebar-empty">No conversations yet</div>
        )}
        {conversations.map((conv, index) => (
          <div
            key={conv.id}
            ref={registerItemRef(conv.id)}
            className={`sidebar-item ${conv.id === activeId ? 'active' : ''}`}
            style={{ '--index': index, '--count': conversations.length }}
            onClick={() => editingId !== conv.id && onSelect(conv.id)}
          >
            <div className="sidebar-item-inner">
            {editingId === conv.id ? (
              <input
                className="sidebar-rename-input"
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') { setEditingId(null); setDraft(''); }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <span
                  className="sidebar-item-title"
                  onDoubleClick={(e) => { e.stopPropagation(); startRename(conv); }}
                  title={conv.title || 'New chat'}
                >
                  {conv.title || 'New chat'}
                </span>
                <span className="sidebar-item-actions">
                  <button
                    className="sidebar-item-btn"
                    aria-label="Rename"
                    title="Rename"
                    onClick={(e) => { e.stopPropagation(); startRename(conv); }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                    </svg>
                  </button>
                  <button
                    className="sidebar-item-btn"
                    aria-label="Delete"
                    title="Delete"
                    onClick={(e) => { e.stopPropagation(); onDelete(conv.id); }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"></polyline>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                  </button>
                </span>
              </>
            )}
            </div>
          </div>
        ))}
      </div>

      <div className="sidebar-footer" ref={profileMenuRef}>
        <button
          className="sidebar-profile-btn"
          onClick={() => setShowProfileMenu(!showProfileMenu)}
          title={`Profile: ${activeProfileObj?.name || activeProfile}`}
          aria-label="Profile menu"
        >
          <div className="sidebar-profile-avatar" style={{ backgroundColor: getAvatarColor(activeProfileObj?.name || activeProfile) }}>
            {(activeProfileObj?.name || activeProfile).substring(0, 2).toUpperCase()}
          </div>
          {!collapsed && (
            <span className="sidebar-profile-name">{activeProfileObj?.name || activeProfile}</span>
          )}
        </button>

        {showProfileMenu && (
          <div className="sidebar-profile-menu">
            <div className="sidebar-profile-list">
              {profiles.map((p) => (
                <div key={p.id} className={`sidebar-profile-item-wrapper ${p.id === activeProfile ? 'active' : ''}`}>
                  <button
                    className="sidebar-profile-item"
                    onClick={() => {
                      onSwitchProfile(p.id);
                      setShowProfileMenu(false);
                    }}
                  >
                    <span className="profile-dot" style={{ backgroundColor: getAvatarColor(p.name) }} />
                    <span className="profile-name-text">{p.name}</span>
                    {p.id === activeProfile && <span className="profile-check">✓</span>}
                  </button>
                  {p.id !== activeProfile && (
                    <button
                      className="sidebar-profile-delete-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteProfile(p);
                      }}
                      title="Delete profile"
                      aria-label="Delete profile"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                      </svg>
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button className="sidebar-profile-create-btn" onClick={onCreateProfile}>
              + Create Profile
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
