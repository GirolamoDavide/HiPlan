import React, { useState, useMemo } from 'react';
import AppIcon from './AppIcon';
import { isWeekendOrHoliday } from '../../utils/workingDays';
import './CustomDatesCalendarPicker.css';

const MONTH_NAMES = [
  'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
  'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'
];

const WEEKDAY_NAMES_SHORT = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];

export default function CustomDatesCalendarPicker({
  customDates = [], // Array of { date: 'YYYY-MM-DD', hours: number }
  onChange,
  workers = [],
  allVacations = [],
  initialDate,
}) {
  const [currentMonth, setCurrentMonth] = useState(() => {
    if (customDates && customDates.length > 0) {
      const firstD = customDates[0]?.date || customDates[0];
      const dt = new Date(firstD + 'T00:00:00');
      if (!isNaN(dt)) return new Date(dt.getFullYear(), dt.getMonth(), 1);
    }
    if (initialDate) {
      const dt = new Date(String(initialDate).split(' ')[0] + 'T00:00:00');
      if (!isNaN(dt)) return new Date(dt.getFullYear(), dt.getMonth(), 1);
    }
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  // Normalizza customDates in mappa { 'YYYY-MM-DD': hours }
  const datesMap = useMemo(() => {
    const map = new Map();
    if (Array.isArray(customDates)) {
      customDates.forEach(item => {
        if (typeof item === 'string') {
          map.set(item, 8);
        } else if (item && typeof item === 'object' && item.date) {
          map.set(item.date, item.hours !== undefined && item.hours !== null ? item.hours : 8);
        }
      });
    }
    return map;
  }, [customDates]);

  // Mappa ferie addetti: { 'YYYY-MM-DD': [ 'nomeAddetto', ... ] }
  const vacationsByDate = useMemo(() => {
    const map = new Map();
    if (!workers || workers.length === 0 || !allVacations || allVacations.length === 0) {
      return map;
    }

    const assignedVacations = allVacations.filter(v =>
      workers.includes(v.username) || (v.user && workers.includes(v.user.username)) || workers.includes(v.full_name)
    );

    assignedVacations.forEach(v => {
      const wName = v.username || v.full_name || 'Addetto';
      let cur = new Date(v.start_date + 'T00:00:00');
      const vEnd = new Date(v.end_date + 'T00:00:00');
      while (cur <= vEnd) {
        const y = cur.getFullYear();
        const m = String(cur.getMonth() + 1).padStart(2, '0');
        const d = String(cur.getDate()).padStart(2, '0');
        const dStr = `${y}-${m}-${d}`;
        if (!map.has(dStr)) {
          map.set(dStr, []);
        }
        if (!map.get(dStr).includes(wName)) {
          map.get(dStr).push(wName);
        }
        cur.setDate(cur.getDate() + 1);
      }
    });

    return map;
  }, [allVacations, workers]);

  const prevMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
  };

  const nextMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));
  };

  const daysInMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0).getDate();
  const firstDayOfWeek = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1).getDay();
  // Lunedì = 0, Domenica = 6
  const startingOffset = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1;

  // Toggle singola data
  const handleToggleDate = (dateStr) => {
    const nextMap = new Map(datesMap);
    if (nextMap.has(dateStr)) {
      nextMap.delete(dateStr);
    } else {
      nextMap.set(dateStr, 8);
    }
    emitChange(nextMap);
  };

  // Modifica ore per una data
  const handleHoursChange = (dateStr, newHours) => {
    const nextMap = new Map(datesMap);
    if (newHours === '' || newHours === null || newHours === undefined) {
      nextMap.set(dateStr, '');
    } else {
      const parsed = parseFloat(newHours);
      nextMap.set(dateStr, isNaN(parsed) ? '' : Math.round(parsed * 100) / 100);
    }
    emitChange(nextMap);
  };

  const handleBlurHours = (dateStr) => {
    const current = datesMap.get(dateStr);
    const parsed = parseFloat(current);
    if (isNaN(parsed) || parsed <= 0) {
      const nextMap = new Map(datesMap);
      nextMap.set(dateStr, 8);
      emitChange(nextMap);
    }
  };

  const handleStepHours = (dateStr, delta) => {
    const curVal = Number(datesMap.get(dateStr)) || 8;
    const nextVal = Math.min(24, Math.max(0.5, Math.round((curVal + delta) * 100) / 100));
    handleHoursChange(dateStr, nextVal);
  };

  // Rimuovi data
  const handleRemoveDate = (dateStr) => {
    const nextMap = new Map(datesMap);
    nextMap.delete(dateStr);
    emitChange(nextMap);
  };

  // Helper cambio massivo
  const emitChange = (map) => {
    const sorted = Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, hours]) => {
        const val = hours === '' ? '' : (Math.round((Number(hours) || 8) * 100) / 100);
        return { date, hours: val };
      });
    onChange(sorted);
  };

  // Quick Preset: Imposta tutte a N ore
  const setAllHoursTo = (h) => {
    const nextMap = new Map();
    datesMap.forEach((_, dStr) => {
      nextMap.set(dStr, h);
    });
    emitChange(nextMap);
  };

  // Quick Preset: Deseleziona tutte
  const handleClearAll = () => {
    emitChange(new Map());
  };

  // Lista ordinata dei giorni selezionati
  const sortedSelectedList = useMemo(() => {
    return Array.from(datesMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, hours]) => ({
        date,
        hours,
        vacations: vacationsByDate.get(date) || []
      }));
  }, [datesMap, vacationsByDate]);

  const totalDays = sortedSelectedList.length;
  const totalHours = useMemo(() => {
    const sum = sortedSelectedList.reduce((acc, item) => acc + (Number(item.hours) || 0), 0);
    return Math.round(sum * 100) / 100;
  }, [sortedSelectedList]);

  const renderCalendarDays = () => {
    const cells = [];
    const year = currentMonth.getFullYear();
    const month = String(currentMonth.getMonth() + 1).padStart(2, '0');

    for (let i = 0; i < startingOffset; i++) {
      cells.push(<div key={`empty-${i}`} className="cdp-day empty" />);
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const dayStr = String(d).padStart(2, '0');
      const dateStr = `${year}-${month}-${dayStr}`;
      const dtObj = new Date(year, currentMonth.getMonth(), d);
      const isWeekend = dtObj.getDay() === 0 || dtObj.getDay() === 6;
      const isHoliday = isWeekendOrHoliday(dtObj);
      const isSelected = datesMap.has(dateStr);
      const hours = isSelected ? datesMap.get(dateStr) : null;
      const vacWorkers = vacationsByDate.get(dateStr) || [];
      const hasVacationConflict = vacWorkers.length > 0;

      let cls = 'cdp-day';
      if (isSelected) cls += ' is-selected';
      if (isWeekend) cls += ' is-weekend';
      else if (isHoliday) cls += ' is-holiday';
      if (hasVacationConflict) cls += ' has-vacation';

      let tooltip = `${d} ${MONTH_NAMES[currentMonth.getMonth()]}`;
      if (isHoliday) tooltip += ' (Festivo)';
      if (hasVacationConflict) tooltip += ` • Ferie: ${vacWorkers.join(', ')}`;
      if (isSelected) tooltip += ` • Selezionato (${hours}h)`;

      cells.push(
        <button
          key={dateStr}
          type="button"
          className={cls}
          onClick={() => handleToggleDate(dateStr)}
          title={tooltip}
        >
          <span className="cdp-day-number">{d}</span>
          {isSelected && (
            <span className="cdp-day-badge">{hours}h</span>
          )}
          {hasVacationConflict && !isSelected && (
            <span className="cdp-vacation-dot" title={`Ferie: ${vacWorkers.join(', ')}`} />
          )}
        </button>
      );
    }

    return cells;
  };

  return (
    <div className="cdp-container card">
      <div className="cdp-layout">
        {/* Lato Sinistro: Calendario interattivo */}
        <div className="cdp-calendar-pane">
          <div className="cdp-calendar-header">
            <button
              type="button"
              className="btn btn-secondary cdp-nav-btn"
              onClick={prevMonth}
              title="Mese precedente"
            >
              <AppIcon name="chevronLeft" size={16} />
            </button>
            <div className="cdp-calendar-title">
              <strong>{MONTH_NAMES[currentMonth.getMonth()]}</strong>
              <span>{currentMonth.getFullYear()}</span>
            </div>
            <button
              type="button"
              className="btn btn-secondary cdp-nav-btn"
              onClick={nextMonth}
              title="Mese successivo"
            >
              <AppIcon name="chevronRight" size={16} />
            </button>
          </div>

          <div className="cdp-quick-actions">
            <button
              type="button"
              className="cdp-quick-btn"
              onClick={() => setAllHoursTo(8)}
              disabled={totalDays === 0}
              title="Imposta 8 ore per tutti i giorni selezionati"
            >
              Tutte 8h
            </button>
            <button
              type="button"
              className="cdp-quick-btn"
              onClick={() => setAllHoursTo(4)}
              disabled={totalDays === 0}
              title="Imposta 4 ore (mezza giornata) per tutti i giorni selezionati"
            >
              Tutte 4h
            </button>
            {totalDays > 0 && (
              <button
                type="button"
                className="cdp-quick-btn cdp-quick-btn--danger"
                onClick={handleClearAll}
                title="Deseleziona tutte le date"
              >
                Azzera
              </button>
            )}
          </div>

          <div className="cdp-grid-header">
            <div>Lun</div>
            <div>Mar</div>
            <div>Mer</div>
            <div>Gio</div>
            <div>Ven</div>
            <div className="weekend">Sab</div>
            <div className="weekend">Dom</div>
          </div>

          <div className="cdp-grid">
            {renderCalendarDays()}
          </div>

          <div className="cdp-legend">
            <div className="cdp-legend-item">
              <span className="cdp-legend-swatch cdp-legend-swatch--selected" />
              <span>Giorno di lavoro</span>
            </div>
            <div className="cdp-legend-item">
              <span className="cdp-legend-swatch cdp-legend-swatch--vacation" />
              <span>Addetto in ferie</span>
            </div>
            <div className="cdp-legend-item">
              <span className="cdp-legend-swatch cdp-legend-swatch--weekend" />
              <span>Weekend / Festivo</span>
            </div>
          </div>
        </div>

        {/* Lato Destro: Riepilogo giorni e ore selezionate */}
        <div className="cdp-summary-pane">
          <div className="cdp-summary-header">
            <div className="cdp-summary-heading">
              <AppIcon name="clock" size={16} />
              <span>Giorni di Lavoro ({totalDays})</span>
            </div>
            <div className="cdp-total-badge">
              <span>Totale:</span>
              <strong>{totalHours} ore</strong>
            </div>
          </div>

          {sortedSelectedList.length === 0 ? (
            <div className="cdp-empty-state">
              <AppIcon name="calendar" size={32} />
              <p>Nessun giorno selezionato.</p>
              <span>Clicca sui giorni del calendario a sinistra per pianificare le date in cui lavorare a questa fase.</span>
            </div>
          ) : (
            <div className="cdp-days-list">
              {sortedSelectedList.map(({ date, hours, vacations }) => {
                const parts = date.split('-');
                const dt = new Date(parts[0], parts[1] - 1, parts[2]);
                const dayName = WEEKDAY_NAMES_SHORT[dt.getDay()];
                const isWeekendDay = dt.getDay() === 0 || dt.getDay() === 6;
                const formattedDate = `${parts[2]}/${parts[1]}/${parts[0]}`;
                const hasVacation = vacations.length > 0;

                return (
                  <div key={date} className={`cdp-day-row${hasVacation ? ' has-vacation-conflict' : ''}`}>
                    <div className="cdp-day-row__info">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className={`cdp-weekday-pill${isWeekendDay ? ' is-weekend' : ''}`}>
                          {dayName}
                        </span>
                        <strong className="cdp-day-row__date">{formattedDate}</strong>
                      </div>
                      {hasVacation && (
                        <span
                          className="cdp-day-row__vacation-tag"
                          title={`Addetti in ferie: ${vacations.join(', ')}`}
                        >
                          <AppIcon name="alertTriangle" size={12} />
                          Ferie: {vacations.join(', ')}
                        </span>
                      )}
                    </div>

                    <div className="cdp-day-row__actions">
                      <div className="cdp-stepper">
                        <button
                          type="button"
                          className="cdp-stepper-btn"
                          onClick={() => handleStepHours(date, -0.5)}
                          title="-0.5 ore"
                        >
                          −
                        </button>
                        <div className="cdp-stepper-input-box">
                          <input
                            type="number"
                            min="0.5"
                            max="24"
                            step="0.5"
                            className="cdp-stepper-input"
                            value={hours}
                            onChange={(e) => handleHoursChange(date, e.target.value)}
                            onBlur={() => handleBlurHours(date)}
                            title="Ore di lavoro previste per questa data"
                          />
                          <span className="cdp-stepper-unit">h</span>
                        </div>
                        <button
                          type="button"
                          className="cdp-stepper-btn"
                          onClick={() => handleStepHours(date, 0.5)}
                          title="+0.5 ore"
                        >
                          +
                        </button>
                      </div>
                      <button
                        type="button"
                        className="cdp-remove-day-btn"
                        onClick={() => handleRemoveDate(date)}
                        title="Rimuovi questa data"
                      >
                        <AppIcon name="close" size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
