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
import * as Lucide from 'lucide-react';

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

function parseFrontmatter(content) {
  if (!content) return { frontmatter: {}, body: '' };
  const match = content.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  const yamlText = match[1];
  const bodyText = match[2];
  const frontmatter = {};
  const lines = yamlText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex !== -1) {
      const key = trimmed.substring(0, colonIndex).trim();
      const val = trimmed.substring(colonIndex + 1).trim();
      frontmatter[key] = val;
    }
  }
  return { frontmatter, body: bodyText };
}

function replaceMentionsWithTags(text) {
  if (!text) return '';
  return text.replace(/(?<![A-Za-z0-9_])@([A-Za-z0-9_]+)/g, (match, name) => {
    return `<button class="brain-ref-chip" data-node="${name}">${name}</button>`;
  });
}

function replaceWikiLinksWithTags(text) {
  if (!text) return '';
  return text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, node, label) => {
    const targetNode = node.trim();
    const displayLabel = label ? label.trim() : targetNode;
    return `<button class="brain-ref-chip" data-node="${targetNode}">${displayLabel}</button>`;
  });
}

function getArcPath(l, bend = 0.22) {
  const x1 = l.source.x;
  const y1 = l.source.y;
  const x2 = l.target.x;
  const y2 = l.target.y;

  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy);
  if (dist < 10) return `M ${x1} ${y1} L ${x2} ${y2}`;

  const targetRadius = l.target.radius || 15;
  const x2_adj = x2 - (dx / dist) * (targetRadius + 6);
  const y2_adj = y2 - (dy / dist) * (targetRadius + 6);

  const mx = (x1 + x2_adj) / 2;
  const my = (y1 + y2_adj) / 2;

  const px = -dy / dist;
  const py = dx / dist;

  const dot = mx * px + my * py;
  const dir = dot >= 0 ? 1 : -1;

  const h = dist * bend * dir;
  const cx = mx + px * h;
  const cy = my + py * h;

  return `M ${x1} ${y1} Q ${cx} ${cy} ${x2_adj} ${y2_adj}`;
}

