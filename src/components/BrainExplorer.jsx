// An interactive force-directed graph view of the brain's knowledge files.
// Replaces the chat area when active. Uses SVG with a hand-rolled physics
// simulation (no external libraries). Nodes can be dragged; the background
// pans and zooms with mouse wheel. Clicking a node opens its file content
// in a side editor pane with a Save button.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as api from '../api/client';
import { marked } from '../lib/markdown';

// Physics constants.
const REPULSION = 1200;
const ATTRACTION = 0.012;
const DAMPING = 0.82;
const REST_LENGTH = 140;
const CENTER_GRAVITY = 0.015;

const CORE_HUBS = ['User', 'Assistant', 'Calendar'];

function initSimulation(graphData) {
  const { nodes: rawNodes, links: rawLinks } = graphData;
  
  // Build a degree map so hub nodes are larger.
  const degreeMap = {};
  rawNodes.forEach((n) => { degreeMap[n.id] = 0; });
  rawLinks.forEach((l) => {
    degreeMap[l.source] = (degreeMap[l.source] || 0) + 1;
    degreeMap[l.target] = (degreeMap[l.target] || 0) + 1;
  });

  // Build adjacency list for connectivity checks.
  const adj = {};
  rawNodes.forEach((n) => { adj[n.id] = []; });
  rawLinks.forEach((l) => {
    if (adj[l.source]) adj[l.source].push(l.target);
    if (adj[l.target]) adj[l.target].push(l.source);
  });

  // Identify hubs and leaves.
  // Hubs are determined strictly by their parsed category.
  const hubs = [];
  const leaves = [];
  rawNodes.forEach((n) => {
    const isHub = n.category === 'hub';
    if (isHub) {
      hubs.push(n);
    } else {
      leaves.push(n);
    }
  });

  // Sort hubs deterministically to keep their positions stable.
  hubs.sort((a, b) => {
    if (a.id === 'User') return -1;
    if (b.id === 'User') return 1;
    if (a.id === 'Assistant') return -1;
    if (b.id === 'Assistant') return 1;
    const degA = degreeMap[a.id] || 0;
    const degB = degreeMap[b.id] || 0;
    if (degB !== degA) return degB - degA;
    return a.id.localeCompare(b.id);
  });

  // Position hubs in an inner ring.
  const nodePositions = {};
  hubs.forEach((h, index) => {
    const angle = hubs.length === 1 ? 0 : (index / hubs.length) * Math.PI * 2;
    const radius = hubs.length === 1 ? 0 : 130;
    nodePositions[h.id] = {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      angle,
      isHub: true,
      degree: degreeMap[h.id] || 0,
      radius: 20 + (degreeMap[h.id] || 0) * 2,
    };
  });

  // Group leaves by connected hub(s).
  const hubLeaves = {};
  hubs.forEach(h => { hubLeaves[h.id] = []; });
  const multiHubLeaves = [];
  const orphanedLeaves = [];

  leaves.forEach(leaf => {
    const connectedHubs = (adj[leaf.id] || []).filter(id => nodePositions[id]?.isHub);
    if (connectedHubs.length === 1) {
      hubLeaves[connectedHubs[0]].push(leaf);
    } else if (connectedHubs.length > 1) {
      multiHubLeaves.push({ leaf, connectedHubs });
    } else {
      orphanedLeaves.push(leaf);
    }
  });

  // Sort leaf groups alphabetically by ID to keep the layout deterministic.
  Object.keys(hubLeaves).forEach(hubId => {
    hubLeaves[hubId].sort((a, b) => a.id.localeCompare(b.id));
  });
  multiHubLeaves.sort((a, b) => a.leaf.id.localeCompare(b.leaf.id));
  orphanedLeaves.sort((a, b) => a.id.localeCompare(b.id));

  // Position exclusive leaves around their connected hub's sector.
  hubs.forEach(h => {
    const list = hubLeaves[h.id];
    const K = list.length;
    if (K === 0) return;

    const hubPos = nodePositions[h.id];
    const hubAngle = hubPos.angle;
    // Spreading width increases with number of leaves, capped at 1.25 rad.
    const sectorWidth = Math.min(1.25, 0.25 * K);

    list.forEach((leaf, idx) => {
      let angle;
      if (K === 1) {
        angle = hubAngle;
      } else {
        angle = hubAngle - sectorWidth / 2 + (idx / (K - 1)) * sectorWidth;
      }
      // Alternate radii slightly to prevent overlapping label collisions.
      const dist = 320 + (idx % 2 === 0 ? 0 : 50);
      nodePositions[leaf.id] = {
        x: Math.cos(angle) * dist,
        y: Math.sin(angle) * dist,
        angle,
        isHub: false,
        degree: degreeMap[leaf.id] || 0,
        radius: 8 + (degreeMap[leaf.id] || 0) * 1.5,
      };
    });
  });

  // Position multi-hub leaves in an intermediate ring.
  multiHubLeaves.forEach(({ leaf, connectedHubs }, idx) => {
    let sumX = 0, sumY = 0;
    connectedHubs.forEach(hubId => {
      const hubAngle = nodePositions[hubId].angle;
      sumX += Math.cos(hubAngle);
      sumY += Math.sin(hubAngle);
    });
    let angle = Math.atan2(sumY, sumX);
    // Add small deterministic spacing offset.
    if (multiHubLeaves.length > 1) {
      const offset = (idx - (multiHubLeaves.length - 1) / 2) * 0.12;
      angle += offset;
    }
    const dist = 220;
    nodePositions[leaf.id] = {
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      angle,
      isHub: false,
      degree: degreeMap[leaf.id] || 0,
      radius: 8 + (degreeMap[leaf.id] || 0) * 1.5,
    };
  });

  // Position orphaned leaves.
  orphanedLeaves.forEach((leaf, idx) => {
    const angle = orphanedLeaves.length === 1 ? 0 : (idx / orphanedLeaves.length) * Math.PI * 2;
    const dist = 380;
    nodePositions[leaf.id] = {
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      angle,
      isHub: false,
      degree: degreeMap[leaf.id] || 0,
      radius: 8 + (degreeMap[leaf.id] || 0) * 1.5,
    };
  });

  // Create nodes list.
  const nodes = rawNodes.map(n => {
    const pos = nodePositions[n.id];
    return {
      id: n.id,
      label: n.label || n.id,
      x: pos.x,
      y: pos.y,
      vx: 0,
      vy: 0,
      radius: pos.radius,
      isHub: pos.isHub,
      degree: pos.degree,
      category: n.category || 'leaf',
      updated: n.updated || '',
      created: n.created || '',
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

  // Collision resolution (prevent overlapping nodes/labels).
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const minDist = a.radius + b.radius + 120; // Spacing buffer
      if (dist < minDist) {
        const overlap = minDist - dist;
        const px = (dx / dist) * overlap * 0.5;
        const py = (dy / dist) * overlap * 0.5;
        a.x -= px; a.y -= py;
        b.x += px; b.y += py;
        
        a.vx *= 0.75; a.vy *= 0.75;
        b.vx *= 0.75; b.vy *= 0.75;
      }
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

  // Integrate positions.
  nodes.forEach((n) => {
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
  const [editorTab, setEditorTab] = useState('preview'); // 'preview' or 'edit'
  const [paneWidth, setPaneWidth] = useState(480);
  const isResizing = useRef(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState('');

  const selectedRef = useRef(selected);
  const serverContentRef = useRef('');

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // Reset renaming states when selected node changes
  useEffect(() => {
    setIsRenaming(false);
    setNewName('');
  }, [selected?.id]);

  const handleResizerMouseDown = useCallback((e) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
  }, []);

  useEffect(() => {
    const handleMove = (e) => {
      if (!isResizing.current) return;
      const nextWidth = window.innerWidth - e.clientX;
      setPaneWidth(Math.max(320, Math.min(nextWidth, window.innerWidth * 0.8)));
    };
    const handleUp = () => {
      if (isResizing.current) {
        isResizing.current = false;
        document.body.style.cursor = '';
      }
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  const svgRef = useRef(null);
  const panRef = useRef({ x: 0, y: 0, zoom: 1 });
  const panDragRef = useRef(null);
  const [, forceRender] = useState(0);

  // Bumped to refetch the graph after a file is deleted.
  const [reloadKey, setReloadKey] = useState(0);

  // Load graph data.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.fetchBrainGraph(brainMode)
      .then((data) => {
        if (cancelled) return;
        const s = initSimulation(data);
        for (let i = 0; i < 300; i++) {
          tick(s.nodes, s.links);
        }
        setSim(s);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Brain graph load failed:', err);
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [brainMode, reloadKey]);

  // Poll graph data in the background every 2.5 seconds to support real-time updates from background memory model commits.
  useEffect(() => {
    const timer = setInterval(() => {
      api.fetchBrainGraph(brainMode)
        .then((data) => {
          setSim((currSim) => {
            if (!currSim) {
              const s = initSimulation(data);
              for (let i = 0; i < 300; i++) {
                tick(s.nodes, s.links);
              }
              return s;
            }
            
            // Compare structure (including categories) to avoid unnecessary re-initialization
            const currNodeIds = currSim.nodes.map((n) => `${n.id}:${n.category}`).sort().join(',');
            const newNodeIds = data.nodes.map((n) => `${n.id}:${n.category}`).sort().join(',');
            
            const currLinkKeys = currSim.links.map((l) => `${l.source.id}->${l.target.id}`).sort().join(',');
            const newLinkKeys = data.links.map((l) => `${l.source}->${l.target}`).sort().join(',');
            
            if (currNodeIds === newNodeIds && currLinkKeys === newLinkKeys) {
              // Same structure! Just update labels, degrees, and updated/created timestamps in-place
              const updatedNodes = currSim.nodes.map(n => {
                const newNode = data.nodes.find(nn => nn.id === n.id);
                if (newNode) {
                  return {
                    ...n,
                    label: newNode.label || newNode.id,
                    degree: newNode.val,
                    updated: newNode.updated,
                    created: newNode.created,
                  };
                }
                return n;
              });
              const nodeById = {};
              updatedNodes.forEach(n => { nodeById[n.id] = n; });
              const updatedLinks = currSim.links.map(l => ({
                source: nodeById[l.source.id],
                target: nodeById[l.target.id]
              })).filter(l => l.source && l.target);

              // If there's an active selected node, check if its updated timestamp changed
              const currentSelected = selectedRef.current;
              if (currentSelected) {
                const newSelectedNode = data.nodes.find(n => n.id === currentSelected.id);
                if (newSelectedNode && newSelectedNode.updated !== currentSelected.updated) {
                  api.fetchBrainFile(brainMode, currentSelected.id)
                    .then((fileData) => {
                      setSelected(prev => {
                        if (prev && prev.id === currentSelected.id) {
                          return { ...prev, updated: newSelectedNode.updated };
                        }
                        return prev;
                      });
                      setEditorContent(prevContent => {
                        if (prevContent === serverContentRef.current) {
                          return fileData.content || '';
                        }
                        return prevContent;
                      });
                      serverContentRef.current = fileData.content || '';
                    })
                    .catch(err => console.error('Failed to sync open brain file:', err));
                }
              }

              return {
                nodes: updatedNodes,
                links: updatedLinks,
              };
            }
            
            const s = initSimulation(data);
            for (let i = 0; i < 300; i++) {
              tick(s.nodes, s.links);
            }

            // Sync open node if structure changed (e.g. node deleted or renamed)
            const currentSelected = selectedRef.current;
            if (currentSelected) {
              const stillExists = data.nodes.some(n => n.id === currentSelected.id);
              if (!stillExists) {
                setSelected(null);
              } else {
                const newSelectedNode = data.nodes.find(n => n.id === currentSelected.id);
                if (newSelectedNode && newSelectedNode.updated !== currentSelected.updated) {
                  api.fetchBrainFile(brainMode, currentSelected.id)
                    .then((fileData) => {
                      setSelected(prev => {
                        if (prev && prev.id === currentSelected.id) {
                          return { ...prev, updated: newSelectedNode.updated };
                        }
                        return prev;
                      });
                      setEditorContent(prevContent => {
                        if (prevContent === serverContentRef.current) {
                          return fileData.content || '';
                        }
                        return prevContent;
                      });
                      serverContentRef.current = fileData.content || '';
                    })
                    .catch(err => console.error('Failed to sync open brain file after struct change:', err));
                }
              }
            }

            return s;
          });
        })
        .catch((err) => {
          console.error('Real-time background graph sync failed:', err);
        });
    }, 2500);
    return () => clearInterval(timer);
  }, [brainMode]);

  const handleNodeClick = useCallback(async (node) => {
    try {
      const data = await api.fetchBrainFile(brainMode, node.id);
      setSelected({ id: node.id, label: node.label, updated: node.updated });
      setEditorContent(data.content || '');
      serverContentRef.current = data.content || '';
      setEditorTab('preview');
    } catch (err) {
      console.error('Brain file load failed:', err);
    }
  }, [brainMode]);

  const handleSave = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await api.saveBrainFile(brainMode, selected.id, editorContent);
      serverContentRef.current = editorContent;
      const data = await api.fetchBrainGraph(brainMode);
      const updatedNode = data.nodes.find(n => n.id === selected.id);
      setSelected({
        id: selected.id,
        label: selected.label,
        updated: updatedNode ? updatedNode.updated : selected.updated
      });
      setSim(() => {
        const s = initSimulation(data);
        for (let i = 0; i < 300; i++) {
          tick(s.nodes, s.links);
        }
        return s;
      });
    } catch (err) {
      console.error('Brain file save failed:', err);
    } finally {
      setSaving(false);
    }
  }, [brainMode, selected, editorContent]);

  // Delete the selected file and refetch the graph without it.
  const handleDelete = useCallback(async () => {
    if (!selected) return;
    if (!window.confirm(`Are you sure you want to delete "${selected.label || selected.id}"?`)) {
      return;
    }
    try {
      await api.deleteBrainFile(brainMode, selected.id);
      setSelected(null);
      const data = await api.fetchBrainGraph(brainMode);
      setSim(() => {
        const s = initSimulation(data);
        for (let i = 0; i < 300; i++) {
          tick(s.nodes, s.links);
        }
        return s;
      });
    } catch (err) {
      console.error('Brain file delete failed:', err);
    }
  }, [brainMode, selected]);

  // Reset core hubs (User, Assistant, Calendar) to their default templates.
  const handleReset = useCallback(async () => {
    if (!selected) return;
    if (!window.confirm(`Are you sure you want to reset the core hub "${selected.id}" to its default state? This will clear all its logs and custom entries.`)) {
      return;
    }
    setSaving(true);
    try {
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const hh = String(now.getHours()).padStart(2, '0');
      const min = String(now.getMinutes()).padStart(2, '0');
      const nowStr = `${yyyy}-${mm}-${dd} ${hh}:${min}`;

      let defaultContent = '';
      if (selected.id === 'User') {
        defaultContent = `---\ncreated: ${nowStr}\nupdated: ${nowStr}\n---\n\n# User\n\nThe root hub for all information about the user.\n\n## Content / Logs\n- [${nowStr}] **System**: Memory graph initialized.\n\n## Connections & Links\n- Hubs: [[Assistant]], [[Calendar]]\n`;
      } else if (selected.id === 'Assistant') {
        defaultContent = `---\ncreated: ${nowStr}\nupdated: ${nowStr}\n---\n\n# Assistant\n\nThe assistant hub storing personality parameters, tone guidelines, and user preferences.\n\n## Content / Logs\n- [${nowStr}] **System**: Assistant memory profile initialized.\n\n## Connections & Links\n- Hubs: [[User]], [[Calendar]]\n`;
      } else if (selected.id === 'Calendar') {
        defaultContent = `---\ncreated: ${nowStr}\nupdated: ${nowStr}\n---\n\n# Calendar\n\nCore hub for deadlines, commitments, assignments, events, and birthdays.\n\n## Content / Logs\n- [${nowStr}] **System**: Calendar initialized.\n\n## Connections & Links\n- Hubs: [[User]]\n`;
      } else {
        throw new Error('Not a core hub');
      }

      await api.saveBrainFile(brainMode, selected.id, defaultContent);
      setEditorContent(defaultContent);
      serverContentRef.current = defaultContent;

      const data = await api.fetchBrainGraph(brainMode);
      const updatedNode = data.nodes.find(n => n.id === selected.id);
      setSelected({
        id: selected.id,
        label: selected.label,
        updated: updatedNode ? updatedNode.updated : selected.updated
      });
      setSim(() => {
        const s = initSimulation(data);
        for (let i = 0; i < 300; i++) {
          tick(s.nodes, s.links);
        }
        return s;
      });
    } catch (err) {
      console.error('Brain core hub reset failed:', err);
    } finally {
      setSaving(false);
    }
  }, [brainMode, selected]);

  const handleRenameSave = useCallback(async () => {
    if (!selected || !newName.trim()) return;
    const cleanName = newName.trim();
    if (cleanName === selected.id || cleanName === selected.label) {
      setIsRenaming(false);
      return;
    }
    setSaving(true);
    try {
      await api.renameBrainFile(brainMode, selected.id, cleanName);
      setIsRenaming(false);
      const data = await api.fetchBrainGraph(brainMode);
      const updatedNode = data.nodes.find(n => n.id === cleanName);
      setSelected({
        id: cleanName,
        label: cleanName,
        updated: updatedNode ? updatedNode.updated : ''
      });
      setSim(() => {
        const s = initSimulation(data);
        for (let i = 0; i < 300; i++) {
          tick(s.nodes, s.links);
        }
        return s;
      });
    } catch (err) {
      console.error('Brain file rename failed:', err);
      alert(err.message || 'Rename failed. Ensure the name contains no spaces/slashes and does not already exist.');
    } finally {
      setSaving(false);
    }
  }, [brainMode, selected, newName]);

  const handleBgMouseDown = useCallback((e) => {
    if (e.target === svgRef.current || e.target.classList.contains('brain-bg-rect')) {
      panDragRef.current = { startX: e.clientX, startY: e.clientY, origPanX: panRef.current.x, origPanY: panRef.current.y };
    }
  }, []);

  const handleMouseMove = useCallback((e) => {
    if (panDragRef.current) {
      panRef.current.x = panDragRef.current.origPanX + (e.clientX - panDragRef.current.startX);
      panRef.current.y = panDragRef.current.origPanY + (e.clientY - panDragRef.current.startY);
      forceRender((v) => v + 1);
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    panDragRef.current = null;
  }, []);

  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.92 : 1.08;
    panRef.current.zoom = Math.max(0.2, Math.min(4, panRef.current.zoom * delta));
    forceRender((v) => v + 1);
  }, []);

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
          <rect className="brain-bg-rect" width="100%" height="100%" fill="#fafafc" />
          <g transform={`translate(${cx}, ${cy}) scale(${pan.zoom})`}>
            {links.map((l, i) => (
              <line
                key={i}
                x1={l.source.x}
                y1={l.source.y}
                x2={l.target.x}
                y2={l.target.y}
                stroke="rgba(0,0,0,0.12)"
                strokeWidth={1.5}
              />
            ))}
            {nodes.map((n) => (
              <g key={n.id} className="brain-node-group" style={{ cursor: 'pointer' }}>
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={n.radius + 4}
                  fill={n.isHub ? 'url(#hub-gradient)' : 'url(#leaf-gradient)'}
                  opacity={0.15}
                  filter="url(#node-glow)"
                />
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={n.radius}
                  fill={n.isHub ? 'url(#hub-gradient)' : 'url(#leaf-gradient)'}
                  stroke={selected?.id === n.id ? '#7c6fc4' : 'rgba(255,255,255,0.8)'}
                  strokeWidth={2}
                  onClick={() => handleNodeClick(n)}
                  style={{ cursor: 'pointer' }}
                />
                <text
                  x={n.x}
                  y={n.y + n.radius + 14}
                  textAnchor="middle"
                  fill="rgba(30, 41, 59, 0.9)"
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
          <div className="brain-editor-pane" style={{ width: `${paneWidth}px` }}>
            <div className="brain-editor-resizer" onMouseDown={handleResizerMouseDown} />
            <div className="brain-editor-header">
              {isRenaming ? (
                <div className="brain-editor-rename-form">
                  <input
                    type="text"
                    className="brain-editor-rename-input"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRenameSave();
                      if (e.key === 'Escape') setIsRenaming(false);
                    }}
                    autoFocus
                  />
                  <button className="brain-editor-rename-btn confirm" onClick={handleRenameSave} aria-label="Confirm rename" disabled={saving}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  </button>
                  <button className="brain-editor-rename-btn cancel" onClick={() => setIsRenaming(false)} aria-label="Cancel rename" disabled={saving}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"></line>
                      <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                  </button>
                </div>
              ) : (
                <div className="brain-editor-filename-container">
                  <span className="brain-editor-filename">{selected.label || selected.id}</span>
                  {selected.id !== 'User' && selected.id !== 'Assistant' && (
                    <button
                      className="brain-editor-rename-toggle"
                      onClick={() => {
                        setNewName(selected.label || selected.id);
                        setIsRenaming(true);
                      }}
                      aria-label="Rename node"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                      </svg>
                    </button>
                  )}
                </div>
              )}
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
            <div className="brain-editor-tabs">
              <button
                className={`brain-editor-tab-btn ${editorTab === 'preview' ? 'active' : ''}`}
                onClick={() => setEditorTab('preview')}
              >
                Preview
              </button>
              <button
                className={`brain-editor-tab-btn ${editorTab === 'edit' ? 'active' : ''}`}
                onClick={() => setEditorTab('edit')}
              >
                Edit
              </button>
            </div>
            {editorTab === 'preview' ? (
              <div
                className="brain-editor-content brain-editor-preview markdown-body"
                dangerouslySetInnerHTML={{ __html: marked.parse(editorContent || '*No content*') }}
              />
            ) : (
              <textarea
                id="brain-editor-textarea"
                className="brain-editor-content"
                value={editorContent}
                onChange={(e) => setEditorContent(e.target.value)}
              />
            )}
            <div className="brain-editor-actions">
              {CORE_HUBS.includes(selected.id) ? (
                <button
                  id="brain-editor-reset"
                  className="brain-editor-reset-btn"
                  onClick={handleReset}
                  disabled={saving}
                >
                  Reset
                </button>
              ) : (
                <button
                  id="brain-editor-delete"
                  className="brain-editor-delete-btn"
                  onClick={handleDelete}
                  disabled={saving}
                >
                  Delete
                </button>
              )}
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
