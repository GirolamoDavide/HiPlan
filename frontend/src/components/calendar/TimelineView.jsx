import React, { useState, useMemo, useEffect, useRef } from 'react';
import useDragScroll from '../../hooks/useDragScroll';
import { getTaskColor } from '../../utils/phaseColors';
import { isTaskCompleted } from '../../utils/taskCompletion';
import { isWeekendOrHoliday } from '../../utils/workingDays';
import { taskMatchesWorker, taskMatchesDepartment, vacationMatchesFilters } from '../../utils/calendarFilters';
import { getCustomDatesList, clusterCustomDates } from '../../utils/customDates';
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
export const EXPAND_COL_WIDTH = 34;

export const TIMELINE_COLUMNS = [
  { id: 'code', label: 'Cod. Commessa' },
  { id: 'name', label: 'Titolo' },
  { id: 'client', label: 'Cliente' },
  { id: 'responsible', label: 'Responsabile' },
  { id: 'start_date', label: 'Data Inizio' },
  { id: 'end_date', label: 'Data Fine' },
];

export const DEFAULT_COL_WIDTHS = {
  code: 130,
  name: 240,
  client: 150,
  responsible: 140,
  start_date: 105,
  end_date: 105,
};

export const MIN_COL_WIDTHS = {
  code: 70,
  name: 130,
  client: 80,
  responsible: 80,
  start_date: 75,
  end_date: 75,
};

