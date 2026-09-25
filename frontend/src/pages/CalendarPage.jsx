import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { isWeekendOrHoliday } from '../utils/workingDays';
import {
  taskMatchesWorker,
  taskMatchesDepartment,
  vacationMatchesFilters,
  DEPARTMENT_OPTIONS,
} from '../utils/calendarFilters';
import TimelineView, { TIMELINE_COLUMNS, getProjectResponsible } from '../components/calendar/TimelineView';
import { getCustomDatesList } from '../utils/customDates';
import AppIcon from '../components/ui/AppIcon';
import './CalendarPage.css';


const STATUS_LABELS_IT = {
  planning: 'In pianificazione',
  active: 'In corso',
  completed: 'Completato',
  archived: 'Archiviato',
};

const STATUS_COLORS = {
  planning: '#f59e0b', // Amber
  active: '#10b981',   // Emerald
  completed: '#3b82f6',// Blue
  archived: '#6b7280', // Gray
};

const MONTH_NAMES_IT = [
  'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
  'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'
];

export const CALENDAR_FILTERS_STORAGE_KEY = 'hiplan-commesse-cal-filters';

export const SORT_OPTIONS = [
  { key: 'start_date', label: 'Data inizio commessa', shortLabel: 'Data inizio' },
  { key: 'end_date', label: 'Data fine commessa', shortLabel: 'Data fine' },
  { key: 'responsible', label: 'Responsabile', shortLabel: 'Responsabile' },
  { key: 'code', label: 'Codice commessa', shortLabel: 'Codice' },
  { key: 'name', label: 'Titolo commessa', shortLabel: 'Titolo' },
  { key: 'client', label: 'Cliente', shortLabel: 'Cliente' },
  { key: 'status', label: 'Stato commessa', shortLabel: 'Stato' },
];

export function sortProjects(projects, sortConfig, systemUsers = []) {
  if (!Array.isArray(projects)) return [];
  if (!sortConfig || sortConfig.key === 'none' || !sortConfig.key) return projects;

  const { key, direction = 'asc' } = sortConfig;
  const dirMultiplier = direction === 'desc' ? -1 : 1;

  return [...projects].sort((a, b) => {
    switch (key) {
      case 'start_date': {
        const aDate = a.start_date || '';
        const bDate = b.start_date || '';
        if (!aDate && !bDate) return 0;
        if (!aDate) return 1;
        if (!bDate) return -1;
        return aDate.localeCompare(bDate) * dirMultiplier;
      }
      case 'end_date': {
        const aDate = a.end_date || '';
        const bDate = b.end_date || '';
        if (!aDate && !bDate) return 0;
        if (!aDate) return 1;
        if (!bDate) return -1;
        return aDate.localeCompare(bDate) * dirMultiplier;
      }
      case 'responsible': {
        const aResp = getProjectResponsible(a, systemUsers);
        const bResp = getProjectResponsible(b, systemUsers);
        const aEmpty = !aResp || aResp === '-';
        const bEmpty = !bResp || bResp === '-';
        if (aEmpty && bEmpty) return 0;
        if (aEmpty) return 1;
        if (bEmpty) return -1;
        return aResp.localeCompare(bResp, 'it', { sensitivity: 'base' }) * dirMultiplier;
      }
      case 'code': {
        const aCode = a.code || '';
        const bCode = b.code || '';
        if (!aCode && !bCode) return 0;
        if (!aCode) return 1;
        if (!bCode) return -1;
        return aCode.localeCompare(bCode, 'it', { numeric: true }) * dirMultiplier;
      }
      case 'name': {
        const aName = a.name || '';
        const bName = b.name || '';
        return aName.localeCompare(bName, 'it', { sensitivity: 'base' }) * dirMultiplier;
      }
      case 'client': {
        const aClient = a.client || '';
        const bClient = b.client || '';
        if (!aClient && !bClient) return 0;
        if (!aClient) return 1;
        if (!bClient) return -1;
        return aClient.localeCompare(bClient, 'it', { sensitivity: 'base' }) * dirMultiplier;
      }
      case 'status': {
        const aStatus = a.status || '';
        const bStatus = b.status || '';
        return aStatus.localeCompare(bStatus) * dirMultiplier;
      }
      default:
        return 0;
    }
  });
}

export const loadSavedFilters = () => {
  try {
    if (typeof localStorage === 'undefined') {
      return { status: 'all', department: 'all', worker: 'all', search: '', sortKey: 'none', sortDirection: 'asc' };
    }
    const raw = localStorage.getItem(CALENDAR_FILTERS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return {
          status: typeof parsed.status === 'string' ? parsed.status : 'all',
          department: typeof parsed.department === 'string' ? parsed.department : 'all',
          worker: typeof parsed.worker === 'string' ? parsed.worker : 'all',
          search: typeof parsed.search === 'string' ? parsed.search : '',
          sortKey: typeof parsed.sortKey === 'string' ? parsed.sortKey : 'none',
          sortDirection: parsed.sortDirection === 'desc' ? 'desc' : 'asc',
        };
      }
    }
  } catch { }
  return { status: 'all', department: 'all', worker: 'all', search: '', sortKey: 'none', sortDirection: 'asc' };
};

