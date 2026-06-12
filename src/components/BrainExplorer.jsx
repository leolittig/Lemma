// An interactive view of the brain. The default tab is a force-directed graph
// of the user's knowledge (typed nodes growing from a single named root, with
// colour by cluster and an icon by type). Other tabs surface the off-grid
// entities — Calendar, Journal, Tasks, People, Assistant — which are not graph
// nodes. Clicking a graph node opens its file in a side editor.

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as api from '../api/client';
import { marked } from '../lib/markdown';
import { useAutoScroll } from '../hooks/useAutoScroll';
import BrainCalendar from './BrainCalendar';
import BrainJournal from './BrainJournal';
import BrainTasks from './BrainTasks';
import BrainPeople from './BrainPeople';
import BrainAssistant from './BrainAssistant';

// Physics constants.
const REPULSION = 1200;
const ATTRACTION = 0.012;
const DAMPING = 0.82;
const REST_LENGTH = 140;
const CENTER_GRAVITY = 0.015;

const ROOT_ID = 'User';
const CORE_HUBS = ['User']; // can't be deleted/renamed

const VIEWS = [
  { key: 'graph', label: 'Graph' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'journal', label: 'Journal' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'people', label: 'People' },
  { key: 'assistant', label: 'Assistant' },
];

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Build the laid-out graph: BFS depth from the root drives the radial layout;
// the depth-1 branch a node descends from is its cluster (→ hue); the node's
// type drives its icon.
function initSimulation(graphData) {
  const rawNodes = graphData.nodes || [];
  const rawLinks = graphData.links || [];
  const ids = new Set(rawNodes.map((n) => n.id));

  const adj = {};
  rawNodes.forEach((n) => { adj[n.id] = []; });
  rawLinks.forEach((l) => {
    if (adj[l.source] && adj[l.target]) { adj[l.source].push(l.target); adj[l.target].push(l.source); }
  });
  const degree = {};
  rawNodes.forEach((n) => { degree[n.id] = adj[n.id].length; });

  // BFS depth + parent from the root.
  const hasRoot = ids.has(ROOT_ID);
  const depth = {}, parent = {};
  if (hasRoot) {
    depth[ROOT_ID] = 0;
    const q = [ROOT_ID];
    while (q.length) {
      const u = q.shift();
      for (const v of adj[u]) if (depth[v] === undefined) { depth[v] = depth[u] + 1; parent[v] = u; q.push(v); }
    }
  }
  rawNodes.forEach((n) => { if (depth[n.id] === undefined) { depth[n.id] = hasRoot ? 2 : 1; parent[n.id] = null; } });

  // Cluster = the depth-1 ancestor (top-level branch), or null (root/orphan).
  const cluster = {};
  rawNodes.forEach((n) => {
    if (n.id === ROOT_ID) { cluster[n.id] = null; return; }
    let cur = n.id;
    while (parent[cur] != null && depth[parent[cur]] > 0) cur = parent[cur];
    cluster[n.id] = depth[cur] === 1 ? cur : null;
  });

  const branches = rawNodes.filter((n) => depth[n.id] === 1).map((n) => n.id).sort();
  const hueByBranch = {};
  branches.forEach((b, i) => { hueByBranch[b] = Math.round((360 * i) / Math.max(1, branches.length)); });

  const colorOf = (id) => {
    if (id === ROOT_ID) return '#475569';            // neutral dark root
    const c = cluster[id];
    if (c == null) return '#94a3b8';                  // orphan neutral
    const hue = hueByBranch[c];
    if (depth[id] === 1) return `hsl(${hue} 62% 48%)`; // branch anchor
    const jit = (hashStr(id) % 17) - 8;
    return `hsl(${(hue + jit + 360) % 360} 55% 64%)`;  // tint of the branch hue
  };

  // Radial placement: root center, branches on a ring, descendants in their
  // branch's angular sector further out. The physics tick then relaxes it.
  const pos = { [ROOT_ID]: { x: 0, y: 0 } };
  const N = branches.length;
  const branchAngle = {};
  branches.forEach((b, i) => {
    const a = N === 1 ? -Math.PI / 2 : (i / N) * Math.PI * 2 - Math.PI / 2;
    branchAngle[b] = a;
    pos[b] = { x: Math.cos(a) * 220, y: Math.sin(a) * 220 };
  });
  const members = {};
  branches.forEach((b) => { members[b] = []; });
  const orphans = [];
  rawNodes.forEach((n) => {
    if (n.id === ROOT_ID || depth[n.id] === 1) return;
    const c = cluster[n.id];
    if (c != null && members[c]) members[c].push(n.id); else orphans.push(n.id);
  });
  Object.keys(members).forEach((c) => {
    const list = members[c].sort();
    const K = list.length;
    const base = branchAngle[c];
    const sector = Math.min(1.4, 0.35 * Math.max(1, K));
    list.forEach((id, idx) => {
      const a = K === 1 ? base : base - sector / 2 + (idx / (K - 1)) * sector;
      const r = 220 + (depth[id] - 1) * 170 + (idx % 2) * 40;
      pos[id] = { x: Math.cos(a) * r, y: Math.sin(a) * r };
    });
  });
  orphans.forEach((id, idx) => {
    const a = (idx / Math.max(1, orphans.length)) * Math.PI * 2;
    pos[id] = { x: Math.cos(a) * 460, y: Math.sin(a) * 460 };
  });
  rawNodes.forEach((n, idx) => {
    if (!pos[n.id]) { const a = (idx / rawNodes.length) * Math.PI * 2; pos[n.id] = { x: Math.cos(a) * 250, y: Math.sin(a) * 250 }; }
  });

  const nodes = rawNodes.map((n) => {
    const isRoot = n.id === ROOT_ID;
    const deg = degree[n.id] || 0;
    const radius = isRoot ? 26
      : depth[n.id] === 1 ? 16 + Math.min(deg, 8) * 1.5
        : 9 + Math.min(deg, 6) * 1.2;
    return {
      id: n.id,
      label: n.label || n.id,
      x: pos[n.id].x, y: pos[n.id].y, vx: 0, vy: 0,
      radius,
      color: colorOf(n.id),
      depth: depth[n.id],
      cluster: cluster[n.id],
      type: n.type || 'leaf',
      isRoot, pinned: isRoot,
      degree: deg,
      event_count: n.event_count || 0,
      status: n.status || '', tags: n.tags || [], relationship: n.relationship || '',
      updated: n.updated || '', created: n.created || '',
    };
  });

  const byId = {};
  nodes.forEach((n) => { byId[n.id] = n; });
  const links = rawLinks
    .filter((l) => byId[l.source] && byId[l.target])
    .map((l) => ({ source: byId[l.source], target: byId[l.target] }));

  const legend = branches.map((b) => ({ id: b, label: byId[b]?.label || b, hue: hueByBranch[b] }));
  return { nodes, links, legend };
}

