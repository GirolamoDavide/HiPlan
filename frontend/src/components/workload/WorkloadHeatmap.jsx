import React, { useState, useEffect } from 'react';
import api from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import './WorkloadHeatmap.css';
import { isWeekendOrHoliday } from '../../utils/workingDays';
import { useNavigate } from 'react-router-dom';
import useDragScroll from '../../hooks/useDragScroll';
import AppIcon from '../ui/AppIcon';
import { getTaskColor } from '../../utils/phaseColors';

export default function WorkloadHeatmap() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [heatmapData, setHeatmapData] = useState({});
  const [loading, setLoading] = useState(true);
  const [isWorkloadOpen, setIsWorkloadOpen] = useState(false);
  const [leftColWidth, setLeftColWidth] = useState(200);
  const [expandedUsers, setExpandedUsers] = useState({});
  const [viewMode, setViewMode] = useState('day');
  const [dataMode, setDataMode] = useState('both'); // 'planned', 'actual', 'both'
  const [dayDetails, setDayDetails] = useState(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportFormat, setExportFormat] = useState('pdf');
  const exportMenuRef = React.useRef(null);
  const toast = useToast();
  const gridRef = React.useRef(null);
  useDragScroll(gridRef, [loading]);
  useEffect(() => {
    fetchWorkload();
  }, []);

  const fetchWorkload = async () => {
    try {
      const res = await api.get('/workload/heatmap');
      setHeatmapData(res.data.heatmap);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const toggleUser = (userId) => {
    setExpandedUsers(prev => ({ ...prev, [userId]: !prev[userId] }));
  };

  useEffect(() => {
    function handleClickOutside(event) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target)) {
        setShowExportMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleChatGPTAnalysis = () => {
    const prompt = "Agisci come un esperto HR e Resource Planner. In allegato troverai l'export dei carichi di lavoro (ore pianificate vs ore consuntivate). Analizza la saturazione degli addetti, evidenziando chi è sovraccarico e chi ha disponibilità, e suggerisci eventuali ribilanciamenti.";
    window.open('https://chatgpt.com/?q=' + encodeURIComponent(prompt), '_blank');
  };

  const handleExport = async (format) => {
    try {
      const response = await api.get(`/workload/export/${format}?mode=${dataMode}`, {
        responseType: 'blob'
      });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `Saturazione_Carichi_Lavoro.${format === 'excel' ? 'xlsx' : 'pdf'}`;
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success(`Export ${format.toUpperCase()} completato!`);
      setShowExportMenu(false);
    } catch (err) {
      console.error(err);
      toast.error(`Errore durante l'esportazione in ${format.toUpperCase()}`);
    }
  };

  // Build full date range including weekends
  const allWorkDates = new Set();
  Object.values(heatmapData).forEach(u => {
    Object.keys(u.workload || {}).forEach(d => {
      if (d && d !== '__extra__' && !isNaN(new Date(d).getTime())) allWorkDates.add(d);
    });
    Object.keys(u.actual_workload || {}).forEach(d => {
      if (d && d !== '__extra__' && !isNaN(new Date(d).getTime())) allWorkDates.add(d);
    });
  });

  const today = new Date();
  const todayIso = today.toISOString().substring(0, 10);

  let minDateStr = todayIso;
  let maxDateStr = todayIso;

  if (allWorkDates.size > 0) {
    const sorted = Array.from(allWorkDates).sort();
    minDateStr = sorted[0] < todayIso ? sorted[0] : todayIso;
    maxDateStr = sorted[sorted.length - 1] > todayIso ? sorted[sorted.length - 1] : todayIso;
  }

  // Estendiamo il range attorno alle date di lavoro effettive e ad oggi (+/- 14 giorni prima e 30 giorni dopo)
  const minDate = new Date(minDateStr + 'T12:00:00Z');
  const maxDate = new Date(maxDateStr + 'T12:00:00Z');
  const padPast = new Date(minDate.getTime() - 14 * 86400000);
  const padFuture = new Date(maxDate.getTime() + 30 * 86400000);

  minDateStr = padPast.toISOString().substring(0, 10);
  maxDateStr = padFuture.toISOString().substring(0, 10);

  // Riempiamo tutti i giorni nel range in modo che la tabella mostri anche i periodi vuoti
  const fullDatesSet = new Set(allWorkDates);
  let loopCount = 0;
  if (minDateStr && maxDateStr) {
    const start = new Date(minDateStr + 'T12:00:00Z');
    const end = new Date(maxDateStr + 'T12:00:00Z');
    const cur = new Date(start.getTime());
    while (cur <= end) {
      fullDatesSet.add(cur.toISOString().substring(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
      loopCount++;
    }
  }

  const sortedDates = Array.from(fullDatesSet).sort();

  const columnsMap = new Map();
  sortedDates.forEach(dStr => {
    const d = new Date(dStr);
    let key, label;
    if (viewMode === 'month') {
      key = dStr.substring(0, 7);
      label = d.toLocaleDateString('it-IT', { month: 'short', year: 'numeric' });
    } else if (viewMode === 'week') {
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(d);
      monday.setDate(diff);
      key = monday.toISOString().substring(0, 10);
      label = 'Sett. ' + monday.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
    } else {
      key = dStr;
      const dayLabel = d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
      label = dayLabel;
    }
    if (!columnsMap.has(key)) columnsMap.set(key, label);
  });
  const columns = Array.from(columnsMap.keys()).sort();

  const getTodayKey = (mode) => {
    const now = new Date();
    if (mode === 'month') {
      return now.toISOString().substring(0, 7);
    } else if (mode === 'week') {
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(now);
      monday.setDate(diff);
      return monday.toISOString().substring(0, 10);
    } else {
      return now.toISOString().substring(0, 10);
    }
  };

  const todayKey = getTodayKey(viewMode);

  const scrollToToday = () => {
    const doScroll = () => {
      if (!gridRef.current || columns.length === 0) return;
      let targetEl = gridRef.current.querySelector('[data-colkey="' + todayKey + '"]');
      if (!targetEl) {
        const futureCol = columns.find(c => c >= todayKey);
        const fallbackKey = futureCol || columns[columns.length - 1];
        if (fallbackKey) targetEl = gridRef.current.querySelector('[data-colkey="' + fallbackKey + '"]');
      }
      if (targetEl && gridRef.current) {
        const containerWidth = gridRef.current.clientWidth;
        const targetOffsetLeft = targetEl.offsetLeft;
        const targetWidth = targetEl.clientWidth;
        const scrollLeft = targetOffsetLeft - (containerWidth + leftColWidth) / 2 + (targetWidth / 2);
        gridRef.current.scrollTo({ left: Math.max(0, scrollLeft), behavior: 'smooth' });
      }
    };
    setTimeout(doScroll, 50);
    setTimeout(doScroll, 200);
  };

  useEffect(() => {
    if (!loading && columns.length > 0 && isWorkloadOpen) {
      scrollToToday();
    }
  }, [loading, columns.length, viewMode, isWorkloadOpen]);

  const capacityMap = { day: 8, week: 40, month: 160 };
  const currentCapacity = capacityMap[viewMode];

  const isColumnWeekend = (colKey) => {
    if (viewMode === 'day') {
      const d = new Date(colKey);
      return isWeekendOrHoliday(d);
    }
    return false;
  };

  const isUserOnVacation = (userId, dateStr) => {
    const userData = heatmapData[userId];
    if (!userData || !userData.vacations) return false;
    return userData.vacations.some(v => {
      return dateStr >= v.start_date && dateStr <= v.end_date;
    });
  };

  const formatDateStr = (key) => {
    const [y, m, d] = key.split('-');
    return d + '/' + m + '/' + y;
  };

  if (loading) return <div>Caricamento...</div>;

  return (
    <div className={`workload-heatmap-container ${!isWorkloadOpen ? 'is-collapsed' : ''}`}>
      <div 
        style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center', 
          marginBottom: isWorkloadOpen ? 16 : 0,
          cursor: 'pointer',
          userSelect: 'none'
        }}
        onClick={() => setIsWorkloadOpen(!isWorkloadOpen)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="conflict-icon-badge conflict-badge-workload">
            <AppIcon name="users" size={19} />
          </span>
          <div>
            <h3 style={{ margin: 0, fontSize: '0.98rem', fontWeight: 700, color: 'var(--text-primary)' }}>
              Pianificazione Carichi di Lavoro
            </h3>
            <span className="conflict-section-desc">
              {dataMode === 'planned' ? 'Panoramica ore assegnate nelle fasi dei vari progetti (ore previste, non a consuntivo)' : dataMode === 'actual' ? 'Panoramica ore effettivamente registrate (consuntivate) dagli addetti' : 'Panoramica ore consuntivate rispetto alle previste (Consuntivate / Previste)'}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
          {isWorkloadOpen && (
            <>
              <button
                className="btn btn-secondary btn-sm"
                onClick={scrollToToday}
                title="Centra la tabella sulla data di oggi"
                style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
              >
                <AppIcon name="calendar" size={15} />
                Oggi
              </button>
              <select
                className="input"
                value={dataMode}
                onChange={e => setDataMode(e.target.value)}
                style={{ minWidth: 100, padding: '4px 8px', fontSize: '0.75rem' }}
              >
                <option value="both">Consuntivate / Pianificate</option>
                <option value="planned">Solo Ore Pianificate</option>
                <option value="actual">Solo Ore Consuntivate</option>
              </select>
              <select
                className="input"
                value={viewMode}
                onChange={(e) => setViewMode(e.target.value)}
                style={{ width: 200, padding: '4px 8px', fontSize: '0.75rem' }}
              >
                <option value="day">Per Giorno</option>
                <option value="week">Per Settimana</option>
                <option value="month">Per Mese</option>
              </select>
              <div style={{ position: 'relative' }} ref={exportMenuRef}>
                <button
                  className="btn btn-primary btn-sm"
                  style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                  onClick={() => setShowExportMenu(!showExportMenu)}
                >
                  <AppIcon name="download" size={14} />
                </button>
                {showExportMenu && (
                  <div style={{
                    position: 'absolute', top: '100%', right: 0, marginTop: 8, background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-default)', borderRadius: 12, padding: 16, width: 320,
                    boxShadow: '0 10px 25px rgba(0,0,0,0.2)', zIndex: 9999
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>Esporta Carichi di Lavoro</div>

                    <div style={{ borderTop: '1px solid var(--border-default)', marginTop: 10, paddingTop: 12 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Formato:
                      </div>
                      <div style={{ display: 'flex', gap: 10 }}>
                        <label style={{
                          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                          padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                          background: exportFormat === 'pdf' ? 'rgba(239, 68, 68, 0.15)' : 'var(--bg-tertiary)',
                          border: exportFormat === 'pdf' ? '2px solid #ef4444' : '1px solid var(--border-default)',
                          color: exportFormat === 'pdf' ? '#ef4444' : 'var(--text-secondary)',
                        }}>
                          <input
                            type="radio"
                            name="exportFormat"
                            value="pdf"
                            checked={exportFormat === 'pdf'}
                            onChange={() => setExportFormat('pdf')}
                            style={{ display: 'none' }}
                          />
                          <AppIcon name="download" size={14} /> PDF
                        </label>
                        <label style={{
                          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                          padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                          background: exportFormat === 'excel' ? 'rgba(16, 185, 129, 0.15)' : 'var(--bg-tertiary)',
                          border: exportFormat === 'excel' ? '2px solid #10b981' : '1px solid var(--border-default)',
                          color: exportFormat === 'excel' ? '#10b981' : 'var(--text-secondary)',
                        }}>
                          <input
                            type="radio"
                            name="exportFormat"
                            value="excel"
                            checked={exportFormat === 'excel'}
                            onChange={() => setExportFormat('excel')}
                            style={{ display: 'none' }}
                          />
                          <AppIcon name="download" size={14} /> Excel
                        </label>
                      </div>
                    </div>

                    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
                      <button
                        className="btn btn-secondary"
                        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: '#10a37f', color: '#fff', borderColor: '#10a37f' }}
                        onClick={() => { setShowExportMenu(false); handleChatGPTAnalysis(); }}
                      >
                        <img src="/chatgpt-logo.png" style={{ width: 16, height: 16, filter: 'brightness(0) invert(1)' }} alt="ChatGPT" />
                        Analizza con ChatGPT
                      </button>
                    </div>

                    <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                      <button
                        className="btn btn-secondary"
                        style={{ flex: 1 }}
                        onClick={() => setShowExportMenu(false)}
                      >
                        Annulla
                      </button>
                      <button
                        className="btn btn-primary"
                        style={{ flex: 1 }}
                        onClick={() => handleExport(exportFormat)}
                      >
                        Export {exportFormat.toUpperCase()}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
          <div 
            className="conflict-toggle-chevron"
            onClick={() => setIsWorkloadOpen(!isWorkloadOpen)}
            title={isWorkloadOpen ? "Comprimi" : "Espandi"}
          >
            <AppIcon name={isWorkloadOpen ? "chevronUp" : "chevronDown"} size={18} />
          </div>
        </div>
      </div>

      {isWorkloadOpen && (
        <div className="heatmap-grid" ref={gridRef} style={{ gridTemplateColumns: `${leftColWidth}px repeat(` + columns.length + ', 90px)' }}>

        {/* Header (Columns) */}
        <div className="heatmap-header-cell sticky-col sticky-header-col" style={{ position: 'relative' }}>
          Addetto
          <div
            style={{
              position: 'absolute',
              right: 0,
              top: 0,
              bottom: 0,
              width: '8px',
              cursor: 'col-resize',
              zIndex: 10
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              const startX = e.clientX;
              const startWidth = leftColWidth;

              const handleMouseMove = (moveEvent) => {
                const newWidth = Math.max(100, Math.min(500, startWidth + moveEvent.clientX - startX));
                setLeftColWidth(newWidth);
              };

              const handleMouseUp = () => {
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
              };

              document.addEventListener('mousemove', handleMouseMove);
              document.addEventListener('mouseup', handleMouseUp);
            }}
          />
        </div>
        {columns.map(colKey => {
          const isWeekendCol = isColumnWeekend(colKey);
          const isTodayCol = colKey === todayKey;
          const colDateStr = viewMode === 'day' ? formatDateStr(colKey) : columnsMap.get(colKey);
          const titleParts = [];
          if (isWeekendCol) titleParts.push('Sabato/Domenica');
          if (isTodayCol) titleParts.push('Oggi');
          const titleText = colDateStr + (titleParts.length > 0 ? ' - ' + titleParts.join(', ') : '');
          return (
            <div
              key={colKey}
              data-colkey={colKey}
              className={'heatmap-header-cell' + (isTodayCol ? ' today-header' : '') + (isWeekendCol ? ' weekend-header' : '')}
              title={titleText}
            >
              <div>{columnsMap.get(colKey)}</div>
              {viewMode === 'day' ? (
                <div style={{ fontSize: '0.75rem', fontWeight: isTodayCol ? 800 : 500, color: isTodayCol ? 'var(--accent-500)' : 'var(--text-secondary)' }}>
                  {(() => {
                    const [y, m, d] = colKey.split('-');
                    const date = new Date(Date.UTC(y, parseInt(m) - 1, d, 12, 0, 0));
                    const dayName = date.toLocaleDateString('it-IT', { weekday: 'short', timeZone: 'UTC' }).replace(/^\w/, c => c.toUpperCase());
                    return isTodayCol ? `${dayName} (Oggi)` : dayName;
                  })()}
                </div>
              ) : (
                isTodayCol && (
                  <div style={{ fontSize: '0.7rem', color: 'var(--accent-500)', fontWeight: 800 }}>Oggi</div>
                )
              )}
            </div>
          );
        })}

        {/* Rows (Users) - sorted alphabetically by username */}
        {Object.entries(heatmapData).sort(([, a], [, b]) => (a.full_name || '').localeCompare(b.full_name || '', 'it')).map(([userId, userData]) => {

          const aggregatedWorkload = {};
          columns.forEach(c => aggregatedWorkload[c] = { hours: 0, actual_hours: 0, tasks: [], actual_tasks: [] });

          const processWorkload = (sourceWorkload, isActualField) => {
            Object.entries(sourceWorkload || {}).forEach(([dStr, dayData]) => {
              const d = new Date(dStr);
              let key;
              if (viewMode === 'month') key = dStr.substring(0, 7);
              else if (viewMode === 'week') {
                const day = d.getDay();
                const diff = d.getDate() - day + (day === 0 ? -6 : 1);
                const monday = new Date(d);
                monday.setDate(diff);
                key = monday.toISOString().substring(0, 10);
              } else {
                key = dStr;
              }

              if (aggregatedWorkload[key]) {
                let dailySumRounded = 0;
                dayData.tasks.forEach(t => {
                  const roundedTaskHours = Number(t.hours.toFixed(1));
                  dailySumRounded += roundedTaskHours;

                  const targetTasks = isActualField ? aggregatedWorkload[key].actual_tasks : aggregatedWorkload[key].tasks;
                  const existing = targetTasks.find(x => x.id === t.id);
                  if (existing) {
                    existing.hours += roundedTaskHours;
                  } else {
                    targetTasks.push({ ...t, hours: roundedTaskHours });
                  }
                });
                if (isActualField) {
                  aggregatedWorkload[key].actual_hours += dailySumRounded;
                } else {
                  aggregatedWorkload[key].hours += dailySumRounded;
                }
              }
            });
          };

          if (dataMode === 'planned' || dataMode === 'both') {
            processWorkload(userData.workload, false);
          }
          if (dataMode === 'actual' || dataMode === 'both') {
            processWorkload(userData.actual_workload, dataMode === 'both' ? true : false);
          }

          const isCurrentUser = userData.username === user?.username;
          return (
            <React.Fragment key={userId}>
              <div
                className="heatmap-user-cell sticky-col sticky-user-col"
                onClick={() => toggleUser(userId)}
                style={{
                  cursor: 'pointer',
                  background: isCurrentUser ? 'rgba(59,130,246,0.13)' : undefined,
                  color: isCurrentUser ? 'var(--accent-400)' : undefined,
                  fontWeight: isCurrentUser ? 800 : undefined,
                  borderLeft: isCurrentUser ? '3px solid var(--accent-400)' : undefined,
                }}
                title="Clicca per espandere/comprimere il dettaglio progetti e fasi"
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100%' }}>
                  <span style={{ minWidth: '12px' }}>{expandedUsers[userId] ? '\u25BC' : '\u25B6'}</span>
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {userData.full_name}{isCurrentUser ? ' (tu)' : ''}
                  </span>
                </div>
              </div>

              {/* Cella Saturazione */}
              {columns.map(colKey => {
                const data = aggregatedWorkload[colKey];
                const isVacation = isUserOnVacation(userId, colKey);
                const isWeekendCol = isColumnWeekend(colKey);
                let colorClass = '';

                if (!isVacation && !isWeekendCol && data.hours > 0) {
                  if (data.hours > currentCapacity) {
                    colorClass = 'over-capacity';
                  } else if (data.hours === currentCapacity) {
                    colorClass = 'at-capacity';
                  } else {
                    colorClass = 'under-capacity';
                  }
                }

                let tooltipText = '';

                if (isVacation) {
                  tooltipText = 'Ferie (' + formatDateStr(colKey) + ')';
                  if (data.tasks.length > 0) {
                    tooltipText += '\n\n⚠️ ATTENZIONE: Ci sono ' + (data.hours?.toFixed(1) || 0) + 'h assegnate su un giorno di ferie!\n\n';
                    tooltipText += data.tasks.map(t => '📁 ' + (t.project_name || 'Progetto') + '\n📌 ' + t.name + (t.type === 'milestone' ? '' : (': ' + (t.hours?.toFixed(1) || 0) + 'h (' + (columnsMap.get(colKey) || '') + ')'))).join('\n\n');
                  }
                } else if (isWeekendCol) {
                  tooltipText = formatDateStr(colKey) + ' (Sabato/Domenica/Festivo)';
                } else if (data.tasks.length > 0) {
                  tooltipText = data.tasks.map(t => '📁 ' + (t.project_name || 'Progetto') + '\n📌 ' + t.name + (t.type === 'milestone' ? '' : (': ' + (t.hours?.toFixed(1) || 0) + 'h (' + columnsMap.get(colKey) + ') | Totale Fase: ' + (t.total_assigned_hours?.toFixed(1) || '-') + 'h'))).join('\n\n');
                } else {
                  tooltipText = 'Nessuna ora assegnata';
                }

                const getCellText = () => {
                  if (dataMode === 'both') {
                    if (data.actual_hours > 0 || data.hours > 0) {
                      return `${data.actual_hours.toFixed(1)}h / ${data.hours.toFixed(1)}h`;
                    }
                    return '-';
                  } else {
                    return data.hours > 0 ? `${data.hours.toFixed(1)}h` : '-';
                  }
                };

                const cellText = getCellText();
                const cellTextNode = dataMode === 'both' && cellText !== '-' ? <span style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>{cellText}</span> : cellText;

                let displayContent;
                if (isVacation) {
                  if (data.hours > 0 || (dataMode === 'both' && data.actual_hours > 0)) {
                    displayContent = (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', color: '#dc2626', fontWeight: 'bold' }} title={tooltipText}>
                        <AppIcon name="vacations" size={14} />
                        {dataMode === 'both' ? cellTextNode : <span>{data.hours.toFixed(1)}h</span>}
                      </div>
                    );
                  } else {
                    displayContent = <AppIcon name="vacations" size={16} />;
                  }
                } else if (isWeekendCol) {
                  displayContent = cellText !== '-' ? cellTextNode : '';
                } else {
                  displayContent = cellTextNode;
                }

                const isConflict = isVacation && data.hours > 0;
                const isClickable = data.tasks.length > 0 || (dataMode === 'both' && data.actual_tasks.length > 0);
                if (isConflict) {
                  colorClass = 'over-capacity';
                }

                return (
                  <div
                    key={colKey}
                    className={'heatmap-cell ' + colorClass + (colKey === todayKey ? ' today-cell' : '') + (isWeekendCol ? ' heatmap-weekend' : '')}
                    title={tooltipText}
                    onClick={() => {
                      if (isClickable) {
                        setDayDetails({
                          user: userData.full_name,
                          date: colKey,
                          dateLabel: formatDateStr(colKey),
                          tasks: data.tasks,
                          actual_tasks: data.actual_tasks || [],
                          hours: data.hours,
                          actual_hours: data.actual_hours || 0
                        });
                      }
                    }}
                    style={{
                      cursor: isClickable ? 'pointer' : 'default'
                    }}
                  >
                    {displayContent}
                  </div>
                );
              })}

              {/* Dettagli tasks se espanso (Timeline Nidificata) */}
              {expandedUsers[userId] && (() => {
                const uniqueTasks = {};
                const currentWorkload = dataMode === 'actual' ? (userData.actual_workload || {}) : (userData.workload || {});
                Object.values(currentWorkload).forEach(day => {
                  if (day.tasks) {
                    day.tasks.forEach(t => {
                      const isActive = t.project_status !== 'archived' && t.project_status !== 'completed';
                      if (isActive && !uniqueTasks[t.id]) {
                        uniqueTasks[t.id] = t;
                      }
                    });
                  }
                });

                const taskRows = Object.values(uniqueTasks).map(task => (
                  <React.Fragment key={task.id}>
                    {/* Header del task (Colonna 1) */}
                    <div
                      className="heatmap-cell sticky-col"
                      style={{
                        gridColumn: 1,
                        paddingLeft: '32px',
                        fontSize: '0.8rem',
                        textAlign: 'left',
                        justifyContent: 'flex-start',
                        background: 'var(--bg-tertiary)',
                        borderBottom: '1px solid var(--border-subtle)',
                        borderRight: '1px solid var(--border-default)',
                        zIndex: 20,
                        cursor: 'pointer'
                      }}
                      onClick={() => navigate(`/projects/${task.project_id}`)}
                    >
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={task.name}>
                        {task.name}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={task.project_name}>
                        📁 {task.project_name}
                      </div>
                    </div>

                    {/* Timeline per il task corrente (Celle sfondo grid + barra) */}
                    {(() => {
                      const activeCols = columns.map(colKey => {
                        if (viewMode === 'day') {
                          return colKey >= task.start_date && colKey <= task.end_date;
                        } else if (viewMode === 'week') {
                          const weekStart = colKey;
                          const weekEndObj = new Date(colKey);
                          weekEndObj.setDate(weekEndObj.getDate() + 6);
                          const weekEnd = weekEndObj.toISOString().substring(0, 10);
                          return task.start_date <= weekEnd && task.end_date >= weekStart;
                        } else if (viewMode === 'month') {
                          const monthStart = colKey + '-01';
                          const monthEndObj = new Date(monthStart);
                          monthEndObj.setMonth(monthEndObj.getMonth() + 1);
                          monthEndObj.setDate(0);
                          const monthEnd = monthEndObj.toISOString().substring(0, 10);
                          return task.start_date <= monthEnd && task.end_date >= monthStart;
                        }
                        return false;
                      });

                      const startIdx = activeCols.findIndex(v => v);
                      const lastIdx = activeCols.findLastIndex(v => v);

                      let startOffsetPx = 4;
                      let endOffsetPx = 4;
                      const COL_WIDTH = 90;

                      if (startIdx !== -1 && lastIdx !== -1) {
                        const taskStart = new Date(task.start_date);
                        const taskEnd = new Date(task.end_date);
                        taskStart.setHours(0, 0, 0, 0);
                        taskEnd.setHours(0, 0, 0, 0);

                        if (viewMode === 'week') {
                          const weekStartStr = columns[startIdx];
                          const weekStart = new Date(weekStartStr);
                          weekStart.setHours(0, 0, 0, 0);
                          if (taskStart > weekStart) {
                            const diffDays = Math.round((taskStart - weekStart) / (1000 * 60 * 60 * 24));
                            startOffsetPx = (diffDays / 7) * COL_WIDTH;
                          }

                          const weekEndStr = columns[lastIdx];
                          const weekEndObj = new Date(weekEndStr);
                          weekEndObj.setHours(0, 0, 0, 0);
                          weekEndObj.setDate(weekEndObj.getDate() + 6);
                          if (taskEnd < weekEndObj) {
                            const diffDays = Math.round((weekEndObj - taskEnd) / (1000 * 60 * 60 * 24));
                            endOffsetPx = (diffDays / 7) * COL_WIDTH;
                          }
                        } else if (viewMode === 'month') {
                          const monthStartStr = columns[startIdx] + '-01';
                          const monthStart = new Date(monthStartStr);
                          monthStart.setHours(0, 0, 0, 0);
                          const daysInStartMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
                          if (taskStart > monthStart) {
                            const diffDays = Math.round((taskStart - monthStart) / (1000 * 60 * 60 * 24));
                            startOffsetPx = (diffDays / daysInStartMonth) * COL_WIDTH;
                          }

                          const monthEndStr = columns[lastIdx] + '-01';
                          const monthEndObj = new Date(monthEndStr);
                          monthEndObj.setHours(0, 0, 0, 0);
                          const daysInEndMonth = new Date(monthEndObj.getFullYear(), monthEndObj.getMonth() + 1, 0).getDate();
                          monthEndObj.setDate(daysInEndMonth);
                          if (taskEnd < monthEndObj) {
                            const diffDays = Math.round((monthEndObj - taskEnd) / (1000 * 60 * 60 * 24));
                            endOffsetPx = (diffDays / daysInEndMonth) * COL_WIDTH;
                          }
                        }
                      }

                      let barWidth = ((lastIdx - startIdx + 1) * COL_WIDTH) - startOffsetPx - endOffsetPx;
                      if (viewMode === 'day') barWidth = ((lastIdx - startIdx + 1) * COL_WIDTH) - 8;
                      if (barWidth < 10) barWidth = 10;

                      return columns.map((colKey, idx) => {
                        const isStart = idx === startIdx;

                        return (
                          <div
                            key={`bg-${colKey}`}
                            className={'heatmap-cell' + (colKey === todayKey ? ' today-cell' : '') + (isColumnWeekend(colKey) ? ' heatmap-weekend' : '')}
                            style={{
                              borderBottom: '1px solid var(--border-subtle)',
                              position: isStart ? 'relative' : undefined,
                              zIndex: isStart ? 10 : undefined,
                              overflow: isStart ? 'visible' : undefined
                            }}
                          >
                            {isStart && (
                              <div style={{
                                position: 'absolute',
                                left: viewMode === 'day' ? '4px' : `${startOffsetPx}px`,
                                width: `${barWidth}px`,
                                top: '8px',
                                bottom: '8px',
                                backgroundColor: getTaskColor(task),
                                borderRadius: '4px',
                                display: 'flex',
                                alignItems: 'center',
                                padding: '0 8px',
                                color: '#fff',
                                fontSize: '0.75rem',
                                fontWeight: 600,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
                                zIndex: 11,
                                cursor: 'pointer'
                              }}
                                title={`${task.name} (${task.start_date} → ${task.end_date})`}
                                onClick={() => navigate(`/projects/${task.project_id}`)}
                              >
                                {task.name}
                              </div>
                            )}
                          </div>
                        );
                      });
                    })()}
                  </React.Fragment>
                ));

                const vacationRow = userData.vacations && userData.vacations.length > 0 ? (
                  <React.Fragment key="vacation-row">
                    <div
                      className="heatmap-cell sticky-col"
                      style={{
                        gridColumn: 1,
                        paddingLeft: '32px',
                        fontSize: '0.8rem',
                        textAlign: 'left',
                        justifyContent: 'flex-start',
                        background: 'var(--bg-tertiary)',
                        borderBottom: '1px solid var(--border-subtle)',
                        borderRight: '1px solid var(--border-default)',
                        zIndex: 20
                      }}
                    >
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title="Ferie">
                        Ferie
                      </div>
                    </div>
                    {(() => {
                      const vacationRanges = userData.vacations.map(vacation => {
                        const activeCols = columns.map(colKey => {
                          if (viewMode === 'day') {
                            return colKey >= vacation.start_date && colKey <= vacation.end_date;
                          } else if (viewMode === 'week') {
                            const weekStart = colKey;
                            const weekEndObj = new Date(colKey);
                            weekEndObj.setDate(weekEndObj.getDate() + 6);
                            const weekEnd = weekEndObj.toISOString().substring(0, 10);
                            return vacation.start_date <= weekEnd && vacation.end_date >= weekStart;
                          } else if (viewMode === 'month') {
                            const monthStart = colKey + '-01';
                            const monthEndObj = new Date(monthStart);
                            monthEndObj.setMonth(monthEndObj.getMonth() + 1);
                            monthEndObj.setDate(0);
                            const monthEnd = monthEndObj.toISOString().substring(0, 10);
                            return vacation.start_date <= monthEnd && vacation.end_date >= monthStart;
                          }
                          return false;
                        });
                        const startIdx = activeCols.findIndex(v => v);
                        const lastIdx = activeCols.findLastIndex(v => v);

                        let startOffsetPx = 4;
                        let endOffsetPx = 4;
                        const COL_WIDTH = 90;

                        if (startIdx !== -1 && lastIdx !== -1) {
                          const vStart = new Date(vacation.start_date);
                          const vEnd = new Date(vacation.end_date);
                          vStart.setHours(0, 0, 0, 0);
                          vEnd.setHours(0, 0, 0, 0);

                          if (viewMode === 'week') {
                            const weekStartStr = columns[startIdx];
                            const weekStart = new Date(weekStartStr);
                            weekStart.setHours(0, 0, 0, 0);
                            if (vStart > weekStart) {
                              const diffDays = Math.round((vStart - weekStart) / (1000 * 60 * 60 * 24));
                              startOffsetPx = (diffDays / 7) * COL_WIDTH;
                            }
                            const weekEndStr = columns[lastIdx];
                            const weekEndObj = new Date(weekEndStr);
                            weekEndObj.setHours(0, 0, 0, 0);
                            weekEndObj.setDate(weekEndObj.getDate() + 6);
                            if (vEnd < weekEndObj) {
                              const diffDays = Math.round((weekEndObj - vEnd) / (1000 * 60 * 60 * 24));
                              endOffsetPx = (diffDays / 7) * COL_WIDTH;
                            }
                          } else if (viewMode === 'month') {
                            const monthStartStr = columns[startIdx] + '-01';
                            const monthStart = new Date(monthStartStr);
                            monthStart.setHours(0, 0, 0, 0);
                            const daysInStartMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
                            if (vStart > monthStart) {
                              const diffDays = Math.round((vStart - monthStart) / (1000 * 60 * 60 * 24));
                              startOffsetPx = (diffDays / daysInStartMonth) * COL_WIDTH;
                            }
                            const monthEndStr = columns[lastIdx] + '-01';
                            const monthEndObj = new Date(monthEndStr);
                            monthEndObj.setHours(0, 0, 0, 0);
                            const daysInEndMonth = new Date(monthEndObj.getFullYear(), monthEndObj.getMonth() + 1, 0).getDate();
                            monthEndObj.setDate(daysInEndMonth);
                            if (vEnd < monthEndObj) {
                              const diffDays = Math.round((monthEndObj - vEnd) / (1000 * 60 * 60 * 24));
                              endOffsetPx = (diffDays / daysInEndMonth) * COL_WIDTH;
                            }
                          }
                        }

                        let barWidth = ((lastIdx - startIdx + 1) * COL_WIDTH) - startOffsetPx - endOffsetPx;
                        if (viewMode === 'day') barWidth = ((lastIdx - startIdx + 1) * COL_WIDTH) - 8;
                        if (barWidth < 10) barWidth = 10;

                        return { vacation, startIdx, lastIdx, startOffsetPx, barWidth };
                      }).filter(v => v.startIdx !== -1);

                      return columns.map((colKey, idx) => {
                        const startingVacations = vacationRanges.filter(v => v.startIdx === idx);
                        return (
                          <div
                            key={`bg-vac-${colKey}`}
                            className={'heatmap-cell' + (colKey === todayKey ? ' today-cell' : '') + (isColumnWeekend(colKey) ? ' heatmap-weekend' : '')}
                            style={{
                              borderBottom: '1px solid var(--border-subtle)',
                              position: startingVacations.length > 0 ? 'relative' : undefined,
                              zIndex: startingVacations.length > 0 ? 10 : undefined,
                              overflow: startingVacations.length > 0 ? 'visible' : undefined
                            }}
                          >
                            {startingVacations.map((v, vIdx) => (
                              <div key={vIdx} style={{
                                position: 'absolute',
                                left: viewMode === 'day' ? '4px' : `${v.startOffsetPx}px`,
                                width: `${v.barWidth}px`,
                                top: '8px',
                                bottom: '8px',
                                backgroundColor: '#f59e0b',
                                borderRadius: '4px',
                                display: 'flex',
                                alignItems: 'center',
                                padding: '0 8px',
                                color: '#fff',
                                fontSize: '0.75rem',
                                fontWeight: 600,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
                                zIndex: 11
                              }}
                                title={`${v.vacation.reason || 'Ferie'} (${v.vacation.start_date} → ${v.vacation.end_date})`}
                              >
                                {v.vacation.reason || 'Ferie'}
                              </div>
                            ))}
                          </div>
                        );
                      });
                    })()}
                  </React.Fragment>
                ) : null;

                return (
                  <React.Fragment key="user-details">
                    {vacationRow}
                    {taskRows}
                  </React.Fragment>
                );
              })()}
            </React.Fragment>
          );
        })}
      </div>
      )}

      {/* Modale Dettagli Giorno (Visualizzazione al click) */}
      {dayDetails && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 500 }}>
            <div className="modal-header">
              <h2>Impegni di {dayDetails.user} - {dayDetails.dateLabel}</h2>
              <button className="btn-ghost btn-icon" onClick={() => setDayDetails(null)}>
                <AppIcon name="close" />
              </button>
            </div>
            <div className="modal-content">
              <p style={{ color: 'var(--text-secondary)', marginBottom: '16px' }}>
                {dataMode === 'planned' ? (
                  <>Ore previste per questo giorno: <strong>{dayDetails.hours.toFixed(1)}h</strong></>
                ) : dataMode === 'actual' ? (
                  <>Ore consuntivate per questo giorno: <strong>{dayDetails.hours.toFixed(1)}h</strong></>
                ) : (
                  <>Ore Consuntivate / Previste: <strong>{dayDetails.actual_hours.toFixed(1)}h / {dayDetails.hours.toFixed(1)}h</strong></>
                )}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {(() => {
                  const combinedTasks = dataMode === 'both'
                    ? [...dayDetails.tasks, ...(dayDetails.actual_tasks || []).filter(a => !dayDetails.tasks.some(p => p.id === a.id))]
                    : dayDetails.tasks;

                  return combinedTasks.map((t, idx) => (
                    <div key={idx} style={{ padding: '12px', background: 'var(--bg-card)', borderRadius: '8px', border: '1px solid var(--border-default)', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                      <div style={{ color: 'var(--accent-500)', fontWeight: 700, marginBottom: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <AppIcon name="folder" size={16} /> {t.project_code && t.project_name && t.project_name !== 'Progetto non specificato' ? `${t.project_code} - ${t.project_name}` : (t.project_code || t.project_name || 'Progetto non specificato')}
                        </div>
                        {t.project_id && (
                          <button
                            className="btn btn-secondary"
                            onClick={() => navigate(`/projects/${t.project_id}`)}
                            style={{ padding: '4px 12px', fontSize: '0.8rem', minHeight: 'unset' }}
                          >
                            Apri commessa
                          </button>
                        )}
                      </div>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '1rem', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: 'var(--text-secondary)', display: 'flex' }}><AppIcon name="todo" size={16} /></span> {t.name}
                      </div>
                      {t.type !== 'milestone' && (
                        <div style={{ marginTop: 8, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                          {dataMode === 'planned' ? (
                            <>Assegnate: <strong style={{ color: 'var(--text-primary)' }}>{t.hours?.toFixed(1) || 0}h</strong> oggi su <strong style={{ color: 'var(--text-primary)' }}>{t.total_assigned_hours ? t.total_assigned_hours.toFixed(1) + 'h' : '-'}</strong> totali per questo addetto.</>
                          ) : dataMode === 'actual' ? (
                            <>Consuntivate: <strong style={{ color: 'var(--text-primary)' }}>{t.hours?.toFixed(1) || 0}h</strong> oggi.</>
                          ) : (
                            <>
                              Consuntivate: <strong style={{ color: 'var(--text-primary)' }}>{dayDetails.actual_tasks?.find(a => a.id === t.id)?.hours?.toFixed(1) || 0}h</strong> /
                              Previste: <strong style={{ color: 'var(--text-primary)' }}>{dayDetails.tasks?.find(p => p.id === t.id)?.hours?.toFixed(1) || 0}h</strong>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ));
                })()}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setDayDetails(null)}>
                  Chiudi
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
