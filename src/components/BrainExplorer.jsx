// An interactive force-directed graph view of the brain's knowledge files.
// Replaces the chat area when active. Uses SVG with a hand-rolled physics
// simulation (no external libraries). Nodes can be dragged; the background
// pans and zooms with mouse wheel. Clicking a node opens its file content
// in a side editor pane with a Save button.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as api from '../api/client';

// Physics constants.
const REPULSION = 800;
const ATTRACTION = 0.008;
const DAMPING = 0.88;
const REST_LENGTH = 120;
const CENTER_GRAVITY = 0.012;

function initSimulation(graphData) {
  const { nodes: rawNodes, links: rawLinks } = graphData;
  // Build a degree map so hub nodes are larger.
  const degreeMap = {};
  rawNodes.forEach((n) => { degreeMap[n.id] = 0; });
  rawLinks.forEach((l) => {
    degreeMap[l.source] = (degreeMap[l.source] || 0) + 1;
    degreeMap[l.target] = (degreeMap[l.target] || 0) + 1;
  });

  const maxDeg = Math.max(1, ...Object.values(degreeMap));

  const nodes = rawNodes.map((n, i) => {
    const angle = (i / rawNodes.length) * Math.PI * 2;
    const radius = 180 + Math.random() * 80;
    const deg = degreeMap[n.id] || 0;
    const isHub = n.id === 'User' || n.id === 'Assistant' || deg > maxDeg * 0.5;
    return {
      id: n.id,
      label: n.label || n.id,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      radius: isHub ? 20 + deg * 2 : 8 + deg * 1.5,
      isHub,
      degree: deg,
    };
  });

  const nodeById = {};
  nodes.forEach((n) => { nodeById[n.id] = n; });

  const links = rawLinks
    .filter((l) => nodeById[l.source] && nodeById[l.target])
    .map((l) => ({
      source: nodeById[l.source],
      target: nodeById[l.target],
    }));

  return { nodes, links };
}

function tick(nodes, links) {
  // Repulsion (all pairs).
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = REPULSION / (dist * dist);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx -= fx; a.vy -= fy;
      b.vx += fx; b.vy += fy;
    }
  }
  // Attraction along links.
  links.forEach(({ source, target }) => {
    let dx = target.x - source.x, dy = target.y - source.y;
    let dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const force = (dist - REST_LENGTH) * ATTRACTION;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    source.vx += fx; source.vy += fy;
    target.vx -= fx; target.vy -= fy;
  });
  // Center gravity.
  nodes.forEach((n) => {
    n.vx -= n.x * CENTER_GRAVITY;
    n.vy -= n.y * CENTER_GRAVITY;
  });
  // Integrate.
  nodes.forEach((n) => {
    if (n.dragging) return;
    n.vx *= DAMPING;
    n.vy *= DAMPING;
    n.x += n.vx;
    n.y += n.vy;
  });
}