export default function CalendarPage() {
  const navigate = useNavigate();
  const toast = useToast();

  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);

  // Stato navigazione mese
  const today = new Date();
  const [currYear, setCurrYear] = useState(today.getFullYear());
  const [currMonth, setCurrMonth] = useState(today.getMonth()); // 0-11

  // Controlli e filtri (con persistenza in cache / localStorage)
  const [viewMode, setViewMode] = useState(() => {
    return localStorage.getItem('hiplan-commesse-cal-view') || 'timeline';
  });
  const savedFilters = useMemo(() => loadSavedFilters(), []);
  const [filterStatus, setFilterStatus] = useState(savedFilters.status);
  const [filterWorker, setFilterWorker] = useState(savedFilters.worker);
  const [filterDepartment, setFilterDepartment] = useState(savedFilters.department);
  const [searchQuery, setSearchQuery] = useState(savedFilters.search);
  const [sortConfig, setSortConfig] = useState({
    key: savedFilters.sortKey || 'none',
    direction: savedFilters.sortDirection || 'asc',
  });
  const [systemUsers, setSystemUsers] = useState([]);
  const [vacations, setVacations] = useState([]);

  // Salva filtri e ordinamento in cache al variare
  useEffect(() => {
    try {
      if (
        filterStatus === 'all' &&
        filterDepartment === 'all' &&
        filterWorker === 'all' &&
        !searchQuery.trim() &&
        sortConfig.key === 'none'
      ) {
        localStorage.removeItem(CALENDAR_FILTERS_STORAGE_KEY);
      } else {
        localStorage.setItem(CALENDAR_FILTERS_STORAGE_KEY, JSON.stringify({
          status: filterStatus,
          department: filterDepartment,
          worker: filterWorker,
          search: searchQuery,
          sortKey: sortConfig.key,
          sortDirection: sortConfig.direction,
        }));
      }
    } catch { }
  }, [filterStatus, filterDepartment, filterWorker, searchQuery, sortConfig]);

  // Modali dettaglio
  const [selectedProject, setSelectedProject] = useState(null);
  const [selectedDayProjects, setSelectedDayProjects] = useState(null); // { dateStr, dayNum, list }
  const [editingVacation, setEditingVacation] = useState(null);
  const { user } = useAuth();

  // Colonne visibili Timeline
  const [timelineVisibleCols, setTimelineVisibleCols] = useState(() => {
    try {
      const saved = localStorage.getItem('hiplan-timeline-visible-cols');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch { }
    return ['code', 'name', 'client', 'responsible'];
  });

  const [showToolbarColsMenu, setShowToolbarColsMenu] = useState(false);
  const toolbarColsRef = useRef(null);

  const [showSortFilterMenu, setShowSortFilterMenu] = useState(false);
  const sortFilterRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (toolbarColsRef.current && !toolbarColsRef.current.contains(event.target)) {
        setShowToolbarColsMenu(false);
      }
      if (sortFilterRef.current && !sortFilterRef.current.contains(event.target)) {
        setShowSortFilterMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleTimelineVisibleColsChange = (cols) => {
    setTimelineVisibleCols(cols);
    try {
      localStorage.setItem('hiplan-timeline-visible-cols', JSON.stringify(cols));
    } catch { }
  };

  const toggleTimelineCol = (colId) => {
    if (timelineVisibleCols.includes(colId)) {
      if (timelineVisibleCols.length === 1) return;
      handleTimelineVisibleColsChange(timelineVisibleCols.filter(c => c !== colId));
    } else {
      handleTimelineVisibleColsChange([...timelineVisibleCols, colId]);
    }
  };

  const handleEditVacation = async (e) => {
    e.preventDefault();
    try {
      await api.put(`/vacations/admin/${editingVacation.id}`, {
        start_date: editingVacation.start_date,
        end_date: editingVacation.end_date,
        reason: editingVacation.reason
      });
      toast.success('Ferie modificate con successo');
      setEditingVacation(null);

      // we need to reload vacations
      const vacRes = await api.get('/vacations/all');
      setVacations(vacRes.data);
    } catch (err) {
      toast.error('Errore durante la modifica delle ferie');
    }
  };

  useEffect(() => {
    loadProjects();
  }, []);

  async function loadProjects() {
    setLoading(true);
    try {
      const [projRes, usersRes, vacRes] = await Promise.all([
        api.get('/projects'),
        api.get('/users').catch(() => ({ data: [] })),
        api.get('/vacations/all').catch(() => ({ data: [] }))
      ]);
      if (Array.isArray(usersRes.data)) {
        setSystemUsers(usersRes.data);
      }
      if (Array.isArray(vacRes.data)) {
        setVacations(vacRes.data);
      }
      const projectsWithTasks = await Promise.all(
        projRes.data.map(async (p) => {
          try {
            const { data: gData } = await api.get(`/projects/${p.id}/gantt`);
            return { ...p, tasks: Array.isArray(gData.tasks) ? gData.tasks : [] };
          } catch (e) {
            return { ...p, tasks: [] };
          }
        })
      );
      setProjects(projectsWithTasks);
    } catch (err) {
      toast.error("Errore nel caricamento delle commesse per il calendario");
    } finally {
      setLoading(false);
    }
  }

  // Elenco degli utenti attualmente presenti a sistema (dal backend)
  const allWorkers = useMemo(() => {
    return systemUsers.map(u => ({ username: u.username, name: u.full_name || u.username, department: u.department })).sort((a, b) => a.name.localeCompare(b.name));
  }, [systemUsers]);

  // Filtra e ordina commesse per stato, addetto, reparto, ricerca e sortConfig
  const filteredProjects = useMemo(() => {
    const list = projects.filter(p => {
      // 1. Filtro per stato commessa
      if (filterStatus === 'all') {
        // Mostra in automatico tutte le commesse in pianificazione, in corso e completate (esclude solo archiviate)
        const pStatus = (p.status || 'planning').toLowerCase();
        if (pStatus === 'archived') return false;
      } else {
        const pStatus = (p.status || '').toLowerCase();
        if (pStatus !== filterStatus.toLowerCase()) return false;
      }

      // 2. Filtro per addetto (utente) e/o reparto
      if (filterWorker !== 'all' || filterDepartment !== 'all') {
        const hasMatchingTask = Array.isArray(p.tasks) && p.tasks.some(t => {
          const deptMatch = taskMatchesDepartment(t, filterDepartment, systemUsers);
          const workerMatch = taskMatchesWorker(t, filterWorker, systemUsers);
          return deptMatch && workerMatch;
        });

        if (!hasMatchingTask) {
          if (!p.tasks || p.tasks.length === 0) {
            const hasWorker = filterWorker === 'all' || (Array.isArray(p.assigned_workers) && p.assigned_workers.some(w => taskMatchesWorker({ workers: [w] }, filterWorker, systemUsers)));
            const hasDept = filterDepartment === 'all' || (Array.isArray(p.assigned_workers) && p.assigned_workers.some(w => taskMatchesDepartment({ workers: [w] }, filterDepartment, systemUsers)));
            if (!hasWorker || !hasDept) return false;
          } else {
            return false;
          }
        }
      }

      // 3. Filtro per ricerca testuale
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const code = (p.code || '').toLowerCase();
        const name = (p.name || '').toLowerCase();
        const client = (p.client || '').toLowerCase();
        const taskMatch = Array.isArray(p.tasks) && p.tasks.some(t => {
          const tText = (t.text || '').toLowerCase();
          const tWorkers = Array.isArray(t.workers) ? t.workers.join(' ').toLowerCase() : '';
          return tText.includes(q) || tWorkers.includes(q);
        });
        if (!code.includes(q) && !name.includes(q) && !client.includes(q) && !taskMatch) return false;
      }
      return true;
    });

    return sortProjects(list, sortConfig, systemUsers);
  }, [projects, filterStatus, filterWorker, filterDepartment, searchQuery, systemUsers, sortConfig]);

  // Gestione Mese Precedente / Successivo / Oggi
  function prevMonth() {
    if (currMonth === 0) {
      setCurrMonth(11);
      setCurrYear(y => y - 1);
    } else {
      setCurrMonth(m => m - 1);
    }
  }

  function nextMonth() {
    if (currMonth === 11) {
      setCurrMonth(0);
      setCurrYear(y => y + 1);
    } else {
      setCurrMonth(m => m + 1);
    }
  }

  function goToToday() {
    setCurrYear(today.getFullYear());
    setCurrMonth(today.getMonth());
  }

  // Generazione calendario mensile
  const daysInMonth = new Date(currYear, currMonth + 1, 0).getDate();

  // Il giorno della settimana del 1° del mese (0 = Dom, 1 = Lun, ... 6 = Sab)
  // Convertiamo in standard italiano: 0 = Lun ... 6 = Dom
  const firstDayRaw = new Date(currYear, currMonth, 1).getDay();
  const firstDayIndex = firstDayRaw === 0 ? 6 : firstDayRaw - 1;

  // Calcola se un progetto è attivo in una certa data "YYYY-MM-DD"
  function isProjectActiveOnDate(project, dateStr) {
    if (!project.start_date) return false;
    const start = project.start_date.substring(0, 10);
    const end = project.end_date ? project.end_date.substring(0, 10) : start;
    return dateStr >= start && dateStr <= end;
  }

  // Costruisce array per la griglia
  const calendarCells = useMemo(() => {
    const cells = [];

    // Giorni mese precedente
    const prevMonthDays = new Date(currYear, currMonth, 0).getDate();
    for (let i = firstDayIndex - 1; i >= 0; i--) {
      const dNum = prevMonthDays - i;
      cells.push({
        dayNum: dNum,
        isOtherMonth: true,
        dateStr: null,
        projectsList: [],
      });
    }

    // Giorni mese corrente
    for (let d = 1; d <= daysInMonth; d++) {
      const monthStr = String(currMonth + 1).padStart(2, '0');
      const dayStr = String(d).padStart(2, '0');
      const dateStr = `${currYear}-${monthStr}-${dayStr}`;

      const activeList = [];

      // Aggiungi ferie
      const activeVacations = vacations.filter(v => {
        if (!vacationMatchesFilters(v, { filterWorker, filterDepartment, filterStatus, searchQuery }, systemUsers)) {
          return false;
        }
        const start = v.start_date.substring(0, 10);
        const end = v.end_date ? v.end_date.substring(0, 10) : start;
        return dateStr >= start && dateStr <= end;
      });
      activeVacations.forEach(v => {
        const u = systemUsers.find(user => user.username === v.username);
        const displayName = u?.full_name || v.username;
        activeList.push({
          id: `vac-${v.id}`,
          isVacation: true,
          name: `Ferie: ${displayName}`,
          displayTitle: `Ferie: ${displayName}`,
          color: '#f59e0b',
          status: 'planning'
        });
      });

      filteredProjects.forEach(p => {
        if (filterWorker !== 'all' || filterDepartment !== 'all') {
          // Quando si filtra per addetto o reparto, controlla le singole fasi dell'addetto/reparto attive in questa data
          const matchingTasks = (p.tasks || []).filter(t => {
            if (!taskMatchesWorker(t, filterWorker, systemUsers)) return false;
            if (!taskMatchesDepartment(t, filterDepartment, systemUsers)) return false;
            const tStart = t.start_date ? t.start_date.substring(0, 10) : '';
            const tEnd = t.end_date ? t.end_date.substring(0, 10) : tStart;
            return tStart <= dateStr && tEnd >= dateStr;
          });
          if (matchingTasks.length > 0) {
            activeList.push({
              ...p,
              matchingPhases: matchingTasks,
              displayTitle: `${p.code ? `[${p.code}] ` : ''}Fase: ${matchingTasks.map(t => t.text).join(' + ')}`,
            });
          }
        } else {
          if (isProjectActiveOnDate(p, dateStr)) {
            activeList.push({
              ...p,
              displayTitle: `${p.code ? `[${p.code}] ` : ''}${p.name}`,
            });
          }
        }
      });

      cells.push({
        dayNum: d,
        isOtherMonth: false,
        dateStr,
        projectsList: activeList,
        isToday: dateStr === today.toISOString().substring(0, 10),
      });
    }

    // Giorni mese successivo per completare la griglia (42 celle o fino a fine settimana)
    const remaining = (7 - (cells.length % 7)) % 7;
    for (let i = 1; i <= remaining; i++) {
      cells.push({
        dayNum: i,
        isOtherMonth: true,
        dateStr: null,
        projectsList: [],
      });
    }

    return cells;
  }, [currYear, currMonth, filteredProjects, firstDayIndex, daysInMonth, filterWorker, filterDepartment, filterStatus, searchQuery, vacations, systemUsers]);

  // Funzione per formattare la durata in giorni tra due date
  function getDurationDays(start, end) {
    if (!start) return '-';
    const s = new Date(start);
    const e = end ? new Date(end) : s;
    const diffTime = Math.abs(e - s);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
    return `${diffDays} giorni`;
  }

  // Gestione cambio reparto con reset coerente dell'addetto selezionato
  const handleDepartmentChange = (newDept) => {
    setFilterDepartment(newDept);
    if (newDept !== 'all' && filterWorker !== 'all') {
      const selectedUser = systemUsers.find(u => u.username === filterWorker);
      if (selectedUser && selectedUser.department && selectedUser.department !== newDept) {
        setFilterWorker('all');
      }
    }
  };

  const activeSortFilterCount = useMemo(() => {
    let count = 0;
    if (filterStatus !== 'all') count++;
    if (filterDepartment !== 'all') count++;
    if (filterWorker !== 'all') count++;
    if (sortConfig.key !== 'none') count++;
    return count;
  }, [filterStatus, filterDepartment, filterWorker, sortConfig]);

  const hasActiveFilters = filterStatus !== 'all' || filterDepartment !== 'all' || filterWorker !== 'all' || Boolean(searchQuery.trim()) || sortConfig.key !== 'none';
  const resetAllFilters = () => {
    setFilterStatus('all');
    setFilterDepartment('all');
    setFilterWorker('all');
    setSearchQuery('');
    setSortConfig({ key: 'none', direction: 'asc' });
    try {
      localStorage.removeItem(CALENDAR_FILTERS_STORAGE_KEY);
    } catch { }
  };

  return (
    <div className="calendar-page">
      {/* Intestazione e Toolbar */}
      <div className="calendar-header-toolbar">
        <div className="calendar-search-row">
          <div className="hiway-search-bar" style={{ position: 'relative', display: 'flex', alignItems: 'center', minWidth: 200, flex: '1 1 220px' }}>
            <img
              src="/hiway-icon.png"
              alt="HiWay"
              title="Cerca in HiWay GanttFlow"
              style={{ position: 'absolute', left: 10, width: 18, height: 18, objectFit: 'contain', pointerEvents: 'none' }}
            />
            <input
              type="text"
              className="input"
              style={{ width: '100%', paddingLeft: 36, paddingRight: 28, borderRadius: 18, padding: '8px 28px 8px 36px' }}
              placeholder="Cerca commessa o cliente..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Cancella ricerca"
                style={{ position: 'absolute', right: 10, background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 13 }}
              >
                <AppIcon name="close" size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="calendar-controls-row">
          <div className="calendar-nav-section">
            <h1 className="calendar-month-title">
              {MONTH_NAMES_IT[currMonth]} {currYear}
            </h1>
            <div className="calendar-nav-buttons">
              <button className="calendar-nav-btn" onClick={prevMonth} title="Mese precedente">‹ Prec.</button>
              <button className="calendar-nav-btn today" onClick={goToToday} title="Vai a oggi">Oggi</button>
              <button className="calendar-nav-btn" onClick={nextMonth} title="Mese successivo">Succ. ›</button>
            </div>
          </div>

          <div className="calendar-actions-section">

            {/* Pulsante Unico Ordina e Filtra */}
            <div style={{ position: 'relative' }} ref={sortFilterRef}>
              <button
                type="button"
                className={`btn btn-secondary btn-sm ${activeSortFilterCount > 0 ? 'btn-active-sort' : ''}`}
                onClick={() => setShowSortFilterMenu(prev => !prev)}
                title="Personalizza filtri e ordinamento commesse"
                style={{ fontSize: '12px', padding: '6px 12px', height: '35px', display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
              >
                <AppIcon name="filter" size={14} />
                <span>Ordina e filtra</span>
                {activeSortFilterCount > 0 && (
                  <span className="filter-sort-badge">
                    {activeSortFilterCount}
                  </span>
                )}
              </button>

              {showSortFilterMenu && (
                <div className="filter-sort-popover">
                  {/* Header Popover */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid var(--border-subtle)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>
                      <AppIcon name="filter" size={14} />
                      <span>Ordina e filtra</span>
                    </div>
                    {activeSortFilterCount > 0 && (
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={resetAllFilters}
                        style={{ fontSize: 11, color: 'var(--accent-600)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', fontWeight: 600 }}
                      >
                        Azzera tutto
                      </button>
                    )}
                  </div>

                  {/* Sezione Filtri */}
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                      Filtri
                    </div>

                    <div style={{ marginBottom: 10 }}>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
                        Stato commessa
                      </label>
                      <select
                        className="input"
                        style={{ width: '100%', fontSize: '12px', padding: '6px 10px' }}
                        value={filterStatus}
                        onChange={(e) => setFilterStatus(e.target.value)}
                      >
                        <option value="all">Commesse attive (predefinito)</option>
                        <option value="active">Solo In corso</option>
                        <option value="planning">Solo In pianificazione</option>
                        <option value="completed">Solo Completate</option>
                        <option value="archived">Archiviate</option>
                      </select>
                    </div>

                    <div style={{ marginBottom: 10 }}>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
                        Reparto
                      </label>
                      <select
                        className="input"
                        style={{ width: '100%', fontSize: '12px', padding: '6px 10px' }}
                        value={filterDepartment}
                        onChange={(e) => handleDepartmentChange(e.target.value)}
                      >
                        {DEPARTMENT_OPTIONS.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
                        Addetto assegnato
                      </label>
                      <select
                        className="input"
                        style={{ width: '100%', fontSize: '12px', padding: '6px 10px' }}
                        value={filterWorker}
                        onChange={(e) => setFilterWorker(e.target.value)}
                      >
                        <option value="all">Tutti gli utenti</option>
                        {allWorkers.map(w => (
                          <option key={w.username} value={w.username}>{w.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Sezione Ordinamento */}
                  <div style={{ paddingTop: 12, borderTop: '1px solid var(--border-subtle)', marginBottom: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                      Ordinamento
                    </div>

                    <div style={{ marginBottom: 10 }}>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
                        Ordina per
                      </label>
                      <select
                        className="input"
                        style={{ width: '100%', fontSize: '12px', padding: '6px 10px' }}
                        value={sortConfig.key}
                        onChange={(e) => setSortConfig(prev => ({ ...prev, key: e.target.value }))}
                      >
                        <option value="none">Predefinito (nessun ordinamento)</option>
                        {SORT_OPTIONS.map(opt => (
                          <option key={opt.key} value={opt.key}>{opt.label}</option>
                        ))}
                      </select>
                    </div>

                    {sortConfig.key !== 'none' && (
                      <div>
                        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
                          Direzione
                        </label>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            type="button"
                            className={`btn btn-sm ${sortConfig.direction === 'asc' ? 'btn-primary' : 'btn-secondary'}`}
                            style={{ flex: 1, fontSize: 11, padding: '4px 8px', height: 28, justifyContent: 'center' }}
                            onClick={() => setSortConfig(prev => ({ ...prev, direction: 'asc' }))}
                          >
                            ▲ Crescente
                          </button>
                          <button
                            type="button"
                            className={`btn btn-sm ${sortConfig.direction === 'desc' ? 'btn-primary' : 'btn-secondary'}`}
                            style={{ flex: 1, fontSize: 11, padding: '4px 8px', height: 28, justifyContent: 'center' }}
                            onClick={() => setSortConfig(prev => ({ ...prev, direction: 'desc' }))}
                          >
                            ▼ Decrescente
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Footer Popover */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      {activeSortFilterCount === 0 ? 'Nessun filtro attivo' : `${activeSortFilterCount} impostazion${activeSortFilterCount === 1 ? 'e attiva' : 'i attive'}`}
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      style={{ fontSize: 11, padding: '4px 12px' }}
                      onClick={() => setShowSortFilterMenu(false)}
                    >
                      Chiudi
                    </button>
                  </div>
                </div>
              )}
            </div>

            {viewMode === 'timeline' && (
              <div style={{ position: 'relative' }} ref={toolbarColsRef}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setShowToolbarColsMenu(prev => !prev)}
                  title="Personalizza colonne visibili"
                  style={{ fontSize: '12px', padding: '6px 12px', height: '35px', display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
                >
                  <AppIcon name="columns" size={14} />
                  <span>Colonne ({timelineVisibleCols.length}/{TIMELINE_COLUMNS.length})</span>
                </button>
                {showToolbarColsMenu && (
                  <div className="action-popover" style={{
                    position: 'absolute', top: '100%', right: 0, marginTop: 6, background: 'var(--bg-card)', border: '1px solid var(--border-default)',
                    borderRadius: 10, padding: 12, zIndex: 300, minWidth: 200, boxShadow: 'var(--shadow-lg)'
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Colonne visualizzate:
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {TIMELINE_COLUMNS.map(col => (
                        <label key={col.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)', userSelect: 'none' }}>
                          <input
                            type="checkbox"
                            checked={timelineVisibleCols.includes(col.id)}
                            onChange={() => toggleTimelineCol(col.id)}
                          />
                          {col.label}
                        </label>
                      ))}
                    </div>
                    <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 8, paddingTop: 8, display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        style={{ fontSize: 11, padding: '4px 8px', flex: 1 }}
                        onClick={() => handleTimelineVisibleColsChange(TIMELINE_COLUMNS.map(c => c.id))}
                      >
                        Tutte
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        style={{ fontSize: 11, padding: '4px 8px' }}
                        onClick={() => setShowToolbarColsMenu(false)}
                      >
                        Chiudi
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="calendar-view-toggle">
              <button
                className={`calendar-view-btn ${viewMode === 'grid' ? 'active' : ''}`}
                onClick={() => {
                  setViewMode('grid');
                  localStorage.setItem('hiplan-commesse-cal-view', 'grid');
                }}
              >
                <AppIcon name="grid" size={15} />
                Griglia mese
              </button>
              <button
                className={`calendar-view-btn ${viewMode === 'timeline' ? 'active' : ''}`}
                onClick={() => {
                  setViewMode('timeline');
                  localStorage.setItem('hiplan-commesse-cal-view', 'timeline');
                }}
              >
                <AppIcon name="timeline" size={15} />
                Timeline
              </button>
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-secondary)' }}>
          <div className="spinner" style={{ margin: '0 auto 16px' }} />
          Caricamento calendario commesse in corso...
        </div>
      ) : viewMode === 'grid' ? (
        /* VISTA GRIGLIA MESE */
        <div className="calendar-grid-container">
          <div className="calendar-weekdays-header">
            {WEEKDAYS_IT.map((day, idx) => (
              <div key={day} className={`calendar-weekday ${idx >= 5 ? 'weekend' : ''}`}>
                {day}
              </div>
            ))}
          </div>

          <div className="calendar-days-grid">
            {calendarCells.map((cell, idx) => {
              const isWeekendOrFestivo = cell.dateStr ? isWeekendOrHoliday(cell.dateStr) : (idx % 7 >= 5);
              return (
                <div
                  key={idx}
                  className={`calendar-day-cell ${cell.isOtherMonth ? 'other-month' : ''} ${isWeekendOrFestivo ? 'weekend-cell' : ''} ${cell.isToday ? 'today-cell' : ''}`}
                  onClick={() => {
                    if (!cell.isOtherMonth && cell.projectsList.length > 0) {
                      setSelectedDayProjects({
                        dateStr: cell.dateStr,
                        dayNum: cell.dayNum,
                        list: cell.projectsList,
                      });
                    }
                  }}
                >
                  <div className="calendar-day-header">
                    <span className="calendar-day-number">{cell.dayNum}</span>
                    {!cell.isOtherMonth && cell.projectsList.length > 0 && (
                      <span className="calendar-day-badge">
                        {cell.projectsList.length} {filterWorker !== 'all' ? (cell.projectsList.length === 1 ? 'fase' : 'fasi') : (cell.projectsList.length === 1 ? 'commessa' : 'commesse')}
                      </span>
                    )}
                  </div>

                  {!cell.isOtherMonth && (
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
                      <div className="calendar-projects-list" style={{ flex: 1, minHeight: 0 }}>
                        {cell.projectsList.slice(0, 1).map(proj => {
                          const color = proj.color || '#185FA5';
                          return (
                            <div
                              key={proj.id}
                              className="calendar-project-pill"
                              style={{
                                borderLeftColor: color,
                                background: `${color}26`,
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!proj.isVacation) {
                                  setSelectedProject(proj);
                                }
                              }}
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                if (proj.isVacation && (user?.role === 'admin' || user?.role === 'editor')) {
                                  const originalVacId = proj.id.replace('vac-', '');
                                  const originalVacation = vacations.find(v => v.id.toString() === originalVacId);
                                  if (originalVacation) {
                                    setEditingVacation(originalVacation);
                                  }
                                }
                              }}
                              title={proj.isVacation ? proj.displayTitle : `${proj.code ? `[${proj.code}] ` : ''}${proj.displayTitle || proj.name} (${STATUS_LABELS_IT[proj.status] || proj.status})`}
                            >
                              <span className="pill-text">
                                <strong>{proj.code ? `${proj.code} ` : ''}</strong>
                                {proj.displayTitle ? proj.displayTitle.replace(proj.code ? `[${proj.code}] ` : '', '') : proj.name}
                              </span>
                              <span
                                className="pill-status-dot"
                                style={{ background: STATUS_COLORS[proj.status] || '#a5b4fc' }}
                              />
                            </div>
                          );
                        })}
                      </div>
                      {cell.projectsList.length > 1 && (
                        <div
                          className="calendar-more-pill"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedDayProjects({
                              dateStr: cell.dateStr,
                              dayNum: cell.dayNum,
                              list: cell.projectsList,
                            });
                          }}
                          title={`Vedi altre ${cell.projectsList.length - 1} commesse`}
                        >
                          +{cell.projectsList.length - 1}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <TimelineView
          projects={filteredProjects}
          currYear={currYear}
          currMonth={currMonth}
          filterWorker={filterWorker}
          filterDepartment={filterDepartment}
          filterStatus={filterStatus}
          searchQuery={searchQuery}
          systemUsers={systemUsers}
          vacations={vacations}
          visibleColumns={timelineVisibleCols}
          onVisibleColumnsChange={handleTimelineVisibleColsChange}
          sortConfig={sortConfig}
          onSortChange={setSortConfig}
          onSelectProject={(proj) => {
            if (proj.selectedPhase) {
              navigate(`/projects/${proj.id}?tab=gantt`);
            } else {
              setSelectedProject(proj);
            }
          }}
          onDoubleClickVacation={(vac) => {
            if (user?.role === 'admin' || user?.role === 'editor') {
              setEditingVacation(vac);
            }
          }}
        />
      )}

      {/* MODALE DETTAGLIO COMMESSA (cliccando su una commessa) */}
      {selectedProject && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 540 }}>
            <div className="modal-header">
              <h2>Scheda Commessa</h2>
              <button className="btn-ghost btn-icon" onClick={() => setSelectedProject(null)} aria-label="Chiudi">
                <AppIcon name="close" />
              </button>
            </div>

            <div className="calendar-modal-content">
              <div className="calendar-modal-header-badge">
                <span style={{
                  padding: '4px 10px',
                  borderRadius: 6,
                  background: STATUS_COLORS[selectedProject.status] || '#6366f1',
                  color: '#fff',
                  fontSize: '0.75rem',
                  fontWeight: 700
                }}>
                  {STATUS_LABELS_IT[selectedProject.status] || selectedProject.status.toUpperCase()}
                </span>
                <span style={{
                  padding: '4px 10px',
                  borderRadius: 6,
                  background: `${selectedProject.color || '#185FA5'}33`,
                  border: `1px solid ${selectedProject.color || '#185FA5'}`,
                  color: selectedProject.color || '#185FA5',
                  fontSize: '0.75rem',
                  fontWeight: 700
                }}>
                  Colore: {selectedProject.color || '#185FA5'}
                </span>
              </div>

              <div className="calendar-modal-row">
                <span className="calendar-modal-label">Codice Commessa</span>
                <span className="calendar-modal-val">{selectedProject.code || 'N/D'}</span>
              </div>

              <div className="calendar-modal-row">
                <span className="calendar-modal-label">Titolo</span>
                <span className="calendar-modal-val">{selectedProject.name}</span>
              </div>

              <div className="calendar-modal-row">
                <span className="calendar-modal-label">Cliente</span>
                <span className="calendar-modal-val">{selectedProject.client || 'Nessun cliente specificato'}</span>
              </div>

              <div className="calendar-modal-row">
                <span className="calendar-modal-label">Periodo e Durata</span>
                <span className="calendar-modal-val">
                  {selectedProject.start_date || 'N/D'} ➔ {selectedProject.end_date || 'N/D'} ({getDurationDays(selectedProject.start_date, selectedProject.end_date)})
                </span>
              </div>

              {selectedProject.description && (
                <div style={{ marginTop: 6, background: 'var(--bg-primary)', padding: 14, borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
                  <span className="calendar-modal-label" style={{ display: 'block', marginBottom: 4 }}>Note e Specifiche</span>
                  <p style={{ fontSize: '0.875rem', color: 'var(--text-primary)', margin: 0 }}>
                    {selectedProject.description}
                  </p>
                </div>
              )}

              {/* Box Fasi e Addetti */}
              <div style={{ marginTop: 10, background: 'var(--bg-primary)', padding: 14, borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
                <span className="calendar-modal-label inline-detail-row" style={{ marginBottom: 8, color: 'var(--accent-400)', fontWeight: 700 }}>
                  <AppIcon name="gantt" size={15} />
                  Fasi Operative nella Commessa ({(selectedProject.tasks || []).length})
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 180, overflowY: 'auto' }}>
                  {(() => {
                    const phases = (selectedProject.tasks || []).filter(t => {
                      if (!taskMatchesWorker(t, filterWorker, systemUsers)) return false;
                      if (!taskMatchesDepartment(t, filterDepartment, systemUsers)) return false;
                      return true;
                    });
                    if (phases.length === 0) {
                      return <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Nessuna fase corrisponde ai filtri selezionati.</span>;
                    }
                    return phases.map(t => {
                      const cList = getCustomDatesList(t);
                      const isCustom = t.budget_mode === 'custom_dates' || cList.length > 0;
                      const customTotalH = cList.reduce((acc, d) => acc + (d.hours || 0), 0);
                      const phaseHours = isCustom && customTotalH > 0 ? customTotalH : (t.planned_hours || 8);

                      return (
                        <div
                          key={t.id}
                          style={{
                            padding: '8px 10px',
                            background: selectedProject.selectedPhase?.id === t.id ? 'rgba(99, 102, 241, 0.15)' : 'var(--bg-secondary)',
                            borderRadius: 6,
                            borderLeft: `3px solid ${selectedProject.selectedPhase?.id === t.id ? '#6366f1' : (selectedProject.color || '#185FA5')}`,
                            fontSize: '0.8125rem'
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 600, color: 'var(--text-primary)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
                              <span>↳ {t.text}</span>
                              {isCustom && (
                                <span className="badge badge-subtle" style={{ fontSize: '0.65rem' }}>
                                  Date da calendario ({cList.length} gg)
                                </span>
                              )}
                            </div>
                            <span className="inline-detail-row" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                              <AppIcon name="clock" size={12} />{phaseHours}h
                            </span>
                          </div>
                          <div className="inline-detail-row" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 4 }}>
                            <AppIcon name="calendar" size={12} />
                            <strong>{t.start_date?.slice(0, 10)}</strong> → <strong>{t.end_date?.slice(0, 10) || 'N/D'}</strong>
                            <AppIcon name="users" size={12} />
                            Addetti: <strong>{Array.isArray(t.workers) && t.workers.length > 0 ? t.workers.join(', ') : 'Nessuno'}</strong>
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setSelectedProject(null)}>
                Chiudi
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => navigate(`/projects/${selectedProject.id}`)}
              >
                Apri Scheda Commessa ➔
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODALE LISTA COMMESSE PER IL GIORNO (cliccando su + N altre) */}
      {selectedDayProjects && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 540 }}>
            <div className="modal-header">
              <h2>Commesse attive il {selectedDayProjects.dayNum} {MONTH_NAMES_IT[currMonth]} {currYear}</h2>
              <button className="btn-ghost btn-icon" onClick={() => setSelectedDayProjects(null)} aria-label="Chiudi">
                <AppIcon name="close" />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: '60vh', overflowY: 'auto' }}>
              {selectedDayProjects.list.map(proj => {
                const color = proj.color || '#185FA5';
                return (
                  <div
                    key={proj.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 14px',
                      background: 'var(--bg-primary)',
                      border: '1px solid var(--border-default)',
                      borderLeft: `4px solid ${color}`,
                      borderRadius: 8,
                      cursor: 'pointer',
                      transition: 'all 0.2s'
                    }}
                    onClick={() => {
                      if (!proj.isVacation) {
                        setSelectedDayProjects(null);
                        setSelectedProject(proj);
                      }
                    }}
                    onDoubleClick={(e) => {
                      if (proj.isVacation && (user?.role === 'admin' || user?.role === 'editor')) {
                        const originalVacId = proj.id.replace('vac-', '');
                        const originalVacation = vacations.find(v => v.id.toString() === originalVacId);
                        if (originalVacation) {
                          setSelectedDayProjects(null);
                          setEditingVacation(originalVacation);
                        }
                      }
                    }}
                  >
                    <div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
                        {proj.code && !proj.isVacation && <span style={{ color: 'var(--text-secondary)', marginRight: 6 }}>[{proj.code}]</span>}
                        {proj.name}
                      </div>
                      {!proj.isVacation && (
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                          {proj.client ? `${proj.client} — ` : ''}{STATUS_LABELS_IT[proj.status] || proj.status}
                        </div>
                      )}
                    </div>
                    {!proj.isVacation && (
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/projects/${proj.id}`);
                        }}
                      >
                        Apri ➔
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn btn-secondary" onClick={() => setSelectedDayProjects(null)}>Chiudi</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Vacation Modal */}
      {editingVacation && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <div className="modal-header">
              <h2>Modifica Ferie di {editingVacation.full_name || editingVacation.username}</h2>
              <button className="btn-ghost btn-icon" onClick={() => setEditingVacation(null)}>
                <AppIcon name="close" />
              </button>
            </div>
            <div className="modal-content">
              <form onSubmit={handleEditVacation} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                <div className="form-group">
                  <label>Dal giorno</label>
                  <input
                    type="date"
                    className="input"
                    value={editingVacation.start_date}
                    onChange={(e) => setEditingVacation({ ...editingVacation, start_date: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Al giorno (compreso)</label>
                  <input
                    type="date"
                    className="input"
                    value={editingVacation.end_date}
                    onChange={(e) => setEditingVacation({ ...editingVacation, end_date: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Motivo (opzionale)</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="Es. Ferie estive, Rol, Malattia..."
                    value={editingVacation.reason || ''}
                    onChange={(e) => setEditingVacation({ ...editingVacation, reason: e.target.value })}
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setEditingVacation(null)}>
                    Annulla
                  </button>
                  <button type="submit" className="btn btn-primary">
                    Salva Modifiche
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
