// People directory: a derived view over `person` nodes, showing each person's
// relationship and description, plus any birthday found in the Calendar.

import React, { useState, useEffect, useMemo } from 'react';
import * as api from '../api/client';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (iso, hasYear) => {
  const [y, m, d] = iso.split('-').map(Number);
  return hasYear ? `${MONTHS[m - 1]} ${d}, ${y}` : `${MONTHS[m - 1]} ${d}`;
};

export default function BrainPeople({ brainMode, onSelectNode }) {
  const [graph, setGraph] = useState(null);
  const [events, setEvents] = useState([]);

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

  // node id -> a birthday entry referencing it, if any.
  const birthdayByNode = useMemo(() => {
    const map = {};
    for (const e of events) {
      if (!e.event_date || !/birthday/i.test(e.text)) continue;
      for (const r of e.refs) if (!map[r]) map[r] = e;
    }
    return map;
  }, [events]);

  const people = useMemo(
    () => (graph || []).filter((n) => n.type === 'person').sort((a, b) => (a.label || a.id).localeCompare(b.label || b.id)),
    [graph]);

  if (graph === null) {
    return <div className="brain-view-pane"><div className="brain-view-empty">Loading people…</div></div>;
  }
  if (people.length === 0) {
    return <div className="brain-view-pane"><div className="brain-view-empty">No people yet. Tell the assistant about someone in your life.</div></div>;
  }

  return (
    <div className="brain-view-pane brain-people-pane">
      <h2 className="brain-view-title">People</h2>
      <div className="brain-people-grid">
        {people.map((p) => {
          const bday = birthdayByNode[p.id];
          return (
            <button key={p.id} className="brain-person-card" onClick={() => onSelectNode?.(p.id)}>
              <div className="brain-person-name">{p.label || p.id}</div>
              {p.relationship && <div className="brain-person-rel">{p.relationship}</div>}
              {p.description && <div className="brain-person-desc">{p.description}</div>}
              {bday && <div className="brain-person-bday">🎂 {fmtDate(bday.event_date, bday.has_year)}</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