// Build the laid-out graph: BFS depth from the root drives the radial layout;
// the depth-1 branch a node descends from is its cluster (→ hue); the node's
// type drives its icon.
function initSimulation(graphData, nodeSizeMult = 1.2, edgeLength = 200) {
  const rawNodes = graphData.nodes || [];
  const rawLinks = graphData.links || [];
  const ids = new Set(rawNodes.map((n) => n.id));

  const adj = {};
  rawNodes.forEach((n) => { adj[n.id] = []; });
  rawLinks.forEach((l) => {
    if (adj[l.source] && adj[l.target]) {
      adj[l.source].push(l.target);
      adj[l.target].push(l.source);
    }
  });

  // 1. Build strict tree using BFS from the User root
  const depth = {};
  const parent = {};
  const treeChildren = {};
  rawNodes.forEach((n) => { treeChildren[n.id] = []; });

  const hasRoot = ids.has(ROOT_ID);
  if (hasRoot) {
    depth[ROOT_ID] = 0;
    const q = [ROOT_ID];
    while (q.length) {
      const u = q.shift();
      for (const v of adj[u]) {
        if (depth[v] === undefined) {
          depth[v] = depth[u] + 1;
          parent[v] = u;
          treeChildren[u].push(v);
          q.push(v);
        }
      }
    }
  }

  // Handle orphans by attaching them to the root
  rawNodes.forEach((n) => {
    if (depth[n.id] === undefined) {
      depth[n.id] = 1;
      parent[n.id] = ROOT_ID;
      treeChildren[ROOT_ID].push(n.id);
    }
  });

  // 2. Compute subtree sizes for proportional angular allocation
  const subtreeSize = {};
  function calcSubtreeSize(nodeId) {
    let size = 1;
    const children = treeChildren[nodeId] || [];
    children.forEach((childId) => {
      size += calcSubtreeSize(childId);
    });
    subtreeSize[nodeId] = size;
    return size;
  }
  if (hasRoot) {
    calcSubtreeSize(ROOT_ID);
  }

  // 3. Recursively calculate parent-child non-overlapping fanned sectors
  const pos = {};
  if (hasRoot) {
    pos[ROOT_ID] = { x: 0, y: 0, angle: -Math.PI / 2 };
  }

  function layoutSubtree(nodeId, centerAngle, angularSpan, depthVal) {
    const children = treeChildren[nodeId] || [];
    if (children.length === 0) return;

    // 1. Group children to place connected siblings (twins) next to each other
    const childSet = new Set(children);
    const siblingLinks = rawLinks.filter(l => childSet.has(l.source) && childSet.has(l.target));
    
    const sibAdj = {};
    children.forEach(c => { sibAdj[c] = []; });
    siblingLinks.forEach(l => {
      sibAdj[l.source].push(l.target);
      sibAdj[l.target].push(l.source);
    });

    const sortedChildren = [];
    const remaining = new Set(children);
    while (remaining.size > 0) {
      const first = Array.from(remaining)[0];
      remaining.delete(first);
      sortedChildren.push(first);
      
      const twins = sibAdj[first].filter(twin => remaining.has(twin));
      if (twins.length > 0) {
        const twin = twins[0];
        remaining.delete(twin);
        sortedChildren.push(twin);
      }
    }

    // 2. Pre-calculate and layout children with their default angular shares (side-by-side)
    const totalSize = sortedChildren.reduce((sum, childId) => sum + subtreeSize[childId], 0);
    let currentAngle = centerAngle - angularSpan / 2;

    sortedChildren.forEach((childId, idx) => {
      const share = (subtreeSize[childId] / totalSize) * angularSpan;
      const childAngle = currentAngle + share / 2;
      const parentPos = pos[nodeId];
      const baseLen = depthVal === 1 ? edgeLength : 110;
      const len = baseLen + (depthVal > 1 && sortedChildren.length > 3 ? (idx % 2) * 20 : 0);

      pos[childId] = {
        x: parentPos.x + Math.cos(childAngle) * len,
        y: parentPos.y + Math.sin(childAngle) * len,
        angle: childAngle
      };

      const nextSpan = depthVal === 1 ? Math.PI * 0.8 : Math.PI * 0.5;
      layoutSubtree(childId, childAngle, nextSpan, depthVal + 1);

      currentAngle += share;
    });
  }

  if (hasRoot) {
    // Distribute root children over the full circle fanning outwards
    layoutSubtree(ROOT_ID, -Math.PI / 2, Math.PI * 2, 1);
  }

  // Fallback positioning for safety
  rawNodes.forEach((n, idx) => {
    if (!pos[n.id]) {
      const a = (idx / rawNodes.length) * Math.PI * 2;
      pos[n.id] = { x: Math.cos(a) * edgeLength, y: Math.sin(a) * edgeLength, angle: a };
    }
  });

  const degree = {};
  rawNodes.forEach((n) => { degree[n.id] = adj[n.id].length; });

  const colorOf = (id) => {
    if (id === ROOT_ID) return '#475569';
    let cur = id;
    while (parent[cur] && parent[cur] !== ROOT_ID) {
      cur = parent[cur];
    }
    const branches = treeChildren[ROOT_ID] || [];
    const bIdx = branches.indexOf(cur);
    const hue = bIdx >= 0 ? Math.round((360 * bIdx) / Math.max(1, branches.length)) : 180;
    if (depth[id] === 1) return `hsl(${hue} 62% 48%)`;
    const jit = (hashStr(id) % 17) - 8;
    return `hsl(${(hue + jit + 360) % 360} 55% 64%)`;
  };

  const nodes = rawNodes.map((n) => {
    const isRoot = n.id === ROOT_ID;
    const deg = degree[n.id] || 0;
    const radius = (isRoot ? 26
      : depth[n.id] === 1 ? 16 + Math.min(deg, 8) * 1.5
        : 9 + Math.min(deg, 6) * 1.2) * nodeSizeMult;
    return {
      id: n.id,
      label: n.label || n.id,
      x: pos[n.id].x,
      y: pos[n.id].y,
      targetX: pos[n.id].x,
      targetY: pos[n.id].y,
      vx: 0, vy: 0,
      radius,
      color: colorOf(n.id),
      depth: depth[n.id] || 1,
      cluster: parent[n.id] || null,
      type: n.type || 'leaf',
      icon: n.icon || '',
      isRoot, pinned: isRoot,
      degree: deg,
      event_count: n.event_count || 0,
      status: n.status || '', tags: n.tags || [], relationship: n.relationship || '',
      updated: n.updated || '', created: n.created || '',
      targetAngle: pos[n.id].angle,
    };
  });

  const byId = {};
  nodes.forEach((n) => { byId[n.id] = n; });

  const links = [];
  const crossLinks = [];
  const seenLinks = new Set();
  const seenCrossLinks = new Set();

  rawLinks.forEach((l) => {
    if (byId[l.source] && byId[l.target]) {
      const u = l.source;
      const v = l.target;
      const pairKey = u < v ? `${u}-${v}` : `${v}-${u}`;
      const isTreeLink = (parent[u] === v) || (parent[v] === u);
      if (isTreeLink) {
        if (!seenLinks.has(pairKey)) {
          seenLinks.add(pairKey);
          const parentNode = parent[u] === v ? byId[v] : byId[u];
          const childNode = parent[u] === v ? byId[u] : byId[v];
          links.push({ source: parentNode, target: childNode });
        }
      } else {
        if (!seenCrossLinks.has(pairKey)) {
          seenCrossLinks.add(pairKey);
          crossLinks.push({ source: byId[u], target: byId[v] });
        }
      }
    }
  });

  const branches = treeChildren[ROOT_ID] || [];
  const legend = branches.map((b, i) => {
    const hue = Math.round((360 * i) / Math.max(1, branches.length));
    return { id: b, label: byId[b]?.label || b, hue };
  });

  return { nodes, links, crossLinks, legend };
}

