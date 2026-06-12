// The Journal view: renders day-by-day logs, highlighting today.
// Renders markdown in log items, replaces inline @mentions with clickable chips,
// and utilizes click bubbling to trigger navigation to referenced nodes.

import React, { useState, useEffect } from 'react';
import * as api from '../api/client';
import { marked } from '../lib/markdown';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${WEEKDAYS[dt.getDay()]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

function replaceMentionsWithTags(text) {
  if (!text) return '';
  return text.replace(/(?<![A-Za-z0-9_])@([A-Za-z0-9_]+)/g, (match, name) => {
    return `<button class="brain-ref-chip" data-node="${name}">${name}</button>`;
  });
}

export default function BrainJournal({ brainMode, onSelectNode }) {
  const [days, setDays] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => api.fetchBrainJournal(brainMode)
      .then((d) => { if (!cancelled) setDays(d.days || []); })
      .catch(() => { if (!cancelled) setDays([]); });
    load();
    const t = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, [brainMode]);

  const handleJournalClick = (e) => {
    const chip = e.target.closest('.brain-ref-chip');
    if (chip) {
      const nodeName = chip.getAttribute('data-node');
      if (nodeName && onSelectNode) {
        onSelectNode(nodeName);
      }
    }
  };

  if (days === null) {
    return <div className="brain-view-pane"><div className="brain-view-empty">Loading journal…</div></div>;
  }
  if (days.length === 0) {
    return <div className="brain-view-pane"><div className="brain-view-empty">The journal is empty. It fills in as you chat through the day.</div></div>;
  }

  const todayIso = new Date().toISOString().slice(0, 10);

  return (
    <div className="brain-view-pane brain-journal-pane" onClick={handleJournalClick}>
      <h2 className="brain-view-title">Journal</h2>
      {days.map((day) => (
        <section key={day.date} className={`brain-journal-day${day.date === todayIso ? ' today' : ''}`}>
          <h3 className="brain-journal-date">
            {fmtDay(day.date)}
            {day.date === todayIso
              ? <span className="brain-journal-badge live">Today</span>
              : <span className="brain-journal-badge">Read-only</span>}
          </h3>
          {day.entries.map((e, i) => (
            <div className="brain-journal-entry" key={i}>
              <span className="brain-journal-time">{e.ts}</span>
              <span 
                className="brain-journal-text"
                dangerouslySetInnerHTML={{ __html: replaceMentionsWithTags(marked.parse(e.text || '')) }}
              />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
