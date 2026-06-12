// The Calendar view: renders a standard monthly grid with previous/next navigation
// controls. Displays events in each day cell, highlights today, and provides a details
// side panel for listing events on the selected day and any undated items.

import React, { useState, useEffect, useMemo } from 'react';
import * as api from '../api/client';
import { marked } from '../lib/markdown';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function cleanText(text) {
  return text.replace(/(?<![A-Za-z0-9_])@[A-Za-z0-9_]+/g, '').replace(/\*\*/g, '').replace(/\s{2,}/g, ' ').trim();
}

function replaceMentionsWithTags(text) {
  if (!text) return '';
  return text.replace(/(?<![A-Za-z0-9_])@([A-Za-z0-9_]+)/g, (match, name) => {
    return `<button class="brain-ref-chip" data-node="${name}">${name}</button>`;
  });
}

export default function BrainCalendar({ brainMode, onSelectNode }) {
  const [events, setEvents] = useState(null);
  
  // Date navigation state
  const today = useMemo(() => new Date(), []);
  const [currentYear, setCurrentYear] = useState(today.getFullYear());
  const [currentMonth, setCurrentMonth] = useState(today.getMonth()); // 0-indexed
  
  // Format today's date to YYYY-MM-DD
  const pad = (num) => String(num).padStart(2, '0');
  const todayIso = useMemo(() => {
    return `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  }, [today]);

  const [selectedDateStr, setSelectedDateStr] = useState(null);
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const [showYearPicker, setShowYearPicker] = useState(false);

  const yearOptions = useMemo(() => {
    const options = [];
    const startYear = today.getFullYear() - 10;
    for (let y = startYear; y <= today.getFullYear() + 10; y++) {
      options.push(y);
    }
    return options;
  }, [today]);

  useEffect(() => {
    if (!showMonthPicker && !showYearPicker) return;
    const handleOutsideClick = () => {
      setShowMonthPicker(false);
      setShowYearPicker(false);
    };
    document.addEventListener('click', handleOutsideClick);
    return () => document.removeEventListener('click', handleOutsideClick);
  }, [showMonthPicker, showYearPicker]);

  useEffect(() => {
    let cancelled = false;
    const load = () => api.fetchBrainCalendar(brainMode)
      .then((d) => { if (!cancelled) setEvents(d.events || []); })
      .catch(() => { if (!cancelled) setEvents([]); });
    load();
    const t = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, [brainMode]);

  // Group events by date string YYYY-MM-DD, supporting yearly recurrence for birthdays/anniversaries/holidays
  const { getEventsForDate, undatedEvents } = useMemo(() => {
    const byExactDate = {};
    const yearlyEvents = [];
    const undated = [];

    if (events) {
      events.forEach((e) => {
        if (e.event_date) {
          const lowerText = (e.text || '').toLowerCase();
          const isYearly = lowerText.includes('birthday') || 
                           lowerText.includes('birth day') || 
                           lowerText.includes('anniversary') || 
                           lowerText.includes('christmas') || 
                           lowerText.includes('valentine') ||
                           lowerText.includes('yearly') ||
                           lowerText.includes('annual');

          if (isYearly) {
            yearlyEvents.push(e);
          } else {
            if (!byExactDate[e.event_date]) byExactDate[e.event_date] = [];
            byExactDate[e.event_date].push(e);
          }
        } else {
          undated.push(e);
        }
      });
    }

    const getEventsForDate = (dateStr) => {
      if (!dateStr) return [];
      const [y, m, d] = dateStr.split('-').map(Number);
      const exact = byExactDate[dateStr] || [];
      const matchingYearly = yearlyEvents.filter((e) => {
        const [ey, em, ed] = e.event_date.split('-').map(Number);
        if (em !== m || ed !== d) return false;
        // Only show recurrent events starting from their original year onwards
        if (e.has_year && y < ey) return false;
        return true;
      });

      const combined = [...exact, ...matchingYearly];
      const seen = new Set();
      const unique = [];
      combined.forEach((e) => {
        const key = `${e.ts}-${e.text}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(e);
        }
      });
      return unique;
    };

    return { getEventsForDate, undatedEvents: undated };
  }, [events]);

  const handlePrevMonth = () => {
    setCurrentMonth((m) => {
      if (m === 0) {
        setCurrentYear((y) => y - 1);
        return 11;
      }
      return m - 1;
    });
  };

  const handleNextMonth = () => {
    setCurrentMonth((m) => {
      if (m === 11) {
        setCurrentYear((y) => y + 1);
        return 0;
      }
      return m + 1;
    });
  };

  const handleGoToday = () => {
    setCurrentYear(today.getFullYear());
    setCurrentMonth(today.getMonth());
    setSelectedDateStr(todayIso);
  };

  // Generate grid cells (42 cells: 6 weeks * 7 days)
  const gridCells = useMemo(() => {
    const cells = [];
    
    // First day of current month (0 = Sunday, 6 = Saturday)
    const firstDayIndex = new Date(currentYear, currentMonth, 1).getDay();
    // Number of days in current month
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    // Number of days in previous month
    const daysInPrevMonth = new Date(currentYear, currentMonth, 0).getDate();

    // Previous month overflow days
    const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
    const prevYear = currentMonth === 0 ? currentYear - 1 : currentYear;
    for (let i = firstDayIndex - 1; i >= 0; i--) {
      const d = daysInPrevMonth - i;
      const dateStr = `${prevYear}-${pad(prevMonth + 1)}-${pad(d)}`;
      cells.push({
        day: d,
        month: prevMonth,
        year: prevYear,
        isCurrentMonth: false,
        dateStr
      });
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${currentYear}-${pad(currentMonth + 1)}-${pad(d)}`;
      cells.push({
        day: d,
        month: currentMonth,
        year: currentYear,
        isCurrentMonth: true,
        dateStr
      });
    }

    // Next month overflow days
    const nextMonth = currentMonth === 11 ? 0 : currentMonth + 1;
    const nextYear = currentMonth === 11 ? currentYear + 1 : currentYear;
    const remaining = 42 - cells.length;
    for (let d = 1; d <= remaining; d++) {
      const dateStr = `${nextYear}-${pad(nextMonth + 1)}-${pad(d)}`;
      cells.push({
        day: d,
        month: nextMonth,
        year: nextYear,
        isCurrentMonth: false,
        dateStr
      });
    }

    return cells;
  }, [currentYear, currentMonth]);

  if (events === null) {
    return <div className="brain-view-pane"><div className="brain-view-empty">Loading calendar…</div></div>;
  }

  // Get events on the selected date
  const selectedDayEvents = getEventsForDate(selectedDateStr);

  // Format selected date for header display
  const formattedSelectedDate = (() => {
    if (!selectedDateStr) return '';
    const [y, m, d] = selectedDateStr.split('-').map(Number);
    return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
  })();

  const handleDetailsClick = (e) => {
    const chip = e.target.closest('.brain-ref-chip');
    if (chip) {
      const nodeName = chip.getAttribute('data-node');
      if (nodeName && onSelectNode) {
        onSelectNode(nodeName);
      }
    }
  };

  return (
    <div className={`brain-calendar-container${selectedDateStr ? ' split' : ''}`} onClick={handleDetailsClick}>
      {/* Left panel: Monthly Grid */}
      <div className={`brain-calendar-main${selectedDateStr ? '' : ' centered'}`}>
        <div className="brain-calendar-header">
          <div className="brain-calendar-title-group">
            <h2 className="brain-calendar-month-title">
              <div className="brain-calendar-select-container">
                <span 
                  className="brain-calendar-month-label" 
                  onClick={(e) => { e.stopPropagation(); setShowMonthPicker(!showMonthPicker); setShowYearPicker(false); }}
                >
                  {MONTH_NAMES[currentMonth]}
                </span>
                {showMonthPicker && (
                  <div className="brain-calendar-picker-dropdown">
                    {MONTH_NAMES.map((m, idx) => (
                      <div 
                        key={m} 
                        className={`brain-calendar-picker-item${idx === currentMonth ? ' active' : ''}`}
                        onClick={() => { setCurrentMonth(idx); setShowMonthPicker(false); }}
                      >
                        {m}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {' '}
              <div className="brain-calendar-select-container">
                <span 
                  className="brain-calendar-year-label" 
                  onClick={(e) => { e.stopPropagation(); setShowYearPicker(!showYearPicker); setShowMonthPicker(false); }}
                >
                  {currentYear}
                </span>
                {showYearPicker && (
                  <div className="brain-calendar-picker-dropdown years">
                    {yearOptions.map((y) => (
                      <div 
                        key={y} 
                        className={`brain-calendar-picker-item${y === currentYear ? ' active' : ''}`}
                        onClick={() => { setCurrentYear(y); setShowYearPicker(false); }}
                      >
                        {y}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </h2>
            <button className="brain-calendar-today-btn" onClick={handleGoToday}>
              Today
            </button>
          </div>
          <div className="brain-calendar-nav">
            <button 
              className="brain-calendar-nav-btn" 
              onClick={handlePrevMonth}
              aria-label="Previous Month"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6"></polyline>
              </svg>
            </button>
            <button 
              className="brain-calendar-nav-btn" 
              onClick={handleNextMonth}
              aria-label="Next Month"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </button>
          </div>
        </div>

        <div className="brain-calendar-grid">
          {WEEKDAYS.map((day) => (
            <div key={day} className="brain-calendar-day-header">
              {day}
            </div>
          ))}
          {gridCells.map((cell, idx) => {
            const cellEvents = getEventsForDate(cell.dateStr);
            const isToday = cell.dateStr === todayIso;
            const isSelected = cell.dateStr === selectedDateStr;
            
            return (
              <div 
                key={idx} 
                className={`brain-calendar-day-cell${!cell.isCurrentMonth ? ' other-month' : ''}${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}`}
                onClick={() => setSelectedDateStr(cell.dateStr)}
              >
                <span className="brain-calendar-day-num">{cell.day}</span>
                <div className="brain-calendar-cell-events">
                  {cellEvents.slice(0, 2).map((ev, i) => (
                    <div key={i} className="brain-calendar-cell-event-pill" title={ev.text}>
                      {cleanText(ev.text)}
                    </div>
                  ))}
                  {cellEvents.length > 2 && (
                    <div className="brain-calendar-cell-event-more">
                      +{cellEvents.length - 2} more
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right panel: Details list */}
      {selectedDateStr && (
        <div className="brain-calendar-details">
          <button 
            className="brain-calendar-details-close" 
            onClick={() => setSelectedDateStr(null)}
            aria-label="Close Details"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
          <div className="brain-calendar-details-header">
            <div className="brain-calendar-details-date">{formattedSelectedDate}</div>
            <div className="brain-calendar-details-subtitle">Scheduled facts & events</div>
          </div>

          {selectedDayEvents.length > 0 ? (
            <div className="brain-cal-section">
              {selectedDayEvents.map((e, idx) => (
                <div className="brain-cal-row" key={idx}>
                  <div className="brain-cal-body">
                    <div 
                      className="brain-cal-text"
                      dangerouslySetInnerHTML={{ __html: replaceMentionsWithTags(marked.parse(e.text || '')) }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="brain-view-empty" style={{ padding: '2rem 1rem' }}>
              No events scheduled for this day.
            </div>
          )}

          {undatedEvents.length > 0 && (
            <div className="brain-calendar-undated-section" style={{ marginTop: '2rem', borderTop: '1px solid rgba(0,0,0,0.08)', paddingTop: '1.5rem' }}>
              <h3 className="brain-cal-section-title">Undated / General Facts</h3>
              <div className="brain-cal-section">
                {undatedEvents.map((e, idx) => (
                  <div className="brain-cal-row" key={idx}>
                    <div className="brain-cal-body">
                      <div 
                        className="brain-cal-text"
                        dangerouslySetInnerHTML={{ __html: replaceMentionsWithTags(marked.parse(e.text || '')) }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