function tick(nodes, links, draggedNode) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = REPULSION / (dist * dist);
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const minDist = a.radius + b.radius + 120;
      if (dist < minDist) {
        const overlap = minDist - dist;
        const px = (dx / dist) * overlap * 0.5, py = (dy / dist) * overlap * 0.5;
        if (!a.pinned && a !== draggedNode) { a.x -= px; a.y -= py; a.vx *= 0.75; a.vy *= 0.75; }
        if (!b.pinned && b !== draggedNode) { b.x += px; b.y += py; b.vx *= 0.75; b.vy *= 0.75; }
      }
    }
  }
  links.forEach(({ source, target }) => {
    let dx = target.x - source.x, dy = target.y - source.y;
    let dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const force = (dist - REST_LENGTH) * ATTRACTION;
    const fx = (dx / dist) * force, fy = (dy / dist) * force;
    source.vx += fx; source.vy += fy; target.vx -= fx; target.vy -= fy;
  });
  nodes.forEach((n) => { n.vx -= n.x * CENTER_GRAVITY; n.vy -= n.y * CENTER_GRAVITY; });
  nodes.forEach((n) => {
    if (n.pinned || n === draggedNode) {
      n.vx = 0; n.vy = 0;
      if (n.isRoot) { n.x = 0; n.y = 0; }
      return;
    }
    n.vx *= DAMPING; n.vy *= DAMPING; n.x += n.vx; n.y += n.vy;
  });
}

