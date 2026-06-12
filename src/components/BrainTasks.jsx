// Taskboard: a derived view over `task` nodes, grouped by status, with tags
// and any due date pulled from Calendar entries that @reference the task.

import React, { useState, useEffect, useMemo } from 'react';
import * as api from '../api/client';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${d}`; };

export default function BrainTasks({ brainMode, onSelectNode }) {
  const [graph, setGraph] = useState(null);
  const [events, setEvents] = useState([]);
  const [tagFilter, setTagFilter] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => Promise.all([
      api.fetchBrainGraph(brainMode),
      api.fetchBrainCalendar(brainMode),
    ]).then(([g, c]) => {
      if (cancelled) return;
      setGraph(g.nodes || []);
      setEvents(c.events || []);
    }).catch(() => { if (!cancelled) { setGraph([]); setEvents([]); } });
    load();
    const t = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, [brainMode]);

  // node id -> earliest upcoming due date mentioned in the Calendar.
  const dueByNode = useMemo(() => {
    const map = {};
    for (const e of events) {
      if (!e.event_date) continue;
      for (const r of e.refs) {
        if (!map[r] || e.event_date < map[r]) map[r] = e.event_date;
      }
    }
    return map;
  }, [events]);

  const tasks = useMemo(() => (graph || []).filter((n) => n.type === 'task'), [graph]);
  const allTags = useMemo(() => {
    const s = new Set();
    tasks.forEach((t) => (t.tags || []).forEach((tag) => s.add(tag)));
    return [...s].sort();
  }, [tasks]);

  if (graph === null) {
    return <div className="brain-view-pane"><div className="brain-view-empty">Loading tasks…</div></div>;
  }
  if (tasks.length === 0) {
    return <div className="brain-view-pane"><div className="brain-view-empty">No tasks yet. Mention a project, assignment, or to-do in chat.</div></div>;
  }

  const shown = tagFilter ? tasks.filter((t) => (t.tags || []).includes(tagFilter)) : tasks;
  const open = shown.filter((t) => t.status !== 'done');
  const done = shown.filter((t) => t.status === 'done');

  const Card = ({ t }) => (
    <button className={`brain-task-card${t.status === 'done' ? ' done' : ''}`} onClick={() => onSelectNode?.(t.id)}>
      <div className="brain-task-name">{t.label || t.id}</div>
      {t.description && <div className="brain-task-desc">{t.description}</div>}
      <div className="brain-task-meta">
        {dueByNode[t.id] && <span className="brain-task-due">Due {fmtDate(dueByNode[t.id])}</span>}
        {(t.tags || []).map((tag) => <span key={tag} className="brain-task-tag">{tag}</span>)}
      </div>
    </button>
  );

  return (
    <div className="brain-view-pane brain-tasks-pane">
      <h2 className="brain-view-title">Tasks</h2>
      {allTags.length > 0 && (
        <div className="brain-task-filters">
          <button className={`brain-task-filter${!tagFilter ? ' active' : ''}`} onClick={() => setTagFilter(null)}>All</button>
          {allTags.map((tag) => (
            <button key={tag} className={`brain-task-filter${tagFilter === tag ? ' active' : ''}`} onClick={() => setTagFilter(tag)}>{tag}</button>
          ))}
        </div>
      )}
      <div className="brain-task-columns">
        <div className="brain-task-col">
          <h3 className="brain-task-col-title">Open <span>{open.length}</span></h3>
          {open.map((t) => <Card key={t.id} t={t} />)}
        </div>
        <div className="brain-task-col">
          <h3 className="brain-task-col-title">Done <span>{done.length}</span></h3>
          {done.map((t) => <Card key={t.id} t={t} />)}
        </div>
      </div>
    </div>
  );
}