export default function BrainExplorer({ brainMode, onClose }) {
  const [sim, setSim] = useState(null);
  const [selected, setSelected] = useState(null); // { id, content, dirty }
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editorContent, setEditorContent] = useState('');
  const svgRef = useRef(null);
  const animRef = useRef(null);
  const panRef = useRef({ x: 0, y: 0, zoom: 1 });
  const dragRef = useRef(null);
  const panDragRef = useRef(null);
  const [, forceRender] = useState(0);
  const tickCount = useRef(0);

  // Load graph data.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.fetchBrainGraph(brainMode)
      .then((data) => {
        if (cancelled) return;
        const s = initSimulation(data);
        setSim(s);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Brain graph load failed:', err);
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [brainMode]);

  // Animation loop.
  useEffect(() => {
    if (!sim) return;
    tickCount.current = 0;
    const loop = () => {
      tick(sim.nodes, sim.links);
      tickCount.current++;
      forceRender((v) => v + 1);
      animRef.current = requestAnimationFrame(loop);
    };
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [sim]);

  // Node click: load file content.
  const handleNodeClick = useCallback(async (node) => {
    try {
      const data = await api.fetchBrainFile(brainMode, node.id);
      setSelected({ id: node.id, label: node.label });
      setEditorContent(data.content || '');
    } catch (err) {
      console.error('Brain file load failed:', err);
    }
  }, [brainMode]);

  const handleSave = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await api.saveBrainFile(brainMode, selected.id, editorContent);
    } catch (err) {
      console.error('Brain file save failed:', err);
    } finally {
      setSaving(false);
    }
  }, [brainMode, selected, editorContent]);

  // Drag handlers.
  const handleMouseDown = useCallback((e, node) => {
    e.stopPropagation();
    if (node) {
      node.dragging = true;
      dragRef.current = { node, startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y };
    }
  }, []);

  const handleBgMouseDown = useCallback((e) => {
    if (e.target === svgRef.current || e.target.classList.contains('brain-bg-rect')) {
      panDragRef.current = { startX: e.clientX, startY: e.clientY, origPanX: panRef.current.x, origPanY: panRef.current.y };
    }
  }, []);

  const handleMouseMove = useCallback((e) => {
    if (dragRef.current) {
      const { node } = dragRef.current;
      const z = panRef.current.zoom;
      node.x = dragRef.current.origX + (e.clientX - dragRef.current.startX) / z;
      node.y = dragRef.current.origY + (e.clientY - dragRef.current.startY) / z;
      node.vx = 0; node.vy = 0;
    }
    if (panDragRef.current) {
      panRef.current.x = panDragRef.current.origPanX + (e.clientX - panDragRef.current.startX);
      panRef.current.y = panDragRef.current.origPanY + (e.clientY - panDragRef.current.startY);
      forceRender((v) => v + 1);
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    if (dragRef.current) {
      dragRef.current.node.dragging = false;
      dragRef.current = null;
    }
    panDragRef.current = null;
  }, []);

  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.92 : 1.08;
    panRef.current.zoom = Math.max(0.2, Math.min(4, panRef.current.zoom * delta));
    forceRender((v) => v + 1);
  }, []);

  // Pulse phase for node glow animation.
  const pulse = Math.sin(tickCount.current * 0.03) * 0.5 + 0.5;

  if (loading) {
    return (
      <div className="brain-explorer">
        <div className="brain-explorer-loading">
          <span className="brain-explorer-loading-text">Loading brain graph…</span>
        </div>
        <button id="brain-explorer-close" className="brain-explorer-close" onClick={onClose} aria-label="Close brain explorer">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    );
  }

  if (!sim) return null;

  const { nodes, links } = sim;
  const pan = panRef.current;
  const svgWidth = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const svgHeight = typeof window !== 'undefined' ? window.innerHeight - 60 : 800;
  const cx = svgWidth / 2 + pan.x;
  const cy = svgHeight / 2 + pan.y;

  return (
    <div className="brain-explorer">
      <button id="brain-explorer-close" className="brain-explorer-close" onClick={onClose} aria-label="Close brain explorer">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
        <span className="brain-explorer-close-label">Back to chat</span>
      </button>

      <div className={`brain-explorer-body ${selected ? 'split' : ''}`}>
        <svg
          ref={svgRef}
          className="brain-graph-svg"
          width="100%"
          height="100%"
          onMouseDown={handleBgMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
        >
          <defs>
            <radialGradient id="hub-gradient" cx="40%" cy="40%">
              <stop offset="0%" stopColor="#8b5cf6" />
              <stop offset="100%" stopColor="#3b82f6" />
            </radialGradient>
            <radialGradient id="leaf-gradient" cx="40%" cy="40%">
              <stop offset="0%" stopColor="#2dd4bf" />
              <stop offset="100%" stopColor="#06b6d4" />
            </radialGradient>
            <filter id="node-glow">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <rect className="brain-bg-rect" width="100%" height="100%" fill="#0f0f1a" />
          <g transform={`translate(${cx}, ${cy}) scale(${pan.zoom})`}>
            {links.map((l, i) => (
              <line
                key={i}
                x1={l.source.x}
                y1={l.source.y}
                x2={l.target.x}
                y2={l.target.y}
                stroke="rgba(255,255,255,0.08)"
                strokeWidth={1.2}
              />
            ))}
            {nodes.map((n) => (
              <g key={n.id} className="brain-node-group" style={{ cursor: 'grab' }}>
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={n.radius + pulse * 2}
                  fill={n.isHub ? 'url(#hub-gradient)' : 'url(#leaf-gradient)'}
                  opacity={0.15 + pulse * 0.1}
                  filter="url(#node-glow)"
                />
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={n.radius}
                  fill={n.isHub ? 'url(#hub-gradient)' : 'url(#leaf-gradient)'}
                  stroke={selected?.id === n.id ? '#fff' : 'transparent'}
                  strokeWidth={2}
                  onMouseDown={(e) => handleMouseDown(e, n)}
                  onClick={() => handleNodeClick(n)}
                  style={{ cursor: 'pointer' }}
                />
                <text
                  x={n.x}
                  y={n.y + n.radius + 14}
                  textAnchor="middle"
                  fill="rgba(255,255,255,0.7)"
                  fontSize="11"
                  fontFamily="'Plus Jakarta Sans', sans-serif"
                  fontWeight="600"
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {n.label}
                </text>
              </g>
            ))}
          </g>
        </svg>

        {selected && (
          <div className="brain-editor-pane">
            <div className="brain-editor-header">
              <span className="brain-editor-filename">{selected.label || selected.id}</span>
              <button
                id="brain-editor-close"
                className="brain-editor-close-btn"
                onClick={() => setSelected(null)}
                aria-label="Close editor"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <textarea
              id="brain-editor-textarea"
              className="brain-editor-content"
              value={editorContent}
              onChange={(e) => setEditorContent(e.target.value)}
            />
            <div className="brain-editor-actions">
              <button
                id="brain-editor-save"
                className="brain-editor-save-btn"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