function settle(s) {
  for (let i = 0; i < 300; i++) tick(s.nodes, s.links);
  return s;
}

// A small white line-icon per node type, centred at the node origin.
function TypeGlyph({ type, size }) {
  const props = { fill: 'none', stroke: '#ffffff', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', opacity: 0.95 };
  let paths;
  switch (type) {
    case 'user':
    case 'person':
      paths = (<><circle cx="12" cy="8" r="4" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></>); break;
    case 'activity':
      paths = (<><rect x="3" y="8" width="18" height="12" rx="2" /><path d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>); break;
    case 'task':
      paths = (<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 12l2.5 2.5L16 9" /></>); break;
    case 'group':
      paths = (<><circle cx="9" cy="9" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M16 6.5a3 3 0 0 1 0 6" /></>); break;
    case 'place':
      paths = (<><path d="M12 21s6-5.5 6-10a6 6 0 1 0-12 0c0 4.5 6 10 6 10z" /><circle cx="12" cy="11" r="2" /></>); break;
    case 'pet':
      paths = (<><circle cx="12" cy="14" r="4" /><circle cx="6" cy="9" r="1.5" /><circle cx="18" cy="9" r="1.5" /></>); break;
    case 'goal':
      paths = (<><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" /></>); break;
    default:
      paths = (<circle cx="12" cy="12" r="5" />);
  }
  return (<g transform={`translate(${-size / 2},${-size / 2}) scale(${size / 24})`} {...props}>{paths}</g>);
}

export default function BrainExplorer({ brainMode, activity, detailedLogs, onClose, onReset }) {
  const [view, setView] = useState('graph');
  const [sim, setSim] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [editorContent, setEditorContent] = useState('');
  const [editorTab, setEditorTab] = useState('preview');
  const [paneWidth, setPaneWidth] = useState(480);
  const isResizing = useRef(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [nodeRefs, setNodeRefs] = useState(null);

  const selectedRef = useRef(selected);
  const serverContentRef = useRef('');
  const [logCollapsed, setLogCollapsed] = useState(false);
  
  // Collapse memory activity log on screen/tab changes
  useEffect(() => {
    setLogCollapsed(true);
  }, [view]);
  const logScroll = useAutoScroll({ reengageAtBottom: false });
  const prevProcessingRef = useRef(false);

  const act = activity || { processing: false, events: [], stream: '' };
  
  // Filter events when detailedLogs is disabled
  const displayEvents = useMemo(() => {
    if (detailedLogs) return act.events;
    
    // Filter to only include actions and errors
    const actions = act.events.filter(e => 
      e.type === 'write' || e.type === 'delete' || e.type === 'calendar' || e.type === 'journal' || e.type === 'error'
    );
    
    // If no actions have occurred yet but we are processing, show a status indicator
    if (actions.length === 0 && act.processing) {
      const latestStatus = [...act.events].reverse().find(e => e.type === 'status');
      return [{
        seq: 'status',
        ts: latestStatus?.ts || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        type: 'status',
        text: latestStatus?.text || 'Updating memory…'
      }];
    }
    
    return actions;
  }, [act.events, act.processing, detailedLogs]);

  const hasActivity = act.processing || act.events.length > 0 || act.stream;

  useEffect(() => {
    if (act.processing && !prevProcessingRef.current) logScroll.lockToBottom();
    prevProcessingRef.current = act.processing;
  }, [act.processing, logScroll]);
  useEffect(() => { logScroll.notifyContentChanged(); }, [act.events.length, act.stream, logScroll]);
  useEffect(() => { if (!logCollapsed) logScroll.lockToBottom(); }, [logCollapsed, logScroll]);

  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { setIsRenaming(false); setNewName(''); }, [selected?.id]);

  // Fetch where the off-grid entities reference the selected node.
  useEffect(() => {
    if (!selected) { setNodeRefs(null); return; }
    let cancelled = false;
    api.fetchBrainNodeRefs(brainMode, selected.id)
      .then((r) => { if (!cancelled) setNodeRefs(r); })
      .catch(() => { if (!cancelled) setNodeRefs(null); });
    return () => { cancelled = true; };
  }, [selected?.id, brainMode, selected?.updated]);

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
      if (isResizing.current) { isResizing.current = false; document.body.style.cursor = ''; }
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => { window.removeEventListener('mousemove', handleMove); window.removeEventListener('mouseup', handleUp); };
  }, []);

  const svgRef = useRef(null);
  const panRef = useRef({ x: 0, y: 0, zoom: 1 });
  const panDragRef = useRef(null);
  const dragRef = useRef(null);
  const simAlpha = useRef(1.0);
  const [, forceRender] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  // Animation loop to relax node positions in real-time
  useEffect(() => {
    if (view !== 'graph' || !sim) return;
    let animId;
    const run = () => {
      if (simAlpha.current > 0.005) {
        const draggedNode = dragRef.current ? dragRef.current.node : null;
        tick(sim.nodes, sim.links, draggedNode);
        
        // Cool down if not dragging
        if (!draggedNode) {
          simAlpha.current *= 0.98;
        } else {
          simAlpha.current = 1.0;
        }
        
        forceRender((v) => v + 1);
      }
      animId = requestAnimationFrame(run);
    };
    animId = requestAnimationFrame(run);
    return () => cancelAnimationFrame(animId);
  }, [view, sim]);

  // Load graph data.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.fetchBrainGraph(brainMode)
      .then((data) => {
        if (cancelled) return;
        setSim(settle(initSimulation(data)));
        simAlpha.current = 1.0;
        setLoading(false);
      })
      .catch((err) => { console.error('Brain graph load failed:', err); if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [brainMode, reloadKey]);

  // Poll graph data so background memory commits show up live.
  useEffect(() => {
    const timer = setInterval(() => {
      api.fetchBrainGraph(brainMode)
        .then((data) => {
          setSim((currSim) => {
            if (!currSim) return settle(initSimulation(data));

            const sig = (n) => `${n.id}:${n.type}`;
            const currNodeIds = currSim.nodes.map(sig).sort().join(',');
            const newNodeIds = data.nodes.map(sig).sort().join(',');
            const currLinkKeys = currSim.links.map((l) => `${l.source.id}->${l.target.id}`).sort().join(',');
            const newLinkKeys = data.links.map((l) => `${l.source}->${l.target}`).sort().join(',');

            if (currNodeIds === newNodeIds && currLinkKeys === newLinkKeys) {
              // Same structure — refresh in place, keep positions/colours.
              const updatedNodes = currSim.nodes.map((n) => {
                const nn = data.nodes.find((x) => x.id === n.id);
                return nn ? {
                  ...n, label: nn.label || nn.id, degree: nn.val,
                  updated: nn.updated, created: nn.created, event_count: nn.event_count || 0,
                  status: nn.status || '', tags: nn.tags || [], relationship: nn.relationship || '',
                } : n;
              });
              const byId = {};
              updatedNodes.forEach((n) => { byId[n.id] = n; });
              const updatedLinks = currSim.links
                .map((l) => ({ source: byId[l.source.id], target: byId[l.target.id] }))
                .filter((l) => l.source && l.target);
              syncOpenNode(data);
              return { nodes: updatedNodes, links: updatedLinks, legend: currSim.legend };
            }

            const s = settle(initSimulation(data));
            syncOpenNode(data, true);
            simAlpha.current = 1.0;
            return s;
          });
        })
        .catch((err) => console.error('Real-time background graph sync failed:', err));
    }, 2500);

    function syncOpenNode(data, structureChanged) {
      const cur = selectedRef.current;
      if (!cur) return;
      const exists = data.nodes.some((n) => n.id === cur.id);
      if (structureChanged && !exists) { setSelected(null); return; }
      const nn = data.nodes.find((n) => n.id === cur.id);
      if (nn && nn.updated !== cur.updated) {
        api.fetchBrainFile(brainMode, cur.id)
          .then((fileData) => {
            setSelected((prev) => (prev && prev.id === cur.id ? { ...prev, updated: nn.updated } : prev));
            setEditorContent((prevContent) => (prevContent === serverContentRef.current ? (fileData.content || '') : prevContent));
            serverContentRef.current = fileData.content || '';
          })
          .catch((err) => console.error('Failed to sync open brain file:', err));
      }
    }
    return () => clearInterval(timer);
  }, [brainMode]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await api.fetchBrainGraph(brainMode);
      setSim(() => settle(initSimulation(data)));
      simAlpha.current = 1.0;
    } catch (err) {
      console.error('Brain graph refresh failed:', err);
    } finally {
      setRefreshing(false);
    }
  }, [brainMode]);

  const selectNodeById = useCallback(async (id, label, updated) => {
    setView('graph');
    try {
      const data = await api.fetchBrainFile(brainMode, id);
      setSelected({ id, label: label || id, updated: updated || '' });
      setEditorContent(data.content || '');
      serverContentRef.current = data.content || '';
      setEditorTab('preview');
    } catch (err) {
      console.error('Brain file load failed:', err);
    }
  }, [brainMode]);

  const handleNodeClick = useCallback((node) => selectNodeById(node.id, node.label, node.updated), [selectNodeById]);

  const handleSave = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await api.saveBrainFile(brainMode, selected.id, editorContent);
      serverContentRef.current = editorContent;
      const data = await api.fetchBrainGraph(brainMode);
      const updatedNode = data.nodes.find((n) => n.id === selected.id);
      setSelected({ id: selected.id, label: selected.label, updated: updatedNode ? updatedNode.updated : selected.updated });
      setSim(() => settle(initSimulation(data)));
      simAlpha.current = 1.0;
    } catch (err) {
      console.error('Brain file save failed:', err);
      alert('Save failed. Keep the --- frontmatter (created/updated/type) and balanced [[links]].');
    } finally {
      setSaving(false);
    }
  }, [brainMode, selected, editorContent]);

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    if (!window.confirm(`Delete "${selected.label || selected.id}"?`)) return;
    try {
      await api.deleteBrainFile(brainMode, selected.id);
      setSelected(null);
      const data = await api.fetchBrainGraph(brainMode);
      setSim(() => settle(initSimulation(data)));
      simAlpha.current = 1.0;
    } catch (err) {
      console.error('Brain file delete failed:', err);
    }
  }, [brainMode, selected]);

  const handleRenameSave = useCallback(async () => {
    if (!selected || !newName.trim()) return;
    const cleanName = newName.trim();
    if (cleanName === selected.id || cleanName === selected.label) { setIsRenaming(false); return; }
    setSaving(true);
    try {
      await api.renameBrainFile(brainMode, selected.id, cleanName);
      setIsRenaming(false);
      const data = await api.fetchBrainGraph(brainMode);
      const updatedNode = data.nodes.find((n) => n.id === cleanName);
      setSelected({ id: cleanName, label: cleanName, updated: updatedNode ? updatedNode.updated : '' });
      setSim(() => settle(initSimulation(data)));
      simAlpha.current = 1.0;
    } catch (err) {
      console.error('Brain file rename failed:', err);
      alert(err.message || 'Rename failed. Use a unique name with no spaces/slashes.');
    } finally {
      setSaving(false);
    }
  }, [brainMode, selected, newName]);

  const handleResetBrain = useCallback(async () => {
    if (!window.confirm('Reset the entire brain? This erases all nodes and starts fresh (you\'ll be asked for your name again).')) return;
    try {
      await api.resetBrain(brainMode);
      (onReset || onClose)();
    } catch (err) {
      console.error('Brain reset failed:', err);
      alert('Reset failed.');
    }
  }, [brainMode, onReset, onClose]);

  const handleMouseDown = useCallback((e, node) => {
    e.stopPropagation();
    if (node) {
      node.dragging = true;
      dragRef.current = { node, startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y };
      simAlpha.current = 1.0;
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
      
      simAlpha.current = 1.0;
      forceRender((v) => v + 1);
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
      simAlpha.current = 1.0;
      forceRender((v) => v + 1);
    }
    panDragRef.current = null;
  }, []);
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.92 : 1.08;
    panRef.current.zoom = Math.max(0.2, Math.min(4, panRef.current.zoom * delta));
    forceRender((v) => v + 1);
  }, []);

  const closeButton = (
    <button id="brain-explorer-close" className="brain-explorer-close" onClick={onClose} aria-label="Close brain explorer">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15 18 9 12 15 6" />
      </svg>
      <span className="brain-explorer-close-label">Back to chat</span>
    </button>
  );

  const tabBar = (
    <div className="brain-view-tabs">
      {VIEWS.map((v) => (
        <button
          key={v.key}
          className={`brain-view-tab${view === v.key ? ' active' : ''}`}
          onClick={() => setView(v.key)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );

  const activityLog = hasActivity && (
    <div className={`brain-activity-log${logCollapsed ? ' collapsed' : ''}`}>
      <button
        type="button"
        className="brain-activity-log-header"
        onClick={() => setLogCollapsed((c) => !c)}
        aria-expanded={!logCollapsed}
        aria-label={logCollapsed ? 'Expand memory activity log' : 'Collapse memory activity log'}
      >
        {act.processing && <span className="brain-activity-log-spinner" />}
        <span className="brain-activity-log-title">{act.processing ? 'Updating memory' : 'Memory activity'}</span>
        <svg className={`brain-log-chevron${logCollapsed ? ' collapsed' : ''}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {!logCollapsed && (
        <div className="brain-activity-log-body" ref={logScroll.containerRef} onScroll={logScroll.onScroll}>
          {displayEvents.map((e) => (
            <div key={e.seq} className={`brain-log-line brain-log-${e.type}`}>
              <span className="brain-log-ts">{e.ts}</span>
              <span className="brain-log-text">{e.text}</span>
            </div>
          ))}
          {act.stream && detailedLogs && (
            <div className="brain-log-line brain-log-stream">
              <span className="brain-log-text">{act.stream}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );

  // --- Non-graph views ------------------------------------------------------
  if (view !== 'graph') {
    let pane = null;
    if (view === 'calendar') pane = <BrainCalendar brainMode={brainMode} onSelectNode={selectNodeById} />;
    else if (view === 'journal') pane = <BrainJournal brainMode={brainMode} onSelectNode={selectNodeById} />;
    else if (view === 'tasks') pane = <BrainTasks brainMode={brainMode} onSelectNode={selectNodeById} />;
    else if (view === 'people') pane = <BrainPeople brainMode={brainMode} onSelectNode={selectNodeById} />;
    else if (view === 'assistant') pane = <BrainAssistant brainMode={brainMode} />;
    return (
      <div className="brain-explorer">
        {closeButton}
        {tabBar}
        <div className="brain-explorer-body">{pane}</div>
        {activityLog}
      </div>
    );
  }

  // --- Graph view -----------------------------------------------------------
  if (loading) {
    return (
      <div className="brain-explorer">
        {closeButton}
        {tabBar}
        <div className="brain-explorer-loading"><span className="brain-explorer-loading-text">Loading brain graph…</span></div>
      </div>
    );
  }
  if (!sim) return null;

  const { nodes, links, legend } = sim;
  const pan = panRef.current;
  const svgWidth = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const svgHeight = typeof window !== 'undefined' ? window.innerHeight - 60 : 800;
  const cx = svgWidth / 2 + pan.x;
  const cy = svgHeight / 2 + pan.y;
  const rightOffset = (selected ? paneWidth : 0) + 19;

  return (
    <div className="brain-explorer">
      {closeButton}
      {tabBar}

      <div className="brain-explorer-toolbar" style={{ right: `${rightOffset}px` }}>
        <button id="brain-refresh-btn" className="brain-refresh-btn" onClick={handleRefresh} disabled={refreshing} aria-label="Refresh brain view" title="Refresh brain view">
          <svg className={`brain-refresh-icon${refreshing ? ' spinning' : ''}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          <span className="brain-refresh-label">Refresh</span>
        </button>
      </div>

      <div className={`brain-explorer-body ${selected ? 'split' : ''}`}>
        <svg
          ref={svgRef}
          className="brain-graph-svg"
          width="100%" height="100%"
          onMouseDown={handleBgMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
        >
          <defs>
            <filter id="node-glow">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          <rect className="brain-bg-rect" width="100%" height="100%" fill="#fafafc" />
          <g transform={`translate(${cx}, ${cy}) scale(${pan.zoom})`}>
            {links.map((l, i) => (
              <line key={i} x1={l.source.x} y1={l.source.y} x2={l.target.x} y2={l.target.y}
                stroke={(l.target.color && l.target.depth > 1) ? l.target.color : 'rgba(0,0,0,0.12)'}
                strokeOpacity={l.target.depth > 1 ? 0.35 : 1} strokeWidth={1.5} />
            ))}
            {nodes.map((n) => (
              <g key={n.id} className="brain-node-group" style={{ cursor: 'pointer' }}>
                <circle cx={n.x} cy={n.y} r={n.radius + 4} fill={n.color} opacity={0.15} filter="url(#node-glow)" />
                <circle
                  cx={n.x} cy={n.y} r={n.radius}
                  fill={n.color}
                  stroke={selected?.id === n.id ? '#1e293b' : 'rgba(255,255,255,0.85)'}
                  strokeWidth={selected?.id === n.id ? 3 : 2}
                  onMouseDown={(e) => handleMouseDown(e, n)}
                  onClick={() => handleNodeClick(n)}
                  style={{ cursor: 'pointer' }}
                />

                <text x={n.x} y={n.y + n.radius + 14} textAnchor="middle" fill="rgba(30,41,59,0.9)" fontSize="11" fontFamily="'Plus Jakarta Sans', sans-serif" fontWeight="600" style={{ pointerEvents: 'none', userSelect: 'none' }}>
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
                  <input type="text" className="brain-editor-rename-input" value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleRenameSave(); if (e.key === 'Escape') setIsRenaming(false); }}
                    autoFocus />
                  <button className="brain-editor-rename-btn confirm" onClick={handleRenameSave} aria-label="Confirm rename" disabled={saving}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                  </button>
                  <button className="brain-editor-rename-btn cancel" onClick={() => setIsRenaming(false)} aria-label="Cancel rename" disabled={saving}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </button>
                </div>
              ) : (
                <div className="brain-editor-filename-container">
                  <span className="brain-editor-filename">{selected.label || selected.id}</span>
                  {selected.id !== ROOT_ID && (
                    <button className="brain-editor-rename-toggle" onClick={() => { setNewName(selected.label || selected.id); setIsRenaming(true); }} aria-label="Rename node">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                  )}
                </div>
              )}
              <button id="brain-editor-close" className="brain-editor-close-btn" onClick={() => setSelected(null)} aria-label="Close editor">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
            <div className="brain-editor-tabs">
              <button className={`brain-editor-tab-btn ${editorTab === 'preview' ? 'active' : ''}`} onClick={() => setEditorTab('preview')}>Preview</button>
              <button className={`brain-editor-tab-btn ${editorTab === 'edit' ? 'active' : ''}`} onClick={() => setEditorTab('edit')}>Edit</button>
            </div>
            {editorTab === 'preview' ? (
              <div className="brain-editor-content brain-editor-preview markdown-body" dangerouslySetInnerHTML={{ __html: marked.parse(editorContent || '*No content*') }} />
            ) : (
              <textarea id="brain-editor-textarea" className="brain-editor-content" value={editorContent} onChange={(e) => setEditorContent(e.target.value)} />
            )}

            {nodeRefs && (nodeRefs.calendar.length > 0 || nodeRefs.journal.length > 0 || nodeRefs.assistant) && (
              <div className="brain-refs-panel">
                <div className="brain-refs-title">Referenced by</div>
                {nodeRefs.calendar.map((c, i) => (
                  <div key={`c${i}`} className="brain-ref-line"><span className="brain-ref-kind cal">Calendar</span>{c.text}</div>
                ))}
                {nodeRefs.journal.map((j, i) => (
                  <div key={`j${i}`} className="brain-ref-line"><span className="brain-ref-kind jrn">{j.date}</span>{j.text}</div>
                ))}
                {nodeRefs.assistant && (
                  <div className="brain-ref-line"><span className="brain-ref-kind asst">Assistant</span>A behaviour rule references this node.</div>
                )}
              </div>
            )}

            <div className="brain-editor-actions">
              {selected.id !== ROOT_ID && (
                <button id="brain-editor-delete" className="brain-editor-delete-btn" onClick={handleDelete} disabled={saving}>Delete</button>
              )}
               <button id="brain-editor-save" className="brain-editor-save-btn" onClick={handleSave} disabled={saving}>Save</button>
            </div>
          </div>
        )}
      </div>


      {activityLog}
    </div>
  );
}