function tick(nodes, links, draggedNode) {
  // Linearly interpolate non-dragged nodes back to their clean, non-crossing tree layouts
  nodes.forEach((n) => {
    if (n.pinned || n === draggedNode) {
      n.vx = 0; n.vy = 0;
      if (n.isRoot) { n.x = 0; n.y = 0; }
      return;
    }
    const targetX = n.targetX !== undefined ? n.targetX : 0;
    const targetY = n.targetY !== undefined ? n.targetY : 0;
    
    // Smooth transition
    n.x += (targetX - n.x) * 0.15;
    n.y += (targetY - n.y) * 0.15;
    n.vx = 0;
    n.vy = 0;
  });
}

function settle(s) {
  // Static layout doesn't need physics settling
  return s;
}

// Render a customized Lucide icon inside the node, falling back to a clean default based on type.
function NodeIcon({ name, type, size }) {
  // Resolve key name to PascalCase
  const cleanName = (name || '').trim();
  let pascalName = '';
  
  if (type === 'user') {
    pascalName = 'Crown';
  } else if (cleanName) {
    pascalName = cleanName
      .split(/[-_ ]+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join('');
  }

  // Fallback to type if no icon specified
  if (!pascalName) {
    switch (type) {
      case 'user':
        pascalName = 'Crown'; break;
      case 'person':
        pascalName = 'User2'; break;
      case 'activity':
        pascalName = 'Activity'; break;
      case 'task':
        pascalName = 'CheckSquare'; break;
      case 'group':
        pascalName = 'Folder'; break;
      case 'place':
        pascalName = 'MapPin'; break;
      case 'pet':
        pascalName = 'Dog'; break;
      case 'goal':
        pascalName = 'Target'; break;
      default:
        pascalName = 'HelpCircle';
    }
  }

  let IconComponent = Lucide[pascalName] || Lucide[pascalName + 'Icon'] || Lucide.HelpCircle;
  if (!IconComponent || typeof IconComponent !== 'function' && typeof IconComponent !== 'object') {
    IconComponent = Lucide.HelpCircle;
  }

  return (
    <g transform={`translate(${-size / 2}, ${-size / 2})`} style={{ pointerEvents: 'none' }}>
      <IconComponent size={size} color="#ffffff" strokeWidth={2.2} style={{ opacity: 0.95 }} />
    </g>
  );
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
  const [hoveredNodeId, setHoveredNodeId] = useState(null);

  const nodeSizeMult = 1.2;
  const edgeLength = 200;

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

  const selectedConnections = useMemo(() => {
    if (!selected || !sim) return null;
    const nodeId = selected.id;
    const incoming = [];
    const outgoing = [];

    sim.links.forEach((l) => {
      if (l.source.id === nodeId) {
        outgoing.push({ id: l.target.id, label: l.target.label, type: l.target.type });
      } else if (l.target.id === nodeId) {
        incoming.push({ id: l.source.id, label: l.source.label, type: l.source.type });
      }
    });

    if (sim.crossLinks) {
      sim.crossLinks.forEach((l) => {
        if (l.source.id === nodeId) {
          outgoing.push({ id: l.target.id, label: l.target.label, type: l.target.type });
        } else if (l.target.id === nodeId) {
          incoming.push({ id: l.source.id, label: l.source.label, type: l.source.type });
        }
      });
    }

    // Deduplicate lists by ID
    const uniqueIn = Array.from(new Map(incoming.map(item => [item.id, item])).values());
    const uniqueOut = Array.from(new Map(outgoing.map(item => [item.id, item])).values());

    return { incoming: uniqueIn, outgoing: uniqueOut };
  }, [selected?.id, sim]);

  const { frontmatter, body } = useMemo(() => {
    return parseFrontmatter(editorContent);
  }, [editorContent]);



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
        setSim(settle(initSimulation(data, nodeSizeMult, edgeLength)));
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
              const updatedCrossLinks = (currSim.crossLinks || [])
                .map((l) => ({ source: byId[l.source.id], target: byId[l.target.id] }))
                .filter((l) => l.source && l.target);
              syncOpenNode(data);
              return { nodes: updatedNodes, links: updatedLinks, crossLinks: updatedCrossLinks, legend: currSim.legend };
            }

            const s = settle(initSimulation(data, nodeSizeMult, edgeLength));
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
      setSim(() => settle(initSimulation(data, nodeSizeMult, edgeLength)));
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

  const handleEditorPaneClick = useCallback((e) => {
    const chip = e.target.closest('.brain-ref-chip');
    if (chip) {
      const nodeName = chip.getAttribute('data-node');
      if (nodeName) {
        selectNodeById(nodeName, nodeName);
      }
    }
  }, [selectNodeById]);

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
      setSelected(null);
    }
  }, [setSelected]);
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
    const zoomFactor = Math.exp(-e.deltaY * 0.0015);
    panRef.current.zoom = Math.max(0.2, Math.min(4, panRef.current.zoom * zoomFactor));
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
            <marker
              id="cross-arrow"
              viewBox="0 0 10 10"
              refX="6"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 Z" fill="#7c6fc4" />
            </marker>
          </defs>
          <rect className="brain-bg-rect" width="100%" height="100%" fill="#fafafc" />
          <g transform={`translate(${cx}, ${cy}) scale(${pan.zoom})`}>
            {links.map((l, i) => (
              <line key={i} x1={l.source.x} y1={l.source.y} x2={l.target.x} y2={l.target.y}
                stroke={(l.target.color && l.target.depth > 1) ? l.target.color : 'rgba(0,0,0,0.12)'}
                strokeOpacity={l.target.depth > 1 ? 0.35 : 1} strokeWidth={1.5} />
            ))}
            {(sim.crossLinks || []).map((l, i) => {
              const isHovered = hoveredNodeId && (l.source.id === hoveredNodeId || l.target.id === hoveredNodeId);
              const isOutgoing = l.source.id === hoveredNodeId;
              return (
                <line
                  key={`cross-${i}`}
                  x1={l.source.x}
                  y1={l.source.y}
                  x2={l.target.x}
                  y2={l.target.y}
                  className={`brain-graph-cross-link ${isHovered ? 'hovered' : ''} ${isHovered ? (isOutgoing ? 'outgoing' : 'incoming') : ''}`}
                />
              );
            })}
            {nodes.map((n) => (
              <g
                key={n.id}
                className={`brain-node-group ${selected?.id === n.id ? 'selected' : ''} ${hoveredNodeId === n.id ? 'hovered' : ''}`}
                style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHoveredNodeId(n.id)}
                onMouseLeave={() => setHoveredNodeId(null)}
              >
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
                <g transform={`translate(${n.x}, ${n.y})`} style={{ pointerEvents: 'none' }}>
                  <NodeIcon name={n.icon} type={n.type} size={n.radius * 1.1} />
                </g>

                <text x={n.x} y={n.y + n.radius + 14} textAnchor="middle" fill="rgba(30,41,59,0.9)" fontSize="11" fontFamily="'Plus Jakarta Sans', sans-serif" fontWeight="600" style={{ pointerEvents: 'none', userSelect: 'none' }}>
                  {n.label}
                </text>
              </g>
            ))}
          </g>
        </svg>

        {selected && (
          <div className="brain-editor-pane" style={{ width: `${paneWidth}px` }} onClick={handleEditorPaneClick}>
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
              <div className="brain-editor-content brain-editor-preview markdown-body">
                {Object.keys(frontmatter).length > 0 && (
                  <div className="brain-node-meta-header">
                    {Object.entries(frontmatter).map(([key, val]) => (
                      <div key={key} className="brain-node-meta-item">
                        <span className="brain-node-meta-key">{key}:</span>
                        <span className="brain-node-meta-val">{val}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div dangerouslySetInnerHTML={{ __html: replaceWikiLinksWithTags(replaceMentionsWithTags(marked.parse(body || '*No content*'))) }} />
              </div>
            ) : (
              <textarea id="brain-editor-textarea" className="brain-editor-content" value={editorContent} onChange={(e) => setEditorContent(e.target.value)} />
            )}

            {nodeRefs && (nodeRefs.calendar.length > 0 || nodeRefs.journal.length > 0 || nodeRefs.assistant) && (
              <div className="brain-refs-panel">
                <div className="brain-refs-title">Referenced by</div>
                {nodeRefs.calendar.map((c, i) => (
                  <div key={`c${i}`} className="brain-ref-line">
                    <span className="brain-ref-kind cal">Calendar</span>
                    <span dangerouslySetInnerHTML={{ __html: replaceWikiLinksWithTags(replaceMentionsWithTags(marked.parseInline(c.text || ''))) }} />
                  </div>
                ))}
                {nodeRefs.journal.map((j, i) => (
                  <div key={`j${i}`} className="brain-ref-line">
                    <span className="brain-ref-kind jrn">{j.date}</span>
                    <span dangerouslySetInnerHTML={{ __html: replaceWikiLinksWithTags(replaceMentionsWithTags(marked.parseInline(j.text || ''))) }} />
                  </div>
                ))}
                {nodeRefs.assistant && (
                  <div className="brain-ref-line"><span className="brain-ref-kind asst">Assistant</span>A behaviour rule references this node.</div>
                )}
              </div>
            )}

            {selectedConnections && (selectedConnections.incoming.length > 0 || selectedConnections.outgoing.length > 0) && (
              <div className="brain-connections-panel">
                <div className="brain-connections-title">Connections</div>
                <div className="brain-connections-body">
                  {selectedConnections.incoming.map((conn) => (
                    <button
                      key={`in-${conn.id}`}
                      className="brain-connection-chip incoming"
                      onClick={() => selectNodeById(conn.id, conn.label)}
                      title={`Linked from ${conn.label}`}
                    >
                      <span className="brain-connection-arrow">←</span>
                      <span className="brain-connection-label">{conn.label}</span>
                      <span className="brain-connection-type">{conn.type}</span>
                    </button>
                  ))}
                  {selectedConnections.outgoing.map((conn) => (
                    <button
                      key={`out-${conn.id}`}
                      className="brain-connection-chip outgoing"
                      onClick={() => selectNodeById(conn.id, conn.label)}
                      title={`Links to ${conn.label}`}
                    >
                      <span className="brain-connection-label">{conn.label}</span>
                      <span className="brain-connection-arrow">→</span>
                      <span className="brain-connection-type">{conn.type}</span>
                    </button>
                  ))}
                </div>
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

      <div className="brain-zoom-controls" style={{ right: `${rightOffset}px` }}>
        <button
          className="brain-zoom-btn"
          onClick={() => {
            panRef.current.zoom = Math.max(0.2, panRef.current.zoom - 0.1);
            forceRender((v) => v + 1);
          }}
          title="Zoom out"
          aria-label="Zoom out"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <input
          type="range"
          className="brain-zoom-slider"
          min="0.2"
          max="4"
          step="0.05"
          value={pan.zoom}
          onChange={(e) => {
            panRef.current.zoom = parseFloat(e.target.value);
            forceRender((v) => v + 1);
          }}
          aria-label="Zoom level"
        />
        <button
          className="brain-zoom-btn"
          onClick={() => {
            panRef.current.zoom = Math.min(4, panRef.current.zoom + 0.1);
            forceRender((v) => v + 1);
          }}
          title="Zoom in"
          aria-label="Zoom in"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <span className="brain-zoom-percent">{Math.round(pan.zoom * 100)}%</span>
        <button
          className="brain-zoom-reset-btn"
          onClick={() => {
            panRef.current.zoom = 1;
            panRef.current.x = 0;
            panRef.current.y = 0;
            forceRender((v) => v + 1);
          }}
          title="Reset pan and zoom"
        >
          Reset
        </button>
      </div>

      {activityLog}
    </div>
  );
}
