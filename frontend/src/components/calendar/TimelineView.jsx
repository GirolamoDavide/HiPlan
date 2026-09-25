import React, { useState, useMemo, useEffect } from 'react';
import useDragScroll from '../../hooks/useDragScroll';
import { getTaskColor } from '../../utils/phaseColors';
import { isTaskCompleted } from '../../utils/taskCompletion';
import { isWeekendOrHoliday } from '../../utils/workingDays';
import { taskMatchesWorker, taskMatchesDepartment, vacationMatchesFilters } from '../../utils/calendarFilters';
import AppIcon from '../ui/AppIcon';

const STATUS_LABELS_IT = {
  planning: 'In pianificazione',
  active: 'In corso',
  completed: 'Completato',
  archived: 'Archiviato',
};

const STATUS_COLORS = {
  planning: '#f59e0b',
  active: '#10b981',
  completed: '#3b82f6',
  archived: '#6b7280',
};

const WEEKDAYS_IT = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
const TIMELINE_DAY_WIDTH = 38;

const toLocalDateKey = (date) => (
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
);

export default function TimelineView({
  projects,
  currYear,
  currMonth,
  filterWorker,
  filterDepartment,
  filterStatus,
  searchQuery,
  systemUsers = [],
  onSelectProject,
  vacations = [],
  onDoubleClickVacation
}) {
  const today = new Date();
  const todayKey = toLocalDateKey(today);
  const [expandedProjects, setExpandedProjects] = useState({});
  const [vacationsExpanded, setVacationsExpanded] = useState(false);
  const scrollRef = useDragScroll();

  const { daysList, monthLabels } = useMemo(() => {
    const list = [];
    const labels = [];
    const start = new Date(currYear, currMonth - 6, 1);
    const end = new Date(currYear, currMonth + 7, 0);

    let currentMonthStr = "";
    let daysInCurrentMonth = 0;

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      list.push(new Date(d));
      const mStr = new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' }).format(d);

      if (mStr !== currentMonthStr) {
        if (currentMonthStr) {
          labels.push({ label: currentMonthStr, days: daysInCurrentMonth });
        }
        currentMonthStr = mStr;
        daysInCurrentMonth = 1;
      } else {
        daysInCurrentMonth++;
      }
    }
    if (currentMonthStr) {
      labels.push({ label: currentMonthStr, days: daysInCurrentMonth });
    }

    return { daysList: list, monthLabels: labels };
  }, [currYear, currMonth]);

  const rangeStartStr = toLocalDateKey(daysList[0]);
  const rangeEndStr = toLocalDateKey(daysList[daysList.length - 1]);

  useEffect(() => {
    if (scrollRef.current) {
      const targetDateStr = toLocalDateKey(new Date(currYear, currMonth, 1));
      const idx = daysList.findIndex(d => toLocalDateKey(d) === targetDateStr);
      if (idx >= 0) {
        scrollRef.current.scrollLeft = idx * TIMELINE_DAY_WIDTH;
      }
    }
  }, [currYear, currMonth, daysList, scrollRef]);

  function getDayIndex(dateStr) {
    const target = new Date(dateStr);
    const start = daysList[0];
    const diffTime = target - start;
    return Math.round(diffTime / (1000 * 60 * 60 * 24));
  }

  const renderGrid = () => (
    daysList.map((dayDate, i) => {
      const isWk = isWeekendOrHoliday(dayDate);
      const isToday = toLocalDateKey(dayDate) === todayKey;
      return <div key={i} className={`timeline-cell ${isWk ? 'weekend' : ''} ${isToday ? 'today' : ''}`} />;
    })
  );

  return (
    <div className="calendar-timeline-container" ref={scrollRef}>
      <div className="timeline-header-row">
        <div className="timeline-project-col">Commessa / Progetto</div>
        <div className="timeline-date-header" style={{ width: `${daysList.length * TIMELINE_DAY_WIDTH}px` }}>
          <div style={{ display: 'flex' }}>
            {monthLabels.map((ml, idx) => (
              <div key={idx} className="timeline-month-band" style={{ width: `${ml.days * TIMELINE_DAY_WIDTH}px`, flexShrink: 0, textTransform: 'capitalize' }}>
                {ml.label}
              </div>
            ))}
          </div>
          <div className="timeline-days-scroll">
            {daysList.map((dayDate, i) => {
              const dayOfWeek = dayDate.getDay();
              const isWknd = isWeekendOrHoliday(dayDate);
              const isToday = toLocalDateKey(dayDate) === todayKey;
              return (
                <div key={i} className={`timeline-day-col-header ${isWknd ? 'weekend' : ''} ${isToday ? 'today' : ''}`}>
                  <span>{WEEKDAYS_IT[dayOfWeek === 0 ? 6 : dayOfWeek - 1]}</span>
                  <span>{String(dayDate.getDate()).padStart(2, '0')}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {(() => {
        const visibleVacations = vacations.filter(v => {
          if (!vacationMatchesFilters(v, { filterWorker, filterDepartment, filterStatus, searchQuery }, systemUsers)) {
            return false;
          }
          const vStart = v.start_date?.substring(0, 10) || '';
          const vEnd = v.end_date?.substring(0, 10) || '';
          return vEnd >= rangeStartStr && vStart <= rangeEndStr;
        });
        const groupedVacations = {};
        visibleVacations.forEach(v => {
          if (!groupedVacations[v.username]) groupedVacations[v.username] = [];
          groupedVacations[v.username].push(v);
        });

        if (Object.keys(groupedVacations).length === 0) return null;

        const totalWorkers = Object.keys(groupedVacations).length;
        const totalPeriods = visibleVacations.length;

        return (
          <React.Fragment key="vacation-group-all">
            {/* Riga genitore riassuntiva */}
            <div className="timeline-project-row" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
              <div className="timeline-project-info timeline-vacation-info" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <span className="timeline-proj-title timeline-vacation-title" style={{ fontWeight: 'bold' }}>
                  Panoramica Ferie
                </span>
                <span className="timeline-proj-meta">
                  {totalWorkers} addetti • {totalPeriods} periodi
                </span>
                <button
                  className="timeline-phase-toggle"
                  style={{ position: 'absolute', right: 10, bottom: 10, padding: '2px 8px', fontSize: '0.65rem' }}
                  onClick={() => setVacationsExpanded(!vacationsExpanded)}
                >
                  {vacationsExpanded ? 'v' : '>'} Addetti ({totalWorkers})
                </button>
              </div>
              <div className="timeline-row-grid">
                {renderGrid()}
                {/* Mostriamo tutte le barre sovrapposte nella riga genitore in modo leggero, se si vuole */}
                {!vacationsExpanded && visibleVacations.map(v => {
                  const vStart = v.start_date?.substring(0, 10) || rangeStartStr;
                  const vEnd = v.end_date?.substring(0, 10) || vStart;
                  let startIdx = getDayIndex(vStart);
                  let endIdx = getDayIndex(vEnd);
                  if (startIdx < 0) startIdx = 0;
                  if (endIdx >= daysList.length) endIdx = daysList.length - 1;
                  const spanDays = Math.max(1, endIdx - startIdx + 1);
                  return (
                    <div
                      key={`parent-vac-${v.id || vStart + vEnd}`}
                      className="timeline-bar timeline-vacation-bar"
                      style={{
                        left: `${startIdx * TIMELINE_DAY_WIDTH + 3}px`,
                        width: `${spanDays * TIMELINE_DAY_WIDTH - 6}px`,
                        position: 'absolute',
                        opacity: 0.5,
                        zIndex: 1
                      }}
                      title={`Ferie: ${v.username} (${vStart} → ${vEnd})`}
                    />
                  );
                })}
              </div>
            </div>

            {/* Righe per singolo addetto */}
            {vacationsExpanded && Object.entries(groupedVacations).map(([username, userVacations]) => {
              return (
                <div key={`vac-group-${username}`} className="timeline-project-row" style={{ backgroundColor: 'var(--bg-card)', borderTop: '1px dashed var(--border-subtle)' }}>
                  <div className="timeline-project-info timeline-vacation-info" style={{ paddingLeft: '24px' }}>
                    <span className="timeline-proj-title timeline-vacation-title">
                      {username}
                    </span>
                    <span className="timeline-proj-meta">
                      {userVacations.length > 1 ? `${userVacations.length} periodi registrati` : (userVacations[0].reason || '')}
                    </span>
                  </div>

                  <div className="timeline-row-grid">
                    {renderGrid()}
                    {userVacations.map(v => {
                      const vStart = v.start_date?.substring(0, 10) || rangeStartStr;
                      const vEnd = v.end_date?.substring(0, 10) || vStart;

                      let startIdx = getDayIndex(vStart);
                      let endIdx = getDayIndex(vEnd);
                      if (startIdx < 0) startIdx = 0;
                      if (endIdx >= daysList.length) endIdx = daysList.length - 1;
                      const spanDays = Math.max(1, endIdx - startIdx + 1);

                      return (
                        <div
                          key={v.id || `vac-${vStart}-${vEnd}`}
                          className="timeline-bar timeline-vacation-bar"
                          style={{
                            left: `${startIdx * TIMELINE_DAY_WIDTH + 3}px`,
                            width: `${spanDays * TIMELINE_DAY_WIDTH - 6}px`,
                            cursor: onDoubleClickVacation ? 'pointer' : 'default',
                            position: 'absolute'
                          }}
                          title={`Ferie: ${vStart} → ${vEnd}${v.reason ? ` (${v.reason})` : ''}`}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            if (onDoubleClickVacation) {
                              onDoubleClickVacation(v);
                            }
                          }}
                        >
                          {vStart === vEnd ? vStart.substring(8, 10) + '/' + vStart.substring(5, 7) : `${vStart.substring(8, 10)}/${vStart.substring(5, 7)} → ${vEnd.substring(8, 10)}/${vEnd.substring(5, 7)}`}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </React.Fragment>
        );
      })()}

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {projects.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>
            Nessuna commessa o fase trovata.
          </div>
        ) : (
          projects.map((proj) => {
            const color = proj.color || '#185FA5';

            const pStart = proj.start_date ? proj.start_date.substring(0, 10) : rangeStartStr;
            const pEnd = proj.end_date ? proj.end_date.substring(0, 10) : pStart;

            if (pEnd < rangeStartStr || pStart > rangeEndStr) {
              return (
                <div key={proj.id} className="timeline-project-row">
                  <div className="timeline-project-info" onClick={() => onSelectProject(proj)} style={{ cursor: 'pointer' }}>
                    <span className="timeline-proj-title">{proj.code ? `[${proj.code}] ` : ''}{proj.name}</span>
                    <span className="timeline-proj-meta">{proj.client || 'Nessun cliente'}</span>
                  </div>
                  <div className="timeline-row-grid">
                    {renderGrid()}
                  </div>
                </div>
              );
            }

            let startIdx = getDayIndex(pStart);
            let endIdx = getDayIndex(pEnd);
            if (startIdx < 0) startIdx = 0;
            if (endIdx >= daysList.length) endIdx = daysList.length - 1;
            const spanDays = Math.max(1, endIdx - startIdx + 1);

            const matchingTasks = (proj.tasks || []).filter(t => {
              if (!taskMatchesWorker(t, filterWorker, systemUsers)) return false;
              if (!taskMatchesDepartment(t, filterDepartment, systemUsers)) return false;
              return true;
            });
            const isFiltered = (filterWorker && filterWorker !== 'all') || (filterDepartment && filterDepartment !== 'all');
            const isExpanded = expandedProjects[proj.id] !== undefined ? expandedProjects[proj.id] : isFiltered;

            return (
              <React.Fragment key={proj.id}>
                <div className="timeline-project-row">
                  <div className="timeline-project-info" onClick={() => onSelectProject(proj)} style={{ cursor: 'pointer' }}>
                    <span className="timeline-proj-title" title={proj.name}>
                      <strong>{proj.code ? `[${proj.code}] ` : ''}</strong>
                      {proj.name}
                    </span>
                    <span className="timeline-proj-meta">
                      <span
                        className="timeline-status-dot"
                        style={{ '--timeline-status-color': STATUS_COLORS[proj.status] || '#a5b4fc' }}
                      />
                      {STATUS_LABELS_IT[proj.status] || proj.status}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedProjects(prev => ({ ...prev, [proj.id]: !isExpanded }));
                        }}
                        className="timeline-phase-toggle"
                        title="Mostra singole fasi"
                        aria-expanded={Boolean(isExpanded)}
                      >
                        <AppIcon name={isExpanded ? 'chevronDown' : 'chevronRight'} size={12} />
                        Fasi ({isFiltered ? `${matchingTasks.length}/${proj.tasks?.length || 0}` : (proj.tasks?.length || 0)})
                      </button>
                    </span>
                  </div>

                  <div className="timeline-row-grid">
                    {renderGrid()}

                    <div
                      className="timeline-bar timeline-project-bar"
                      style={{
                        '--timeline-bar-color': color,
                        left: `${startIdx * TIMELINE_DAY_WIDTH + 3}px`,
                        width: `${spanDays * TIMELINE_DAY_WIDTH - 6}px`,
                      }}
                      onClick={() => onSelectProject(proj)}
                      title={`${proj.name} (${pStart} -> ${pEnd})`}
                    >
                      {proj.code ? `[${proj.code}] ` : ''}{proj.name}
                    </div>
                  </div>
                </div>

                {isExpanded && matchingTasks.map(t => {
                  const tStart = t.start_date ? t.start_date.substring(0, 10) : rangeStartStr;
                  const tEnd = t.end_date ? t.end_date.substring(0, 10) : tStart;
                  if (tEnd < rangeStartStr || tStart > rangeEndStr) return null;

                  let tStartIdx = getDayIndex(tStart);
                  let tEndIdx = getDayIndex(tEnd);
                  if (tStartIdx < 0) tStartIdx = 0;
                  if (tEndIdx >= daysList.length) tEndIdx = daysList.length - 1;
                  const tSpanDays = Math.max(1, tEndIdx - tStartIdx + 1);

                  const tColor = getTaskColor(t);
                  const isCompleted = isTaskCompleted(t);

                  return (
                    <div key={t.id} className={`timeline-project-row timeline-task-subrow ${isCompleted ? 'timeline-row-completed' : ''}`}>
                      <div
                        className={`timeline-project-info timeline-task-info ${isCompleted ? 'timeline-row-completed' : ''}`}
                        onClick={() => onSelectProject({ ...proj, selectedPhase: t })}
                        style={{ '--timeline-row-accent': isCompleted ? '#10b981' : tColor }}
                      >
                        <span className="timeline-proj-title timeline-task-title" title={t.text}>
                          <span className="timeline-task-branch" aria-hidden="true">↳</span>
                          {isCompleted && <AppIcon name="check" size={14} className="timeline-completed-icon" />}
                          <strong>{t.text}</strong>
                        </span>
                        <span className="timeline-proj-meta timeline-task-meta">
                          <AppIcon name="users" size={13} />
                          <span>{Array.isArray(t.workers) && t.workers.length > 0 ? t.workers.join(', ') : 'Nessuno'}</span>
                          <span className="timeline-meta-separator" aria-hidden="true" />
                          <AppIcon name="clock" size={13} />
                          <span>{t.planned_hours || 8}h</span>
                        </span>
                      </div>

                      <div className="timeline-row-grid timeline-task-grid">
                        {renderGrid()}

                        <div
                          className="timeline-bar timeline-task-bar"
                          style={{
                            '--timeline-bar-color': isCompleted ? '#10b981' : tColor,
                            left: `${tStartIdx * TIMELINE_DAY_WIDTH + 3}px`,
                            width: `${tSpanDays * TIMELINE_DAY_WIDTH - 6}px`,
                          }}
                          onClick={() => onSelectProject({ ...proj, selectedPhase: t })}
                          title={`[Fase] ${t.text} (${tStart} -> ${tEnd}) - Addetti: ${Array.isArray(t.workers) ? t.workers.join(', ') : ''}`}
                        >
                          <span aria-hidden="true">↳</span>
                          {isCompleted && <AppIcon name="check" size={13} />}
                          <span>{t.text}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </React.Fragment>
            );
          })
        )}
      </div>
    </div>
  );
}