export function getProjectResponsible(proj, systemUsers = []) {
  if (proj.responsible_name) return proj.responsible_name;
  if (proj.responsible_username) return proj.responsible_username;
  if (proj.responsible_id && Array.isArray(systemUsers)) {
    const u = systemUsers.find(user => String(user.id) === String(proj.responsible_id));
    if (u) return u.full_name || u.username;
  }
  if (proj.owner_id && Array.isArray(systemUsers)) {
    const u = systemUsers.find(user => String(user.id) === String(proj.owner_id));
    if (u) return u.full_name || u.username;
  }
  return '-';
}

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
  onDoubleClickVacation,
  visibleColumns: propVisibleCols,
  onVisibleColumnsChange: propOnVisibleColsChange,
  sortConfig,
  onSortChange,
}) {
  const today = new Date();
  const todayKey = toLocalDateKey(today);
  const [expandedProjects, setExpandedProjects] = useState({});
  const [vacationsExpanded, setVacationsExpanded] = useState(false);
  const scrollRef = useDragScroll();

  const handleHeaderSort = (key) => {
    if (!onSortChange) return;
    if (sortConfig?.key === key) {
      if (sortConfig.direction === 'asc') {
        onSortChange({ key, direction: 'desc' });
      } else {
        onSortChange({ key: 'none', direction: 'asc' });
      }
    } else {
      onSortChange({ key, direction: 'asc' });
    }
  };

  const [internalCols, setInternalCols] = useState(() => {
    try {
      const saved = localStorage.getItem('hiplan-timeline-visible-cols');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch { }
    return ['code', 'name', 'client', 'responsible'];
  });

  const visibleColumns = propVisibleCols || internalCols;
  const setVisibleColumns = (cols) => {
    if (propOnVisibleColsChange) {
      propOnVisibleColsChange(cols);
    } else {
      setInternalCols(cols);
    }
    try {
      localStorage.setItem('hiplan-timeline-visible-cols', JSON.stringify(cols));
    } catch { }
  };

  // Larghezze colonne ridimensionabili (trascina per allargare / stringere)
  const [colWidths, setColWidths] = useState(() => {
    try {
      const saved = localStorage.getItem('hiplan-timeline-col-widths');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          return { ...DEFAULT_COL_WIDTHS, ...parsed };
        }
      }
    } catch { }
    return { ...DEFAULT_COL_WIDTHS };
  });

  const [resizingCol, setResizingCol] = useState(null);

  const startResize = (colId, e) => {
    e.preventDefault();
    e.stopPropagation();
    setResizingCol(colId);

    const startX = e.clientX;
    const startW = colWidths[colId] || DEFAULT_COL_WIDTHS[colId] || 120;

    const onMouseMove = (moveEvent) => {
      moveEvent.preventDefault();
      const delta = moveEvent.clientX - startX;
      const minW = MIN_COL_WIDTHS[colId] || 70;
      const newW = Math.max(minW, Math.min(600, startW + delta));
      setColWidths(prev => {
        const updated = { ...prev, [colId]: newW };
        try {
          localStorage.setItem('hiplan-timeline-col-widths', JSON.stringify(updated));
        } catch { }
        return updated;
      });
    };

    const onMouseUp = () => {
      setResizingCol(null);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const [showColsMenu, setShowColsMenu] = useState(false);
  const colsMenuRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (colsMenuRef.current && !colsMenuRef.current.contains(event.target)) {
        setShowColsMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const toggleColumn = (colId) => {
    if (visibleColumns.includes(colId)) {
      if (visibleColumns.length === 1) return;
      setVisibleColumns(visibleColumns.filter(c => c !== colId));
    } else {
      setVisibleColumns([...visibleColumns, colId]);
    }
  };

  const lastColId = visibleColumns[visibleColumns.length - 1];

  const getColStyle = (colId, isHeader = false) => {
    const isLast = lastColId === colId;
    const width = colWidths[colId] || DEFAULT_COL_WIDTHS[colId] || 120;
    const paddingRight = (isHeader && isLast) ? 36 : 10;

    return {
      width: `${width}px`,
      minWidth: `${width}px`,
      maxWidth: `${width}px`,
      flex: `0 0 ${width}px`,
      boxSizing: 'border-box',
      paddingRight,
    };
  };

  const leftColWidth = useMemo(() => {
    let w = EXPAND_COL_WIDTH;
    visibleColumns.forEach(id => {
      w += (colWidths[id] || DEFAULT_COL_WIDTHS[id] || 120);
    });
    return Math.max(160, w);
  }, [visibleColumns, colWidths]);

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

  const renderProjectInfoCols = (proj, isExpanded = false) => {
    const hasTasks = Array.isArray(proj.tasks) && proj.tasks.length > 0;

    return (
      <>
        {/* Colonna fissa a sinistra per l'espansione */}
        <div
          className="timeline-col-cell timeline-col-cell--expand"
          style={{
            width: `${EXPAND_COL_WIDTH}px`,
            minWidth: `${EXPAND_COL_WIDTH}px`,
            maxWidth: `${EXPAND_COL_WIDTH}px`,
            flex: `0 0 ${EXPAND_COL_WIDTH}px`,
          }}
        >
          {hasTasks ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpandedProjects(prev => ({ ...prev, [proj.id]: !isExpanded }));
              }}
              className="timeline-expand-btn"
              title={isExpanded ? 'Riduci fasi' : 'Espandi fasi'}
              aria-expanded={Boolean(isExpanded)}
            >
              <AppIcon name={isExpanded ? 'chevronDown' : 'chevronRight'} size={11} />
            </button>
          ) : (
            <span style={{ width: 18, height: 18 }} />
          )}
        </div>

        {visibleColumns.includes('code') && (
          <div
            className="timeline-col-cell timeline-col-cell--code"
            style={{
              ...getColStyle('code', false),
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
            title={proj.code || '-'}
          >
            {proj.code ? (
              <span className="timeline-code-badge">{proj.code}</span>
            ) : (
              <span style={{ color: 'var(--text-tertiary)' }}>-</span>
            )}
          </div>
        )}

        {visibleColumns.includes('name') && (
          <div
            className="timeline-col-cell timeline-col-cell--name"
            style={{
              ...getColStyle('name', false),
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
            title={proj.name}
          >
            <span
              className="timeline-status-dot"
              style={{ '--timeline-status-color': STATUS_COLORS[proj.status] || '#a5b4fc', flexShrink: 0 }}
              title={STATUS_LABELS_IT[proj.status] || proj.status}
            />
            <span className="timeline-proj-title" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {proj.name}
            </span>
          </div>
        )}

        {visibleColumns.includes('client') && (
          <div
            className="timeline-col-cell timeline-col-cell--client"
            style={{
              ...getColStyle('client', false),
              display: 'flex',
              alignItems: 'center',
              gap: 5,
            }}
            title={proj.client || 'Nessun cliente'}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: proj.client ? 'var(--text-secondary)' : 'var(--text-tertiary)', fontSize: '0.78rem', flex: 1, minWidth: 0 }}>
              {proj.client || '-'}
            </span>
          </div>
        )}

        {visibleColumns.includes('responsible') && (
          <div
            className="timeline-col-cell timeline-col-cell--responsible"
            style={{
              ...getColStyle('responsible', false),
              display: 'flex',
              alignItems: 'center',
              gap: 5,
            }}
            title={getProjectResponsible(proj, systemUsers)}
          >
            <AppIcon name="user" size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)', fontSize: '0.78rem', flex: 1, minWidth: 0 }}>
              {getProjectResponsible(proj, systemUsers)}
            </span>
          </div>
        )}

        {visibleColumns.includes('start_date') && (
          <div
            className="timeline-col-cell timeline-col-cell--start-date"
            style={getColStyle('start_date', false)}
            title={proj.start_date ? proj.start_date.substring(0, 10) : 'Nessuna data inizio'}
          >
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              {proj.start_date ? proj.start_date.substring(0, 10) : '-'}
            </span>
          </div>
        )}

        {visibleColumns.includes('end_date') && (
          <div
            className="timeline-col-cell timeline-col-cell--end-date"
            style={getColStyle('end_date', false)}
            title={proj.end_date ? proj.end_date.substring(0, 10) : 'Nessuna data fine'}
          >
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              {proj.end_date ? proj.end_date.substring(0, 10) : '-'}
            </span>
          </div>
        )}
      </>
    );
  };

  const renderTaskInfoCols = (t, isCompleted, tColor) => {
    const customList = getCustomDatesList(t);
    const isCustom = t.budget_mode === 'custom_dates' || customList.length > 0;
    const customTotalHours = customList.reduce((acc, d) => acc + (d.hours || 0), 0);
    const taskHours = isCustom && customTotalHours > 0 ? customTotalHours : (t.planned_hours || 8);

    return (
      <>
        {/* Colonna fissa a sinistra per l'indicatore ramo fase */}
        <div
          className="timeline-col-cell timeline-col-cell--expand"
          style={{
            width: `${EXPAND_COL_WIDTH}px`,
            minWidth: `${EXPAND_COL_WIDTH}px`,
            maxWidth: `${EXPAND_COL_WIDTH}px`,
            flex: `0 0 ${EXPAND_COL_WIDTH}px`,
          }}
        >
          <span className="timeline-task-branch" aria-hidden="true" style={{ fontSize: '0.85rem', color: 'var(--text-tertiary)', fontWeight: 700 }}>↳</span>
        </div>

        {visibleColumns.includes('code') && (
          <div
            className="timeline-col-cell timeline-col-cell--code"
            style={{ ...getColStyle('code', false), justifyContent: 'center' }}
          >
            <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>-</span>
          </div>
        )}

        {visibleColumns.includes('name') && (
          <div
            className="timeline-col-cell timeline-col-cell--name"
            style={{
              ...getColStyle('name', false),
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
            title={t.text}
          >
            {isCompleted && <AppIcon name="check" size={12} className="timeline-completed-icon" />}
            <span className="timeline-proj-title timeline-task-title" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.text}
            </span>
            <span
              className="timeline-proj-meta timeline-task-meta"
              style={{ flexShrink: 0 }}
              title={isCustom ? `Date selezionate da calendario (${taskHours}h)` : `${taskHours}h`}
            >
              <AppIcon name="clock" size={11} />
              <span>{taskHours}h</span>
            </span>
          </div>
        )}

        {visibleColumns.includes('client') && (
          <div
            className="timeline-col-cell timeline-col-cell--client"
            style={getColStyle('client', false)}
          >
            {t.department ? (
              <span className="badge badge-subtle" style={{ fontSize: '0.65rem' }}>{t.department}</span>
            ) : (
              <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>-</span>
            )}
          </div>
        )}

        {visibleColumns.includes('responsible') && (
          <div
            className="timeline-col-cell timeline-col-cell--responsible"
            style={getColStyle('responsible', false)}
            title={Array.isArray(t.workers) && t.workers.length > 0 ? t.workers.join(', ') : 'Nessun addetto'}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)', fontSize: '0.75rem', width: '100%' }}>
              <AppIcon name="users" size={12} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {Array.isArray(t.workers) && t.workers.length > 0 ? t.workers.join(', ') : 'Nessuno'}
              </span>
            </span>
          </div>
        )}

        {visibleColumns.includes('start_date') && (
          <div
            className="timeline-col-cell timeline-col-cell--start-date"
            style={getColStyle('start_date', false)}
            title={t.start_date ? t.start_date.substring(0, 10) : '-'}
          >
            <span style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)' }}>
              {t.start_date ? t.start_date.substring(0, 10) : '-'}
            </span>
          </div>
        )}

        {visibleColumns.includes('end_date') && (
          <div
            className="timeline-col-cell timeline-col-cell--end-date"
            style={getColStyle('end_date', false)}
            title={t.end_date ? t.end_date.substring(0, 10) : '-'}
          >
            <span style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)' }}>
              {t.end_date ? t.end_date.substring(0, 10) : '-'}
            </span>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="calendar-timeline-container" ref={scrollRef} style={{ '--timeline-left-width': `${leftColWidth}px` }}>
      <div className="timeline-header-row">
        <div className="timeline-project-col has-columns">
          <div className="timeline-cols-header">
            {/* Colonna fissa a sinistra per allineare le frecce di espansione */}
            <div
              className="timeline-col-th timeline-col-th--expand"
              style={{
                width: `${EXPAND_COL_WIDTH}px`,
                minWidth: `${EXPAND_COL_WIDTH}px`,
                maxWidth: `${EXPAND_COL_WIDTH}px`,
                flex: `0 0 ${EXPAND_COL_WIDTH}px`,
                padding: 0,
              }}
            />
            {visibleColumns.includes('code') && (
              <div
                className={`timeline-col-th timeline-col-th--sortable ${sortConfig?.key === 'code' ? 'is-sorted' : ''}`}
                style={getColStyle('code', true)}
                onClick={() => handleHeaderSort('code')}
                title="Ordina per Codice Commessa"
              >
                <span>Cod. Commessa</span>
                {sortConfig?.key === 'code' && (
                  <span className="timeline-sort-indicator">{sortConfig.direction === 'asc' ? '▲' : '▼'}</span>
                )}
                <div
                  className={`timeline-col-resizer ${resizingCol === 'code' ? 'is-resizing' : ''}`}
                  onMouseDown={(e) => startResize('code', e)}
                  onClick={(e) => e.stopPropagation()}
                  title="Trascina per ridimensionare colonna"
                />
              </div>
            )}
            {visibleColumns.includes('name') && (
              <div
                className={`timeline-col-th timeline-col-th--sortable ${sortConfig?.key === 'name' ? 'is-sorted' : ''}`}
                style={getColStyle('name', true)}
                onClick={() => handleHeaderSort('name')}
                title="Ordina per Titolo"
              >
                <span>Titolo</span>
                {sortConfig?.key === 'name' && (
                  <span className="timeline-sort-indicator">{sortConfig.direction === 'asc' ? '▲' : '▼'}</span>
                )}
                <div
                  className={`timeline-col-resizer ${resizingCol === 'name' ? 'is-resizing' : ''}`}
                  onMouseDown={(e) => startResize('name', e)}
                  onClick={(e) => e.stopPropagation()}
                  title="Trascina per ridimensionare colonna"
                />
              </div>
            )}
            {visibleColumns.includes('client') && (
              <div
                className={`timeline-col-th timeline-col-th--sortable ${sortConfig?.key === 'client' ? 'is-sorted' : ''}`}
                style={getColStyle('client', true)}
                onClick={() => handleHeaderSort('client')}
                title="Ordina per Cliente"
              >
                <span>Cliente</span>
                {sortConfig?.key === 'client' && (
                  <span className="timeline-sort-indicator">{sortConfig.direction === 'asc' ? '▲' : '▼'}</span>
                )}
                <div
                  className={`timeline-col-resizer ${resizingCol === 'client' ? 'is-resizing' : ''}`}
                  onMouseDown={(e) => startResize('client', e)}
                  onClick={(e) => e.stopPropagation()}
                  title="Trascina per ridimensionare colonna"
                />
              </div>
            )}
            {visibleColumns.includes('responsible') && (
              <div
                className={`timeline-col-th timeline-col-th--sortable ${sortConfig?.key === 'responsible' ? 'is-sorted' : ''}`}
                style={getColStyle('responsible', true)}
                onClick={() => handleHeaderSort('responsible')}
                title="Ordina per Responsabile"
              >
                <span>Responsabile</span>
                {sortConfig?.key === 'responsible' && (
                  <span className="timeline-sort-indicator">{sortConfig.direction === 'asc' ? '▲' : '▼'}</span>
                )}
                <div
                  className={`timeline-col-resizer ${resizingCol === 'responsible' ? 'is-resizing' : ''}`}
                  onMouseDown={(e) => startResize('responsible', e)}
                  onClick={(e) => e.stopPropagation()}
                  title="Trascina per ridimensionare colonna"
                />
              </div>
            )}
            {visibleColumns.includes('start_date') && (
              <div
                className={`timeline-col-th timeline-col-th--sortable ${sortConfig?.key === 'start_date' ? 'is-sorted' : ''}`}
                style={getColStyle('start_date', true)}
                onClick={() => handleHeaderSort('start_date')}
                title="Ordina per Data Inizio"
              >
                <span>Data Inizio</span>
                {sortConfig?.key === 'start_date' && (
                  <span className="timeline-sort-indicator">{sortConfig.direction === 'asc' ? '▲' : '▼'}</span>
                )}
                <div
                  className={`timeline-col-resizer ${resizingCol === 'start_date' ? 'is-resizing' : ''}`}
                  onMouseDown={(e) => startResize('start_date', e)}
                  onClick={(e) => e.stopPropagation()}
                  title="Trascina per ridimensionare colonna"
                />
              </div>
            )}
            {visibleColumns.includes('end_date') && (
              <div
                className={`timeline-col-th timeline-col-th--sortable ${sortConfig?.key === 'end_date' ? 'is-sorted' : ''}`}
                style={getColStyle('end_date', true)}
                onClick={() => handleHeaderSort('end_date')}
                title="Ordina per Data Fine"
              >
                <span>Data Fine</span>
                {sortConfig?.key === 'end_date' && (
                  <span className="timeline-sort-indicator">{sortConfig.direction === 'asc' ? '▲' : '▼'}</span>
                )}
                <div
                  className={`timeline-col-resizer ${resizingCol === 'end_date' ? 'is-resizing' : ''}`}
                  onMouseDown={(e) => startResize('end_date', e)}
                  onClick={(e) => e.stopPropagation()}
                  title="Trascina per ridimensionare colonna"
                />
              </div>
            )}
          </div>

          <div className="timeline-cols-btn-wrap" ref={colsMenuRef}>
            <button
              type="button"
              className="timeline-cols-btn"
              onClick={() => setShowColsMenu(prev => !prev)}
              title="Personalizza colonne visualizzate"
              aria-label="Personalizza colonne"
            >
              <AppIcon name="columns" size={13} />
            </button>
            {showColsMenu && (
              <div className="action-popover" style={{
                position: 'absolute', top: 'calc(100% + 4px)', right: 0, background: 'var(--bg-card)', border: '1px solid var(--border-default)',
                borderRadius: 10, padding: 12, zIndex: 200, minWidth: 200, boxShadow: 'var(--shadow-lg)'
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  COLONNE VISIBILI:
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {TIMELINE_COLUMNS.map(col => (
                    <label key={col.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)', userSelect: 'none' }}>
                      <input
                        type="checkbox"
                        checked={visibleColumns.includes(col.id)}
                        onChange={() => toggleColumn(col.id)}
                      />
                      {col.label}
                    </label>
                  ))}
                </div>
                <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 8, paddingTop: 8, display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={() => setVisibleColumns(TIMELINE_COLUMNS.map(c => c.id))}
                    style={{ flex: 1, fontSize: 11 }}
                  >
                    Tutte
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={() => setVisibleColumns(['name'])}
                    style={{ flex: 1, fontSize: 11 }}
                  >
                    Solo Titolo
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
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
              <div className="timeline-project-info timeline-vacation-info has-columns">
                <div
                  className="timeline-col-cell timeline-col-cell--expand"
                  style={{
                    width: `${EXPAND_COL_WIDTH}px`,
                    minWidth: `${EXPAND_COL_WIDTH}px`,
                    maxWidth: `${EXPAND_COL_WIDTH}px`,
                    flex: `0 0 ${EXPAND_COL_WIDTH}px`,
                  }}
                >
                  <button
                    type="button"
                    className="timeline-expand-btn"
                    onClick={() => setVacationsExpanded(!vacationsExpanded)}
                    title={vacationsExpanded ? 'Riduci addetti' : 'Espandi addetti'}
                    aria-expanded={Boolean(vacationsExpanded)}
                  >
                    <AppIcon name={vacationsExpanded ? 'chevronDown' : 'chevronRight'} size={11} />
                  </button>
                </div>
                <div style={{ flex: 1, minWidth: 0, paddingLeft: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="timeline-proj-title timeline-vacation-title" style={{ fontWeight: 700, color: '#b45309', fontSize: '0.78rem' }}>
                    Panoramica Ferie
                  </span>
                  <span className="timeline-proj-meta" style={{ fontSize: '0.64rem', color: 'var(--text-tertiary)' }}>
                    • {totalPeriods} periodi
                  </span>
                </div>
              </div>
              <div className="timeline-row-grid">
                {renderGrid()}
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
                  <div className="timeline-project-info timeline-vacation-info has-columns">
                    <div
                      className="timeline-col-cell timeline-col-cell--expand"
                      style={{
                        width: `${EXPAND_COL_WIDTH}px`,
                        minWidth: `${EXPAND_COL_WIDTH}px`,
                        maxWidth: `${EXPAND_COL_WIDTH}px`,
                        flex: `0 0 ${EXPAND_COL_WIDTH}px`,
                      }}
                    >
                      <span className="timeline-task-branch" aria-hidden="true" style={{ fontSize: '0.85rem', color: 'var(--text-tertiary)', fontWeight: 700 }}>↳</span>
                    </div>
                    <div style={{ flex: 1, minWidth: 0, paddingLeft: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span className="timeline-proj-title timeline-vacation-title" style={{ fontSize: '0.75rem' }}>
                        {username}
                      </span>
                      <span className="timeline-proj-meta" style={{ fontSize: '0.64rem' }}>
                        {userVacations.length > 1 ? `${userVacations.length} periodi registrati` : (userVacations[0].reason || 'Ferie')}
                      </span>
                    </div>
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
                  <div className="timeline-project-info has-columns" onClick={() => onSelectProject(proj)} style={{ cursor: 'pointer' }}>
                    {renderProjectInfoCols(proj, false)}
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
                  <div className="timeline-project-info has-columns" onClick={() => onSelectProject(proj)} style={{ cursor: 'pointer' }}>
                    {renderProjectInfoCols(proj, isExpanded)}
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
                  const customList = getCustomDatesList(t);
                  const isCustom = t.budget_mode === 'custom_dates' || customList.length > 0;
                  const clusters = isCustom && customList.length > 0 ? clusterCustomDates(customList) : [];

                  const tStart = t.start_date ? t.start_date.substring(0, 10) : rangeStartStr;
                  const tEnd = t.end_date ? t.end_date.substring(0, 10) : tStart;

                  // Limiti complessivi della fase (dal primo all'ultimo cluster o da tStart a tEnd)
                  const overallStart = clusters.length > 0 ? clusters[0].startDateStr : tStart;
                  const overallEnd = clusters.length > 0 ? clusters[clusters.length - 1].endDateStr : tEnd;

                  if (overallEnd < rangeStartStr || overallStart > rangeEndStr) return null;

                  let overallStartIdx = getDayIndex(overallStart);
                  let overallEndIdx = getDayIndex(overallEnd);
                  if (overallStartIdx < 0) overallStartIdx = 0;
                  if (overallEndIdx >= daysList.length) overallEndIdx = daysList.length - 1;
                  const overallSpanDays = Math.max(1, overallEndIdx - overallStartIdx + 1);

                  const tColor = getTaskColor(t);
                  const isCompleted = isTaskCompleted(t);

                  const segmentsToRender = clusters.length > 0
                    ? clusters
                    : [{ startDateStr: tStart, endDateStr: tEnd, hours: Number(t.planned_hours) || 0 }];

                  return (
                    <div key={t.id} className={`timeline-project-row timeline-task-subrow ${isCompleted ? 'timeline-row-completed' : ''}`}>
                      <div
                        className={`timeline-project-info timeline-task-info has-columns ${isCompleted ? 'timeline-row-completed' : ''}`}
                        onClick={() => onSelectProject({ ...proj, selectedPhase: t })}
                        style={{ '--timeline-row-accent': isCompleted ? '#10b981' : tColor }}
                      >
                        {renderTaskInfoCols(t, isCompleted, tColor)}
                      </div>

                      <div className="timeline-row-grid timeline-task-grid">
                        {renderGrid()}

                        {/* Linea tratteggiata di connessione tra i blocchi spezzettati */}
                        {clusters.length > 1 && (
                          <div
                            className="timeline-task-track-connector"
                            style={{
                              position: 'absolute',
                              top: '50%',
                              transform: 'translateY(-50%)',
                              left: `${overallStartIdx * TIMELINE_DAY_WIDTH + 6}px`,
                              width: `${Math.max(0, overallSpanDays * TIMELINE_DAY_WIDTH - 12)}px`,
                              height: '0px',
                              borderTop: `2px dashed ${isCompleted ? '#10b981' : tColor}`,
                              opacity: 0.45,
                              pointerEvents: 'none',
                              zIndex: 1,
                            }}
                          />
                        )}

                        {segmentsToRender.map((cluster, cIdx) => {
                          const cStart = cluster.startDateStr ? cluster.startDateStr.substring(0, 10) : tStart;
                          const cEnd = cluster.endDateStr ? cluster.endDateStr.substring(0, 10) : cStart;
                          if (cEnd < rangeStartStr || cStart > rangeEndStr) return null;

                          let cStartIdx = getDayIndex(cStart);
                          let cEndIdx = getDayIndex(cEnd);
                          if (cStartIdx < 0) cStartIdx = 0;
                          if (cEndIdx >= daysList.length) cEndIdx = daysList.length - 1;
                          const cSpanDays = Math.max(1, cEndIdx - cStartIdx + 1);

                          const isSegmented = clusters.length > 1;
                          const clusterTitle = isSegmented
                            ? `[Fase spezzettata - Periodo ${cIdx + 1}/${clusters.length}] ${t.text} (${cStart} -> ${cEnd}) • ${cluster.hours || 0}h - Addetti: ${Array.isArray(t.workers) ? t.workers.join(', ') : ''}`
                            : `[Fase] ${t.text} (${cStart} -> ${cEnd}) - Addetti: ${Array.isArray(t.workers) ? t.workers.join(', ') : ''}`;

                          return (
                            <div
                              key={`${t.id}-c-${cIdx}`}
                              className={`timeline-bar timeline-task-bar ${isSegmented ? 'timeline-task-bar--segmented' : ''}`}
                              style={{
                                '--timeline-bar-color': isCompleted ? '#10b981' : tColor,
                                left: `${cStartIdx * TIMELINE_DAY_WIDTH + 3}px`,
                                width: `${cSpanDays * TIMELINE_DAY_WIDTH - 6}px`,
                              }}
                              onClick={() => onSelectProject({ ...proj, selectedPhase: t })}
                              title={clusterTitle}
                            >
                              <span aria-hidden="true" style={{ fontSize: isSegmented && cIdx > 0 ? '0.7rem' : '0.85rem' }}>
                                {cIdx === 0 ? '↳' : '⋯'}
                              </span>
                              {isCompleted && cIdx === 0 && <AppIcon name="check" size={13} />}
                              <span className="timeline-task-bar-text">
                                {isSegmented
                                  ? (cSpanDays >= 2 ? `${t.text} (${cluster.hours}h)` : (cIdx === 0 ? t.text : `${cluster.hours}h`))
                                  : t.text}
                              </span>
                            </div>
                          );
                        })}
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
