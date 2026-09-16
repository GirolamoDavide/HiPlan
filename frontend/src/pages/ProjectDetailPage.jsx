import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import api from '../api/client';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { gantt } from 'dhtmlx-gantt';
import GanttChart from '../components/gantt/GanttChart';
import './ProjectDetailPage.css';
import { STATUS_LABELS_IT, STATUS_OPTIONS } from '../utils/statusLabels';
import { PREDEFINED_PHASES, PHASE_DEFAULT_COLORS, getTaskColor } from '../utils/phaseColors';
import { calculateTaskEffHours, isTaskCompleted } from '../utils/taskCompletion';
import { addWorkingDays, subtractWorkingDays, countWorkingDays, isWeekendOrHoliday, isWorkingDay } from '../utils/workingDays';
import TaskComments from '../components/tasks/TaskComments';
import TaskChecklist from '../components/tasks/TaskChecklist';
import ActivityLogPanel from '../components/projects/ActivityLogModal';
import AppIcon from '../components/ui/AppIcon';
import MultiDatePicker from '../components/ui/MultiDatePicker';
import CustomDatesCalendarPicker from '../components/ui/CustomDatesCalendarPicker';
import SmartReplanningSection from '../components/projects/SmartReplanningSection';
import SearchableCombobox from '../components/ui/SearchableCombobox';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles, Bot, RefreshCw, AlertTriangle, CheckCircle, ChevronDown, ChevronUp } from 'lucide-react';
import useWebSocket from '../hooks/useWebSocket';

const departmentOptions = [
  { value: 'ufficio_tecnico', label: 'Ufficio Tecnico', color: '#3b82f6' },
  { value: 'produzione', label: 'Produzione', color: '#f59e0b' },
  { value: 'amministrazione', label: 'Amministrazione', color: '#64748b' },
  { value: 'acquisti', label: 'Acquisti', color: '#10b981' },
  { value: 'commerciale', label: 'Commerciale', color: '#ec4899' },
  { value: 'condivisa', label: 'Condivisa tra più reparti', color: '#8b5cf6' },
];

const deptNameMap = {
  ufficio_tecnico: 'Ufficio Tecnico',
  produzione: 'Produzione',
  amministrazione: 'Amministrazione',
  acquisti: 'Acquisti',
  commerciale: 'Commerciale',
  condivisa: 'Condivisa'
};

const deptColorMap = departmentOptions.reduce((acc, d) => ({ ...acc, [d.value]: d.color }), {});

const DEPT_OPTIONS = departmentOptions;

const BACKEND_URL = import.meta.env.VITE_API_URL
  ? import.meta.env.VITE_API_URL.replace(/\/api\/?$/, '')
  : `http://${window.location.hostname}:8000`;
const ALL_DEPTS = departmentOptions.map(d => d.value);

const GANTT_ALL_COLUMNS = [
  { id: 'start_date', label: 'Inizio' },
  { id: 'end_date', label: 'Fine' },
  { id: 'event_date', label: 'Data Evento' },
  { id: 'duration', label: 'Durata' },
  { id: 'progress', label: 'Progresso' },
  { id: 'priority', label: 'Priorità' },
  { id: 'workers', label: 'Addetti' },
  { id: 'department', label: 'Reparto' }
];

const ALL_PHASE_TYPES = [
  { id: 'task', label: 'Lavorazioni' },
  { id: 'milestone', label: 'Eventi (Milestone)' }
];

const PREDEFINED_WORKERS_DEFAULT = [];

export default function ProjectDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [project, setProject] = useState(null);
  const [notesText, setNotesText] = useState('');
  const [ganttData, setGanttData] = useState({ tasks: [], links: [] });
  const [predefinedWorkers, setPredefinedWorkers] = useState(PREDEFINED_WORKERS_DEFAULT);
  const [usersList, setUsersList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortConfig, setSortConfig] = useState({ key: null, direction: 'asc' });

  // Calcolo WebSocket URL
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsHost = import.meta.env.VITE_API_URL
    ? new URL(import.meta.env.VITE_API_URL).host
    : `${window.location.hostname}:8000`;
  const wsUrl = `${protocol}//${wsHost}/api/ws/projects/${id}`;

  const { isConnected: wsConnected } = useWebSocket(wsUrl, (msg) => {
    if (['task_created', 'task_updated', 'task_deleted', 'link_created', 'link_deleted', 'project_updated'].includes(msg.action)) {
      loadGanttDataOnly();
    }
  });

  async function loadGanttDataOnly() {
    try {
      const ganttRes = await api.get(`/projects/${id}/gantt?_t=${Date.now()}`);
      const sortedTasks = Array.isArray(ganttRes.data?.tasks)
        ? [...ganttRes.data.tasks].sort((a, b) => {
          const da = new Date(a.start_date ? String(a.start_date).split(' ')[0] : '1970-01-01');
          const db = new Date(b.start_date ? String(b.start_date).split(' ')[0] : '1970-01-01');
          if (da < db) return -1;
          if (da > db) return 1;
          return (a.id || 0) - (b.id || 0);
        }).map(t => {
          if (t.start_date && t.end_date && t.type !== 'milestone') {
            t.orig_duration = t.duration;
            const s = new Date(String(t.start_date).split(' ')[0] + 'T00:00:00');
            const e = new Date(String(t.end_date).split(' ')[0] + 'T00:00:00');
            let wDays = 0;
            let cur = new Date(s);
            while (cur <= e) {
              if (cur.getDay() !== 0 && cur.getDay() !== 6) wDays++;
              cur.setDate(cur.getDate() + 1);
            }
            t.duration = wDays > 0 ? wDays : 1;
          }
          return t;
        })
        : [];
      setGanttData({ ...ganttRes.data, tasks: sortedTasks });
    } catch (err) {
      console.error("Errore ricaricamento dati Gantt:", err);
    }
  }

  const canManageProject = useMemo(() => {
    if (!user || !project) return false;
    if (user.role === 'admin' || user.role === 'editor') return true;
    if (user.id === project.owner_id || user.id === project.responsible_id) return true;
    if (project.responsible_username && project.responsible_username === user.username) return true;
    return false;
  }, [user, project]);

  // STATO PER COLONNE GANTT (default: 'Attività' e 'Addetti', persistito in cache)
  const [visibleColumns, setVisibleColumns] = useState(() => {
    try {
      const saved = localStorage.getItem(`gantt_visible_cols_${id}`) || localStorage.getItem('ganttVisibleColumns_v2');
      return saved ? JSON.parse(saved) : ['workers'];
    } catch {
      return ['workers'];
    }
  });
  const [showColumnsMenu, setShowColumnsMenu] = useState(false);

  useEffect(() => {
    if (!id) return;
    try {
      localStorage.setItem(`gantt_visible_cols_${id}`, JSON.stringify(visibleColumns));
      localStorage.setItem('ganttVisibleColumns_v2', JSON.stringify(visibleColumns));
    } catch (e) { /* ignore */ }
  }, [id, visibleColumns]);

  // STATO PER FILTRO TIPO FASE (multiselezione persistita in cache fino a reset)
  const [phaseTypes, setPhaseTypes] = useState(() => {
    try {
      const saved = localStorage.getItem(`gantt_phase_types_${id}`);
      if (saved) return JSON.parse(saved);
      const old = localStorage.getItem(`gantt_phase_filter_${id}`);
      if (old === 'task') return ['task'];
      if (old === 'milestone') return ['milestone'];
      return ['task', 'milestone'];
    } catch {
      return ['task', 'milestone'];
    }
  });
  const [showPhaseFilterMenu, setShowPhaseFilterMenu] = useState(false);
  const [linkToDelete, setLinkToDelete] = useState(null);

  useEffect(() => {
    if (!id) return;
    try {
      localStorage.setItem(`gantt_phase_types_${id}`, JSON.stringify(phaseTypes));
    } catch (e) { /* ignore */ }
  }, [id, phaseTypes]);

  // STATO PER COLONNE TABELLA FASI
  const [tableVisibleColumns, setTableVisibleColumns] = useState(() => {
    const saved = localStorage.getItem('tableVisibleColumns');
    return saved ? JSON.parse(saved) : ['reparto', 'addetti', 'date', 'ore', 'semaforo', 'azioni'];
  });
  const [showTableColumnsMenu, setShowTableColumnsMenu] = useState(false);

  // STATO PER MENU EXPORT
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportSections, setExportSections] = useState({
    tasks: true,
    hours: true,
    gantt: true,
  });
  const [exportFormat, setExportFormat] = useState('pdf');

  // STATO PER COLONNE TABELLA ORE
  const [oreVisibleColumns, setOreVisibleColumns] = useState(() => {
    const saved = localStorage.getItem('oreVisibleColumns');
    return saved ? JSON.parse(saved) : ['addetti', 'giorni', 'ore_giorno', 'totale', 'semaforo', 'azioni'];
  });
  const [showOreColumnsMenu, setShowOreColumnsMenu] = useState(false);

  function toggleTableColumn(col) {
    setTableVisibleColumns(prev => prev.includes(col) ? prev.filter(c => c !== col) : [...prev, col]);
  }

  function toggleOreColumn(col) {
    setOreVisibleColumns(prev => prev.includes(col) ? prev.filter(c => c !== col) : [...prev, col]);
  }

  const [showDeptMenu, setShowDeptMenu] = useState(false);
  // STATO PER FILTRO REPARTI (persistito in cache fino a reset)
  const [activeDepartments, setActiveDepartments] = useState(() => {
    try {
      const saved = localStorage.getItem(`gantt_active_depts_${id}`);
      return saved ? JSON.parse(saved) : ALL_DEPTS;
    } catch {
      return ALL_DEPTS;
    }
  });

  useEffect(() => {
    if (!id) return;
    try {
      localStorage.setItem(`gantt_active_depts_${id}`, JSON.stringify(activeDepartments));
    } catch (e) { /* ignore */ }
  }, [id, activeDepartments]);

  const [showWorkerMenu, setShowWorkerMenu] = useState(false);
  // STATO PER FILTRO ADDETTI (persistito in cache fino a reset)
  const [activeWorkers, setActiveWorkers] = useState(() => {
    try {
      const saved = localStorage.getItem(`gantt_active_workers_${id}`);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    if (!id) return;
    try {
      localStorage.setItem(`gantt_active_workers_${id}`, JSON.stringify(activeWorkers));
    } catch (e) { /* ignore */ }
  }, [id, activeWorkers]);

  const [viewMode, setViewMode] = useState('day');
  const [ganttResetKey, setGanttResetKey] = useState(0);

  const handleResetGanttFiltersAndSort = () => {
    // 1. Colonne predefinite: solo attività ed addetti
    setVisibleColumns(['workers']);
    try {
      localStorage.setItem(`gantt_visible_cols_${id}`, JSON.stringify(['workers']));
      localStorage.setItem('ganttVisibleColumns_v2', JSON.stringify(['workers']));
    } catch (e) { /* ignore */ }

    // 2. Tipo fase: tutte le fasi
    setPhaseTypes(['task', 'milestone']);
    try {
      localStorage.setItem(`gantt_phase_types_${id}`, JSON.stringify(['task', 'milestone']));
      localStorage.removeItem(`gantt_phase_filter_${id}`);
    } catch (e) { /* ignore */ }

    // 3. Addetti: nessun addetto selezionato (tutti visibili)
    setActiveWorkers([]);
    try {
      localStorage.setItem(`gantt_active_workers_${id}`, JSON.stringify([]));
    } catch (e) { /* ignore */ }

    // 4. Reparti: tutti i reparti
    setActiveDepartments(ALL_DEPTS);
    try {
      localStorage.setItem(`gantt_active_depts_${id}`, JSON.stringify(ALL_DEPTS));
    } catch (e) { /* ignore */ }

    // 5. Rimuove l'ordinamento in cache (per data inizio predefinita)
    try {
      localStorage.removeItem(`gantt_sort_state_${id}`);
      localStorage.removeItem('gantt_sort_state_global');
    } catch (e) { /* ignore */ }

    // 6. Notifica GanttChart per forzare riordino per data inizio
    setGanttResetKey(prev => prev + 1);

    // Chiude tutti i menu a tendina
    setShowColumnsMenu(false);
    setShowPhaseFilterMenu(false);
    setShowWorkerMenu(false);
    setShowDeptMenu(false);

    toast.success('Filtri e ordinamento reimpostati ai valori predefiniti');
  };

  const activeTabDefault = () => {
    const params = new URLSearchParams(window.location.search);
    return params.get('tab') || 'gantt';
  };
  const [activeTab, setActiveTab] = useState(activeTabDefault);

  // Stato Modale Nuova / Modifica Fase
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [taskModalTab, setTaskModalTab] = useState('generale');
  const [budgetMode, setBudgetMode] = useState('start_days'); // 'start_end', 'start_hours', 'end_hours', 'start_days', 'end_days', 'start_days_hours'
  const [editingTask, setEditingTask] = useState(null);
  const [phaseTemplates, setPhaseTemplates] = useState([]);
  const [showPhaseDropdown, setShowPhaseDropdown] = useState(false);
  const [taskForm, setTaskForm] = useState({
    id: null,
    faseSel: PREDEFINED_PHASES[0],
    customText: '',
    color: PHASE_DEFAULT_COLORS[PREDEFINED_PHASES[0]] || '#3b82f6',
    start_date: new Date().toISOString().split('T')[0],
    end_date: new Date().toISOString().split('T')[0],
    duration_days: 1,
    planned_hours: 8.0,
    workers: [],
    worker_hours: {},
    excluded_dates: [],
    customWorker: '',
    department: null,
  });


  // Stato Modale Consuntivo Ore
  const [showOreModal, setShowOreModal] = useState(false);
  const [selectedTaskForHours, setSelectedTaskForHours] = useState(null);
  const [actualHoursMap, setActualHoursMap] = useState({});
  const [modalExtraDates, setModalExtraDates] = useState([]);
  const [specificExtraDate, setSpecificExtraDate] = useState('');
  const lastAddedDateRef = useRef({ date: '', time: 0 });
  const [allVacations, setAllVacations] = useState([]);
  const [openTicketsCount, setOpenTicketsCount] = useState(0);
  const [isAlertsExpanded, setIsAlertsExpanded] = useState(false);

  // Stato Analisi HiPlan AI per Commessa con persistenza in cache locale
  const [aiAnalysis, setAiAnalysis] = useState(null);
  const [isAiAnalyzing, setIsAiAnalyzing] = useState(false);

  const getCachedAnalysis = (projId) => {
    try {
      const cached = localStorage.getItem(`hiplan_ai_analysis_${projId}`);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (e) {
      console.error('Errore lettura cache analisi AI:', e);
    }
    return null;
  };

  const handleRunAiAnalysis = async (forceRefresh = false) => {
    if (!forceRefresh) {
      const cached = getCachedAnalysis(id);
      if (cached) {
        setAiAnalysis(cached);
        return;
      }
    }

    setIsAiAnalyzing(true);
    try {
      const res = await api.post(`/projects/${id}/ai-analysis`);
      if (res.data && res.data.success) {
        const now = new Date();
        const dataWithMeta = {
          ...res.data,
          generated_at: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          generated_date: now.toLocaleDateString('it-IT')
        };
        setAiAnalysis(dataWithMeta);
        try {
          localStorage.setItem(`hiplan_ai_analysis_${id}`, JSON.stringify(dataWithMeta));
        } catch (e) {
          console.error('Errore salvataggio cache analisi AI:', e);
        }
        addToast('Analisi HiPlan AI completata con successo', 'success');
      }
    } catch (err) {
      console.error('Errore analisi AI:', err);
      addToast(err?.response?.data?.detail || 'Errore durante l\'analisi AI della commessa', 'error');
    } finally {
      setIsAiAnalyzing(false);
    }
  };

  // Caricamento immediato da cache o reset al cambio commessa
  useEffect(() => {
    const cached = getCachedAnalysis(id);
    setAiAnalysis(cached);
  }, [id]);

  // Se apro la tab e non è ancora in cache, avvia l'analisi per la prima volta
  useEffect(() => {
    if (activeTab === 'ai_analysis' && !aiAnalysis && !isAiAnalyzing) {
      const cached = getCachedAnalysis(id);
      if (cached) {
        setAiAnalysis(cached);
      } else {
        handleRunAiAnalysis(false);
      }
    }
  }, [activeTab, id]);

  // Stato Modale Modifica Dati Commessa
  const [showEditProjectModal, setShowEditProjectModal] = useState(false);
  const [projectForm, setProjectForm] = useState({
    name: '',
    code: '',
    client: '',
    description: '',
    color: '#185FA5',
    start_date: '',
    end_date: '',
    is_atex: false,
    is_alimentare: false,
  });

  useEffect(() => {
    loadProject();
  }, [id]);

  const location = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const openTask = params.get('open_task');
    const openTab = params.get('open_tab') || 'generale';
    if (openTask && ganttData.tasks && ganttData.tasks.length > 0) {
      const t = ganttData.tasks.find(t => String(t.id) === openTask);
      if (t && !showTaskModal) {
        openEditTaskModal(t, openTab);
        // Remove from url
        params.delete('open_task');
        params.delete('open_tab');
        navigate({ search: params.toString() }, { replace: true });
      }
    }
  }, [location.search, ganttData.tasks]);

  // Sincronizza automaticamente le ore pianificate con l'addetto se c'è un solo addetto selezionato
  useEffect(() => {
    if (taskForm.taskType !== 'milestone' && taskForm.workers && taskForm.workers.length === 1) {
      const singleWorker = taskForm.workers[0];
      const plannedHours = Number(taskForm.planned_hours) || 0;
      const currentWorkerHours = Number(taskForm.worker_hours?.[singleWorker]) || 0;

      if (plannedHours !== currentWorkerHours) {
        setTaskForm(prev => ({
          ...prev,
          worker_hours: {
            ...prev.worker_hours,
            [singleWorker]: plannedHours
          }
        }));
      }
    }
  }, [taskForm.planned_hours, taskForm.workers, taskForm.taskType]);

  async function handleUploadAttachment(e) {
    if (!e.target.files || e.target.files.length === 0) return;
    await uploadFiles(e.target.files);
  }

  async function handleDropAttachment(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await uploadFiles(e.dataTransfer.files);
    }
  }

  async function uploadFiles(files) {
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.append('file', file);
        await api.post(`/projects/${id}/attachments`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      }
      toast.success('Allegati caricati!');
      loadProject();
    } catch (err) {
      toast.error('Errore durante il caricamento');
    }
  }

  async function handleDeleteAttachment(filename) {
    if (!window.confirm('Eliminare questo allegato?')) return;
    try {
      await api.delete(`/projects/${id}/attachments/${encodeURIComponent(filename)}`);
      toast.success('Allegato eliminato');
      loadProject();
    } catch (err) {
      toast.error('Errore durante l\'eliminazione');
    }
  }

  useEffect(() => {
    localStorage.setItem('tableVisibleColumns', JSON.stringify(tableVisibleColumns));
  }, [tableVisibleColumns]);

  useEffect(() => {
    localStorage.setItem('oreVisibleColumns', JSON.stringify(oreVisibleColumns));
  }, [oreVisibleColumns]);

  async function loadProject() {
    try {
      const [projRes, ganttRes, usersRes, vacRes, ticketsRes] = await Promise.all([
        api.get(`/projects/${id}`),
        api.get(`/projects/${id}/gantt?_t=${Date.now()}`),
        api.get('/users').catch(() => ({ data: [] })),
        api.get('/vacations/all').catch(() => ({ data: [] })),
        api.get('/tickets', { params: { project_id: id } }).catch(() => ({ data: [] }))
      ]);
      setProject(projRes.data);
      setNotesText(projRes.data.notes || '');
      const sortedTasks = Array.isArray(ganttRes.data?.tasks)
        ? [...ganttRes.data.tasks].sort((a, b) => {
          const da = new Date(a.start_date ? String(a.start_date).split(' ')[0] : '1970-01-01');
          const db = new Date(b.start_date ? String(b.start_date).split(' ')[0] : '1970-01-01');
          if (da < db) return -1;
          if (da > db) return 1;
          return (a.id || 0) - (b.id || 0);
        }).map(t => {
          if (t.start_date && t.end_date && t.type !== 'milestone') {
            t.orig_duration = t.duration;
            const s = new Date(String(t.start_date).split(' ')[0] + 'T00:00:00');
            const e = new Date(String(t.end_date).split(' ')[0] + 'T00:00:00');

            let exDates = [];
            if (typeof t.excluded_dates === 'string') {
              try { exDates = JSON.parse(t.excluded_dates); } catch (e) { }
            } else if (Array.isArray(t.excluded_dates)) {
              exDates = t.excluded_dates;
            }

            let wDays = 0;
            let cur = new Date(s);
            while (cur <= e) {
              const y = cur.getFullYear();
              const m = String(cur.getMonth() + 1).padStart(2, '0');
              const d = String(cur.getDate()).padStart(2, '0');
              const dStr = `${y}-${m}-${d}`;
              if (cur.getDay() !== 0 && cur.getDay() !== 6 && !exDates.includes(dStr)) {
                wDays++;
              }
              cur.setDate(cur.getDate() + 1);
            }
            t.duration = wDays > 0 ? wDays : 1;
          }
          return t;
        })
        : [];
      setGanttData({ ...ganttRes.data, tasks: sortedTasks });
      if (Array.isArray(usersRes.data)) {
        setPredefinedWorkers(usersRes.data.map(u => u.username));
        setUsersList(usersRes.data);
      }
      if (Array.isArray(vacRes.data)) {
        setAllVacations(vacRes.data);
      }
      if (Array.isArray(ticketsRes.data)) {
        const openTkts = ticketsRes.data.filter(t => t.status !== 'Completato');
        setOpenTicketsCount(openTkts.length);
      }
      fetchPhaseTemplates();
    } catch {
      toast.error('Progetto non trovato');
      navigate('/projects');
    } finally {
      setLoading(false);
    }
  }

  async function fetchPhaseTemplates() {
    try {
      const dept = user?.role === 'admin' ? 'all' : (user?.department || 'ufficio_tecnico');
      const res = await api.get('/phase-templates', { params: { department: dept } });
      if (Array.isArray(res.data)) {
        setPhaseTemplates(res.data);
      }
    } catch (err) {
      console.error('Errore caricamento phase templates:', err);
    }
  }

  function getAvailableTemplates() {
    if (phaseTemplates && phaseTemplates.length > 0) {
      return phaseTemplates;
    }
    return PREDEFINED_PHASES.filter(p => p !== '__custom__').map(p => ({
      id: p,
      name: p,
      department: 'ufficio_tecnico',
      default_color: PHASE_DEFAULT_COLORS[p] || '#3b82f6',
    }));
  }

  async function handleDeleteTemplateFromDropdown(tpl) {
    if (!window.confirm(`Confermi l'eliminazione della fase "${tpl.name}" dall'elenco suggerito?`)) return;
    try {
      if (tpl.id && tpl.id !== tpl.name) {
        await api.delete(`/phase-templates/${tpl.id}`);
      }
      toast.success('Fase eliminata dall\'elenco');
      await fetchPhaseTemplates();
      if (taskForm.faseSel === tpl.name) {
        setTaskForm(prev => ({ ...prev, faseSel: '__custom__', customText: tpl.name }));
      }
    } catch {
      toast.error('Errore durante l\'eliminazione della fase');
    }
  }

  async function handleStatusChange(newStatus) {
    if (!project) return;
    try {
      const { data } = await api.put(`/projects/${project.id}`, {
        ...project,
        status: newStatus,
      });
      setProject(data);
      toast.success(`Stato commessa aggiornato a "${STATUS_LABELS_IT[newStatus] || newStatus}"`);
    } catch {
      toast.error("Errore nell'aggiornamento dello stato della commessa");
    }
  }

  function formatDateOnly(d) {
    if (!d) return '';
    if (typeof d === 'string') return d.split(' ')[0].split('T')[0];
    if (d instanceof Date && !isNaN(d)) return d.toISOString().split('T')[0];
    try {
      return String(d).split(' ')[0].split('T')[0];
    } catch {
      return '';
    }
  }

  function formatDateItalian(d) {
    const str = formatDateOnly(d);
    if (!str) return '';
    const parts = str.split('-');
    if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    return str;
  }

  // Calcolo stato semaforo e ore giornaliere previste (algoritmo prototipo Ufficio Tecnico)
  function computeStato(task) {
    if (!task) return 'ok';
    if (task.type === 'milestone' || task.type === 'project') return 'ok';
    const totEff = calculateTaskEffHours(task);
    const plannedH = Number(task.planned_hours || 8.0);
    if (plannedH > 0 && totEff > plannedH) {
      return 'sforamento';
    }
    const isCompleted = isTaskCompleted(task);
    if (!isCompleted && (!task.workers || task.workers.length === 0) && task.type !== 'milestone') {
      return 'orfana';
    }
    if (isCompleted || (plannedH > 0 && totEff >= plannedH)) {
      return 'ok';
    }
    if (!task.start_date) return 'ok';

    const startStr = formatDateOnly(task.start_date);
    const endStr = task.end_date ? formatDateOnly(task.end_date) : startStr;
    if (!startStr) return 'ok';
    const start = new Date(startStr + 'T00:00:00');
    const end = new Date((endStr || startStr) + 'T00:00:00');
    if (isNaN(start) || isNaN(end)) return 'ok';
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Se non ancora iniziata
    if (today < start) return 'ok';

    let workDays = 0;
    let cur = new Date(start);
    while (cur <= end) {
      const dayOfWeek = cur.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) workDays++;
      cur.setDate(cur.getDate() + 1);
    }
    if (workDays <= 0) workDays = 1;
    const oreGg = plannedH / workDays;

    // Se la fase è scaduta (today > end)
    if (today > end) {
      if (totEff === 0) return 'mancata_consuntivazione';
      if (totEff < plannedH * 0.5) return 'ritardo';
      if (totEff < plannedH) return 'attenzione';
      return 'ok';
    }

    // Giorni lavorativi trascorsi prima di oggi
    let workDaysPast = 0;
    cur = new Date(start);
    while (cur < today) {
      const dayOfWeek = cur.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) workDaysPast++;
      cur.setDate(cur.getDate() + 1);
    }

    // Se siamo al primo giorno lavorativo della fase (nessun giorno passato concluso)
    if (workDaysPast === 0) {
      return 'ok';
    }

    const expectedPast = oreGg * workDaysPast;

    // Se le ore complessivamente consuntivate coprono o superano quanto atteso finora
    if (totEff >= expectedPast) {
      return 'ok';
    }

    // Se non è stata consuntivata alcuna ora
    if (totEff === 0) {
      return 'mancata_consuntivazione';
    }

    // Se le ore consuntivate sono inferiori al 50% di quelle attese finora
    if (totEff < expectedPast * 0.5) {
      return 'ritardo';
    }

    return 'attenzione';
  }

  // Helper giorni lavorativi tra due date per tabella ore
  function getWorkDatesBetween(startInput, endInput) {
    const dates = [];
    const startStr = formatDateOnly(startInput);
    const endStr = formatDateOnly(endInput || startInput);
    if (!startStr) return dates;
    const start = new Date(startStr + 'T00:00:00');
    const end = endStr ? new Date(endStr + 'T00:00:00') : new Date(startStr + 'T00:00:00');
    if (isNaN(start) || isNaN(end)) return dates;
    let cur = new Date(start);
    while (cur <= end) {
      const dayOfWeek = cur.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        const y = cur.getFullYear();
        const m = String(cur.getMonth() + 1).padStart(2, '0');
        const d = String(cur.getDate()).padStart(2, '0');
        dates.push(`${y}-${m}-${d}`);
      }
      cur.setDate(cur.getDate() + 1);
    }
    return dates;
  }

  // Helper giorni effettivi in cui la fase è stata assegnata (vale per qualsiasi modalità budget e pianificazione)
  function getAssignedDatesForTask(task) {
    if (!task) return [];

    // Se la modalità è custom_dates, consideriamo solo le date esplicitamente configurate
    if (task.budget_mode === 'custom_dates') {
      let list = task.custom_dates;
      if (typeof list === 'string') {
        try { list = JSON.parse(list); } catch (e) { list = []; }
      }
      if (Array.isArray(list)) {
        const dates = list.map(item => {
          if (typeof item === 'string') return item;
          if (item && item.date) return item.date;
          return null;
        }).filter(Boolean);
        return Array.from(new Set(dates)).sort();
      }
      return [];
    }

    // Per tutte le altre modalità (start_days, start_end, start_hours, end_days, end_hours, start_days_hours, end_days_hours):
    // Considera tutti i giorni lavorativi compresi tra start_date ed end_date (esclusi sab, dom, festività nazionali e date escluse)
    const startStr = formatDateOnly(task.start_date);
    const endStr = formatDateOnly(task.end_date || task.start_date);
    if (!startStr) return [];

    let excludedDays = [];
    if (Array.isArray(task.excluded_dates)) {
      excludedDays = task.excluded_dates;
    } else if (typeof task.excluded_dates === 'string') {
      try { excludedDays = JSON.parse(task.excluded_dates || '[]'); } catch (e) { excludedDays = []; }
    }

    const dates = [];
    const start = new Date(startStr + 'T00:00:00');
    const end = endStr ? new Date(endStr + 'T00:00:00') : new Date(startStr + 'T00:00:00');
    if (isNaN(start) || isNaN(end)) return [];

    let cur = new Date(start);
    while (cur <= end) {
      if (isWorkingDay(cur, excludedDays)) {
        const y = cur.getFullYear();
        const m = String(cur.getMonth() + 1).padStart(2, '0');
        const d = String(cur.getDate()).padStart(2, '0');
        dates.push(`${y}-${m}-${d}`);
      }
      cur.setDate(cur.getDate() + 1);
    }
    return dates;
  }

  // Calcolo totali di commessa e allerte
  const { totalPrev, totalEff, delaysList } = useMemo(() => {
    let prev = 0;
    let eff = 0;
    const delays = [];

    ganttData.tasks.forEach(t => {
      prev += Number(t.planned_hours) || 0;
      let tEff = 0;
      if (t.actual_hours && typeof t.actual_hours === 'object') {
        Object.values(t.actual_hours).forEach(dayMap => {
          if (dayMap && typeof dayMap === 'object') {
            Object.values(dayMap).forEach(h => { tEff += Number(h) || 0; });
          }
        });
      }
      eff += tEff;

      const st = computeStato(t);
      if (['ritardo', 'attenzione', 'ritardo_ferie', 'sforamento', 'orfana', 'mancata_consuntivazione'].includes(st)) {
        delays.push({ task: t, stato: st, tEff });
      }
    });

    if (project && (!project.responsible_id && !project.responsible_name) && (user?.role === 'admin' || user?.role === 'editor')) {
      delays.push({ isProjectAlert: true, type: 'no_responsible', text: 'Commessa senza responsabile assegnato', stato: 'no_responsible' });
    }

    return { totalPrev: prev, totalEff: eff, delaysList: delays };
  }, [ganttData.tasks, project, user?.role]);

  // Gestione Task da Gantt e Form
  async function handleTaskUpdate(taskId, data) {
    if (project && project.end_date) {
      if (data.end_date && data.end_date.substring(0, 10) > project.end_date) {
        toast.error(`La data di fine fase non può superare la data di fine commessa (${formatDateItalian(project.end_date)})`);
        loadProject();
        return;
      }
      if (data.start_date && data.start_date.substring(0, 10) > project.end_date) {
        toast.error(`La data di inizio fase non può superare la data di fine commessa (${formatDateItalian(project.end_date)})`);
        loadProject();
        return;
      }
    }
    try {
      await api.put(`/projects/${id}/tasks/${taskId}`, data);
      loadProject();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Errore aggiornamento fase');
      loadProject();
    }
  }

  async function handleSaveNotes() {
    try {
      await api.put(`/projects/${id}`, { notes: notesText });
      // aggiorna solo il campo notes nel project locale senza ricaricare tutto
      setProject(prev => prev ? { ...prev, notes: notesText } : prev);
    } catch (err) {
      toast.error('Errore durante il salvataggio delle note');
    }
  }

  async function handleTaskCreate(data, tempId) {
    if (project && project.end_date) {
      if (data.end_date && data.end_date.substring(0, 10) > project.end_date) {
        toast.error(`La data di fine fase non può superare la data di fine commessa (${formatDateItalian(project.end_date)})`);
        loadProject();
        return;
      }
      if (data.start_date && data.start_date.substring(0, 10) > project.end_date) {
        toast.error(`La data di inizio fase non può superare la data di fine commessa (${formatDateItalian(project.end_date)})`);
        loadProject();
        return;
      }
    }
    try {
      const { data: created } = await api.post(`/projects/${id}/tasks`, data);
      if (tempId) gantt.changeTaskId(tempId, created.id);
      loadProject();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Errore creazione fase');
      loadProject();
    }
  }

  async function handleTaskDelete(taskId, skipConfirm = false) {
    if (!skipConfirm && !window.confirm("Confermi l'eliminazione di questa fase di lavorazione?")) return;
    try {
      await api.delete(`/projects/${id}/tasks/${taskId}`);
      loadProject();
    } catch { /* task già rimosso */ }
  }

  async function handleToggleTaskCompleted(task, currentIsCompleted) {
    if (!canManageProject) {
      toast.error('Solo proprietario, referente o editor possono segnare la fase come completata/in corso');
      return false;
    }

    if (currentIsCompleted) {
      if (user?.role !== 'admin' && user?.role !== 'editor') {
        toast.error('Solo un admin o un editor può riaprire una fase già completata.');
        return false;
      }
      if (!window.confirm(`Sei sicuro di voler riaprire la fase "${task.text}"?`)) return false;
    } else {
      if (!window.confirm(`Sei sicuro di voler segnare la fase "${task.text}" come completata?`)) return false;
    }

    const newCompleted = currentIsCompleted ? -1 : 1;
    try {
      await api.put(`/projects/${id}/tasks/${task.id}`, {
        completed: newCompleted
      });
      toast.success(newCompleted === 1 ? 'Fase completata!' : 'Fase ripristinata in corso');
      loadProject();
      return true;
    } catch {
      toast.error("Errore durante l'aggiornamento dello stato della fase");
      return false;
    }
  }

  async function handleLinkCreate(data, tempId) {
    try {
      const { data: created } = await api.post(`/projects/${id}/links`, data);
      const newLinkId = created?.id || tempId;
      if (tempId && gantt.isLinkExists && gantt.isLinkExists(tempId)) {
        gantt.changeLinkId(tempId, newLinkId);
      }
      setGanttData(prev => {
        const newLink = {
          id: String(newLinkId),
          source: String(data.source),
          target: String(data.target),
          type: String(data.type || '0')
        };
        if (prev.links.some(l => String(l.id) === String(newLinkId))) return prev;
        return { ...prev, links: [...prev.links, newLink] };
      });
    } catch {
      toast.error('Errore creazione dipendenza');
      if (tempId && gantt.isLinkExists && gantt.isLinkExists(tempId)) {
        window.__programmaticLinkDelete = true;
        gantt.deleteLink(tempId);
        window.__programmaticLinkDelete = false;
      }
    }
  }

  async function handleLinkDelete(linkId, skipConfirm = false) {
    if (!skipConfirm) {
      setLinkToDelete(linkId);
      return;
    }
    try {
      await api.delete(`/projects/${id}/links/${linkId}`);
      setGanttData(prev => ({
        ...prev,
        links: prev.links.filter(l => String(l.id) !== String(linkId))
      }));
      setLinkToDelete(null);
    } catch (e) {
      toast.error('Errore eliminazione dipendenza');
      console.error(e);
      setLinkToDelete(null);
    }
  }

  function openNewTaskModal() {
    fetchPhaseTemplates();
    const available = getAvailableTemplates();
    const initialFase = '__custom__';
    const initialDept = user?.department && user.department !== 'admin' ? user.department : 'ufficio_tecnico';
    const initialColor = departmentOptions.find(d => d.value === initialDept)?.color || '#3b82f6';

    setEditingTask(null);
    setTaskModalTab('generale');
    setShowPhaseDropdown(false);
    setTaskForm({
      taskType: 'task',
      faseSel: initialFase,
      customText: '',
      color: initialColor,
      start_date: new Date().toISOString().split('T')[0],
      end_date: new Date().toISOString().split('T')[0],
      duration_days: 1,
      planned_hours: 8.0,
      budgetMode: 'start_days',
      custom_dates: [],
      workers: [],
      worker_hours: {},
      customWorker: '',
      department: initialDept,
      completed: 0,
    });
    setShowTaskModal(true);
  }

  function openEditTaskModal(task, initialTab = 'generale') {
    if (!canManageProject && initialTab === 'generale') {
      initialTab = 'consuntivo';
    }
    let realTask = null;
    if (ganttData && Array.isArray(ganttData.tasks)) {
      realTask = ganttData.tasks.find(t => String(t.id) === String(task.id));
    }
    if (!realTask) {
      realTask = { ...task };
      if (realTask.end_date && realTask.type !== 'milestone') {
        const ed = new Date(realTask.end_date);
        ed.setDate(ed.getDate() - 1);
        realTask.end_date = ed;
      }
    }

    fetchPhaseTemplates();
    const available = getAvailableTemplates();
    const isPredefined = available.some(t => t.name === realTask.text) || PREDEFINED_PHASES.includes(realTask.text);

    setEditingTask(realTask);
    setTaskModalTab(initialTab);
    prepareOreDataForTask(realTask, true);
    setShowPhaseDropdown(false);

    const safeDate = (d) => {
      if (!d) return new Date().toISOString().split('T')[0];
      if (d instanceof Date) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      }
      return String(d).split(' ')[0].split('T')[0];
    };

    const s = safeDate(realTask.start_date);
    const e = safeDate(realTask.end_date);
    const diff = countWorkingDays(s, e, realTask.excluded_dates);
    const taskDur = Number(realTask.orig_duration) || Number(realTask.duration) || diff;
    const taskPlan = Number(realTask.planned_hours) || (taskDur * 8.0);
    const mode = realTask.budget_mode || realTask.budgetMode || (Math.abs(taskPlan - taskDur * 8.0) > 0.1 ? 'start_days_hours' : 'start_days');
    setBudgetMode(mode);

    let parsedCustomDates = [];
    if (realTask.custom_dates) {
      if (Array.isArray(realTask.custom_dates)) {
        parsedCustomDates = realTask.custom_dates;
      } else if (typeof realTask.custom_dates === 'string') {
        try {
          parsedCustomDates = JSON.parse(realTask.custom_dates);
        } catch (err) {
          parsedCustomDates = [];
        }
      }
    }

    const isComp = Number(realTask.completed) === 1 || Number(task.completed) === 1 || isTaskCompleted(realTask) || isTaskCompleted(task);
    const compVal = isComp ? 1 : (Number(realTask.completed) === -1 || Number(task.completed) === -1 ? -1 : 0);

    setTaskForm({
      taskType: realTask.type === 'milestone' || Number(realTask.duration) === 0 ? 'milestone' : 'task',
      faseSel: isPredefined ? realTask.text : '__custom__',
      customText: isPredefined ? '' : realTask.text,
      color: getTaskColor(realTask),
      start_date: s,
      end_date: e,
      duration_days: taskDur,
      planned_hours: taskPlan,
      budgetMode: mode,
      custom_dates: parsedCustomDates,
      workers: Array.isArray(realTask.workers) ? realTask.workers : [],
      worker_hours: typeof realTask.worker_hours === 'object' ? realTask.worker_hours : {},
      excluded_dates: Array.isArray(realTask.excluded_dates) ? realTask.excluded_dates : [],
      customWorker: '',
      department: realTask.department || (user?.department && user.department !== 'admin' ? user.department : 'ufficio_tecnico'),
      completed: compVal,
    });
    setShowTaskModal(true);
  }


  function handleBudgetModeChange(newMode) {
    setBudgetMode(newMode);
    setTaskForm(prev => {
      const updates = { budgetMode: newMode };
      if (newMode === 'start_end') {
        const days = countWorkingDays(prev.start_date, prev.end_date, prev.excluded_dates);
        updates.duration_days = days;
        updates.planned_hours = days * 8.0;
      } else if (newMode === 'start_hours') {
        const hours = Number(prev.planned_hours) || 8;
        const days = Math.max(1, Math.ceil(hours / 8.0));
        updates.duration_days = days;
        updates.end_date = addWorkingDays(prev.start_date || new Date(), days, prev.excluded_dates);
      } else if (newMode === 'end_hours') {
        const hours = Number(prev.planned_hours) || 8;
        const days = Math.max(1, Math.ceil(hours / 8.0));
        updates.duration_days = days;
        updates.start_date = subtractWorkingDays(prev.end_date || new Date(), days, prev.excluded_dates);
      } else if (newMode === 'start_days') {
        const days = Math.max(1, Number(prev.duration_days) || 1);
        updates.duration_days = days;
        updates.end_date = addWorkingDays(prev.start_date || new Date(), days, prev.excluded_dates);
        updates.planned_hours = days * 8.0;
      } else if (newMode === 'end_days') {
        const days = Math.max(1, Number(prev.duration_days) || 1);
        updates.duration_days = days;
        updates.start_date = subtractWorkingDays(prev.end_date || new Date(), days, prev.excluded_dates);
        updates.planned_hours = days * 8.0;
      } else if (newMode === 'start_days_hours') {
        const days = Math.max(1, Number(prev.duration_days) || 1);
        updates.duration_days = days;
        updates.end_date = addWorkingDays(prev.start_date || new Date(), days, prev.excluded_dates);
      } else if (newMode === 'end_days_hours') {
        const days = Math.max(1, Number(prev.duration_days) || 1);
        updates.duration_days = days;
        updates.start_date = subtractWorkingDays(prev.end_date || new Date(), days, prev.excluded_dates);
      } else if (newMode === 'custom_dates') {
        const cDates = prev.custom_dates && prev.custom_dates.length > 0
          ? prev.custom_dates
          : [{ date: prev.start_date || new Date().toISOString().split('T')[0], hours: 8 }];
        const sorted = [...cDates].sort((a, b) => a.date.localeCompare(b.date));
        updates.custom_dates = sorted;
        updates.start_date = sorted[0].date;
        updates.end_date = sorted[sorted.length - 1].date;
        updates.duration_days = sorted.length;
        updates.planned_hours = sorted.reduce((sum, item) => sum + (Number(item.hours) || 8), 0);
      }
      return { ...prev, ...updates };
    });
  }

  function handleCustomDatesChange(newDates) {
    setTaskForm(prev => {
      const sorted = [...newDates].sort((a, b) => a.date.localeCompare(b.date));
      let s = prev.start_date;
      let e = prev.end_date;
      let dur = prev.duration_days;
      let hrs = prev.planned_hours;

      if (sorted.length > 0) {
        s = sorted[0].date;
        e = sorted[sorted.length - 1].date;
        dur = sorted.length;
        hrs = sorted.reduce((sum, item) => sum + (Number(item.hours) || 8), 0);
      }
      return {
        ...prev,
        custom_dates: sorted,
        start_date: s,
        end_date: e,
        duration_days: dur,
        planned_hours: hrs,
      };
    });
  }


  function handleStartDateChange(newStart) {
    setTaskForm(prev => {
      const updates = { start_date: newStart };
      if (budgetMode === 'start_end') {
        const days = countWorkingDays(newStart, prev.end_date, prev.excluded_dates);
        if (new Date(newStart) > new Date(prev.end_date)) {
          updates.end_date = newStart;
          updates.duration_days = 1;
          updates.planned_hours = 8.0;
        } else {
          updates.duration_days = days;
          updates.planned_hours = days * 8.0;
        }
      } else if (budgetMode === 'start_hours' || budgetMode === 'start_days' || budgetMode === 'start_days_hours') {
        const days = Math.max(1, Number(prev.duration_days) || 1);
        updates.end_date = addWorkingDays(newStart, days, prev.excluded_dates);
      }
      return { ...prev, ...updates };
    });
  }

  function handleEndDateChange(newEnd) {
    setTaskForm(prev => {
      const updates = { end_date: newEnd };
      if (budgetMode === 'start_end') {
        const days = countWorkingDays(prev.start_date, newEnd, prev.excluded_dates);
        if (new Date(newEnd) < new Date(prev.start_date)) {
          updates.start_date = newEnd;
          updates.duration_days = 1;
          updates.planned_hours = 8.0;
        } else {
          updates.duration_days = days;
          updates.planned_hours = days * 8.0;
        }
      } else if (budgetMode === 'end_hours' || budgetMode === 'end_days' || budgetMode === 'end_days_hours') {
        const days = Math.max(1, Number(prev.duration_days) || 1);
        updates.start_date = subtractWorkingDays(newEnd, days, prev.excluded_dates);
      }
      return { ...prev, ...updates };
    });
  }

  function handleDurationDaysChange(daysVal) {
    const days = Math.max(1, Number(daysVal) || 1);
    setTaskForm(prev => {
      const updates = { duration_days: daysVal };
      if (budgetMode === 'start_days') {
        updates.end_date = addWorkingDays(prev.start_date || new Date(), days, prev.excluded_dates);
        updates.planned_hours = days * 8.0;
      } else if (budgetMode === 'end_days' || budgetMode === 'end_days_hours') {
        updates.start_date = subtractWorkingDays(prev.end_date || new Date(), days, prev.excluded_dates);
        if (budgetMode === 'end_days') {
          updates.planned_hours = days * 8.0;
        }
      } else if (budgetMode === 'start_days_hours') {
        updates.end_date = addWorkingDays(prev.start_date || new Date(), days, prev.excluded_dates);
      }
      return { ...prev, ...updates };
    });
  }

  function handlePlannedHoursChange(hoursVal) {
    const hours = Number(hoursVal) || 0;
    setTaskForm(prev => {
      const updates = { planned_hours: hoursVal };
      if (budgetMode === 'start_hours') {
        const days = Math.max(1, Math.ceil(hours / 8.0));
        updates.duration_days = days;
        updates.end_date = addWorkingDays(prev.start_date || new Date(), days, prev.excluded_dates);
      } else if (budgetMode === 'end_hours') {
        const days = Math.max(1, Math.ceil(hours / 8.0));
        updates.duration_days = days;
        updates.start_date = subtractWorkingDays(prev.end_date || new Date(), days, prev.excluded_dates);
      }
      return { ...prev, ...updates };
    });
  }

  function applyDurationPreset(days, hours) {
    const sDate = taskForm.start_date || new Date().toISOString().split('T')[0];
    const newEnd = addWorkingDays(sDate, days, taskForm.excluded_dates);
    setTaskForm({
      ...taskForm,
      duration_days: days,
      planned_hours: hours,
      end_date: newEnd,
    });
  }

  async function handleSaveTaskForm(e) {
    e.preventDefault();
    const taskName = taskForm.faseSel === '__custom__' ? taskForm.customText : taskForm.faseSel;
    if (!taskName.trim()) {
      toast.error('Inserire il nome della fase');
      return;
    }
    const isMilestone = taskForm.taskType === 'milestone';
    const sDate = taskForm.start_date;
    const eDate = taskForm.end_date;
    const diffDays = countWorkingDays(sDate, eDate, taskForm.excluded_dates);
    const finalDays = Math.max(1, Number(taskForm.duration_days) || diffDays);
    const plannedHours = isMilestone ? 0 : (Number(taskForm.planned_hours) || (finalDays * 8.0));

    if (!isMilestone && taskForm.workers && taskForm.workers.length > 0) {
      const sumWorkerHours = taskForm.workers.reduce((sum, w) => sum + (Number(taskForm.worker_hours?.[w]) || 0), 0);
      const roundedSum = Math.round(sumWorkerHours * 10) / 10;
      const roundedPlanned = Math.round(plannedHours * 10) / 10;
      if (roundedSum > roundedPlanned) {
        toast.error(`Le ore assegnate agli addetti (${roundedSum}h) superano il budget totale della fase (${roundedPlanned}h).`);
        return;
      }
    }

    if (project && project.end_date) {
      if (taskForm.end_date && taskForm.end_date > project.end_date) {
        toast.error(`La data di fine fase non può superare la data di fine commessa (${formatDateItalian(project.end_date)})`);
        return;
      }
      if (taskForm.start_date && taskForm.start_date > project.end_date) {
        toast.error(`La data di inizio fase non può superare la data di fine commessa (${formatDateItalian(project.end_date)})`);
        return;
      }
    }

    let finalWorkerHours = taskForm.worker_hours;
    if (taskForm.workers && taskForm.workers.length === 1 && !isMilestone) {
      finalWorkerHours = { [taskForm.workers[0]]: plannedHours };
    }

    const isCustomDates = (taskForm.budgetMode || budgetMode) === 'custom_dates';
    const customDatesPayload = isCustomDates ? (taskForm.custom_dates || []) : [];

    const payload = {
      text: taskName.trim(),
      start_date: taskForm.start_date,
      end_date: isMilestone ? taskForm.start_date : taskForm.end_date,
      duration: isMilestone ? 0 : finalDays,
      planned_hours: plannedHours,
      workers: taskForm.workers,
      worker_hours: finalWorkerHours,
      type: isMilestone ? 'milestone' : 'task',
      color: taskForm.color || (isMilestone ? '#f59e0b' : null),
      department: taskForm.department || null,
      budget_mode: taskForm.budgetMode || budgetMode || 'start_days',
      custom_dates: customDatesPayload,
      completed: isMilestone ? 0 : (taskForm.completed !== undefined && taskForm.completed !== null ? Number(taskForm.completed) : 0),
      excluded_dates: taskForm.excluded_dates || [],
    };


    try {
      if (editingTask) {
        const res = await api.put(`/projects/${id}/tasks/${editingTask.id}`, payload);
        toast.success('Fase modificata con successo!');
        if (res.data && ganttData && Array.isArray(ganttData.tasks)) {
          const updatedTasks = ganttData.tasks.map(t => String(t.id) === String(editingTask.id) ? res.data : t);
          setGanttData({ ...ganttData, tasks: updatedTasks });
        }
      } else {
        const res = await api.post(`/projects/${id}/tasks`, payload);
        toast.success('Nuova fase aggiunta!');
        if (res.data && ganttData && Array.isArray(ganttData.tasks)) {
          setGanttData({ ...ganttData, tasks: [...ganttData.tasks, res.data] });
        }
      }

      // ----------------------------------------------------
      // Controllo Sovraccarico Post-Salvataggio (sempre eseguito)
      // ----------------------------------------------------
      if (!isMilestone && taskForm.workers && taskForm.workers.length > 0) {
        try {
          await new Promise(r => setTimeout(r, 400)); // Attendiamo il commit su DB

          const workloadRes = await api.get(`/workload/heatmap?_t=${Date.now()}`);
          const heatmap = workloadRes.data.heatmap || {};
          let overloadedWorkers = new Map();

          const assignedWorkerIds = [];
          Object.keys(heatmap).forEach(uid => {
            const h = heatmap[uid];
            // Match case-insensitive
            const isMatch = taskForm.workers.some(w => {
              const workerLower = (w || '').toLowerCase().trim();
              const hUser = (h.username || '').toLowerCase().trim();
              const hFull = (h.full_name || '').toLowerCase().trim();
              return (hUser && hUser.includes(workerLower)) || (hFull && hFull.includes(workerLower));
            });

            if (isMatch) {
              assignedWorkerIds.push({ uid, name: h.username || h.full_name });
            }
          });

          for (const w of assignedWorkerIds) {
            const wData = heatmap[w.uid];
            if (!wData || !wData.workload) continue;

            let curDate = new Date(taskForm.start_date + 'T12:00:00');
            const endDate = new Date(taskForm.end_date + 'T12:00:00');

            while (curDate <= endDate) {
              const dd = String(curDate.getDate()).padStart(2, '0');
              const mm = String(curDate.getMonth() + 1).padStart(2, '0');
              const yyyy = curDate.getFullYear();
              const dStr = `${yyyy}-${mm}-${dd}`;

              const h = wData.workload[dStr] ? wData.workload[dStr].hours : 0;

              if (h > 8.01) {
                if (!overloadedWorkers.has(w.name)) {
                  overloadedWorkers.set(w.name, []);
                }
                overloadedWorkers.get(w.name).push(`${dd}/${mm}`);
              }
              curDate.setDate(curDate.getDate() + 1);
            }
          }

          if (overloadedWorkers.size > 0) {
            overloadedWorkers.forEach((dates, workerName) => {
              toast.warning(`Attenzione: l'addetto ${workerName} è andato in sovraccarico (più di 8h/giorno) nei giorni: ${dates.join(', ')}!`);
            });
          }
        } catch (err) {
          console.error("Errore controllo sovraccarico post-salvataggio:", err);
          toast.error("Errore nel controllo del sovraccarico: " + err.message);
        }
      }

      // Se l'utente ha inserito una fase personalizzata o nuova, aggiungiamola automaticamente alle fasi suggerite per quel reparto
      if (taskForm.faseSel === '__custom__' && taskName.trim()) {
        try {
          const targetDept = taskForm.department || (user?.role === 'admin' ? 'condivisa' : (user?.department || 'ufficio_tecnico'));
          await api.post('/phase-templates', {
            name: taskName.trim(),
            department: targetDept,
            default_color: taskForm.color || '#3b82f6',
            is_custom: true,
          });
        } catch (e) {
          console.error('Errore auto-salvataggio template:', e);
        }
      }

      setShowTaskModal(false);
      loadProject();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Errore nel salvataggio della fase');
    }
  }

  // Modale Consuntivo Ore
  function openOreModalForTask(task) {
    openEditTaskModal(task, 'consuntivo');
  }

  function prepareOreDataForTask(task, forceReset = false) {
    if (!task) return;
    setSelectedTaskForHours(task);

    // Se stiamo già lavorando su questo task e abbiamo ore in memoria, non sovrascrivere se non forzato
    if (!forceReset && selectedTaskForHours && String(selectedTaskForHours.id) === String(task.id) && Object.keys(actualHoursMap).length > 0) {
      return;
    }

    const initialMap = task.actual_hours && typeof task.actual_hours === 'object'
      ? JSON.parse(JSON.stringify(task.actual_hours))
      : {};
    // Ensure extra_hours key exists
    if (!initialMap['__extra__']) {
      initialMap['__extra__'] = {};
    }
    setActualHoursMap(initialMap);

    const plannedDates = getAssignedDatesForTask(task);
    const plannedSet = new Set(plannedDates);
    const existingExtraDates = [];

    Object.values(initialMap).forEach(workerMap => {
      if (workerMap && typeof workerMap === 'object') {
        Object.keys(workerMap).forEach(dKey => {
          if (dKey !== '__extra__' && !plannedSet.has(dKey) && /^\d{4}-\d{2}-\d{2}$/.test(dKey)) {
            if (!existingExtraDates.includes(dKey)) {
              existingExtraDates.push(dKey);
            }
          }
        });
      }
    });

    existingExtraDates.sort();
    setModalExtraDates(existingExtraDates);
  }

  function handleSpecificDateChange(dateStr) {
    if (!dateStr || !selectedTaskForHours) return;

    // Evita doppi eventi generati in rapida successione dal datepicker del browser
    if (lastAddedDateRef.current.date === dateStr && (Date.now() - lastAddedDateRef.current.time < 1500)) {
      setSpecificExtraDate('');
      return;
    }

    if (project && project.end_date && dateStr > project.end_date) {
      toast.error(`Non è possibile aggiungere giorni oltre la fine della commessa (${formatDateItalian(project.end_date)}).`);
      setSpecificExtraDate('');
      return;
    }
    const plannedDates = getAssignedDatesForTask(selectedTaskForHours);
    const allCurrentDates = Array.from(new Set([...plannedDates, ...modalExtraDates]));
    if (allCurrentDates.includes(dateStr)) {
      toast.error('La data selezionata è già presente nella tabella.');
      setSpecificExtraDate('');
      return;
    }
    lastAddedDateRef.current = { date: dateStr, time: Date.now() };
    setModalExtraDates(prev => {
      if (prev.includes(dateStr)) return prev;
      return [...prev, dateStr].sort();
    });
    toast.success(`Aggiunta colonna: ${dateStr.split('-').reverse().join('/')}`);
    setSpecificExtraDate('');
  }

  function handleAddExtraDayToModal() {
    if (!selectedTaskForHours) return;
    // Aggiunge sempre il prossimo giorno lavorativo dopo l'ultimo presente
    const plannedDates = getAssignedDatesForTask(selectedTaskForHours);
    const allCurrentDates = Array.from(new Set([...plannedDates, ...modalExtraDates])).sort();
    let baseDateStr = allCurrentDates.length > 0
      ? allCurrentDates[allCurrentDates.length - 1]
      : (selectedTaskForHours.end_date ? selectedTaskForHours.end_date.split(' ')[0] : new Date().toISOString().split('T')[0]);

    const baseDate = new Date(baseDateStr + 'T00:00:00');
    baseDate.setDate(baseDate.getDate() + 1);
    const y = baseDate.getFullYear();
    const m = String(baseDate.getMonth() + 1).padStart(2, '0');
    const d = String(baseDate.getDate()).padStart(2, '0');
    const nextWorkDateStr = addWorkingDays(`${y}-${m}-${d}`, 1);

    if (nextWorkDateStr && !allCurrentDates.includes(nextWorkDateStr)) {
      if (project && project.end_date && nextWorkDateStr > project.end_date) {
        toast.error(`Non è possibile aggiungere giorni oltre la fine della commessa (${formatDateItalian(project.end_date)}).`);
        return;
      }
      setModalExtraDates(prev => [...prev, nextWorkDateStr].sort());
      toast.success(`Aggiunta colonna giorno extra: ${nextWorkDateStr.split('-').reverse().join('/')}`);
    }
  }

  function handleRemoveLastExtraDay() {
    if (modalExtraDates.length === 0) {
      toast.error("Nessun giorno extra presente da rimuovere!");
      return;
    }
    const lastDate = modalExtraDates[modalExtraDates.length - 1];
    setModalExtraDates(prev => prev.slice(0, -1));
    toast.success(`Rimosso giorno: ${lastDate.split('-').reverse().join('/')}`);
  }

  async function handleSaveOreModal() {
    if (!selectedTaskForHours) return;
    try {
      await api.put(`/projects/${id}/tasks/${selectedTaskForHours.id}`, {
        actual_hours: actualHoursMap,
      });
      toast.success('Ore consuntivate salvate!');
      setShowOreModal(false);
      setShowTaskModal(false);
      loadProject();
    } catch (err) {
      console.error("Errore salvataggio ore:", err);
      const msg = err?.response?.data?.detail || "Errore durante il salvataggio ore";
      toast.error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
  }

  function openEditProjectModal() {
    if (!project) return;
    setProjectForm({
      name: project.name || '',
      code: project.code || '',
      client: project.client || '',
      description: project.description || '',
      color: project.color || '#185FA5',
      start_date: project.start_date || '',
      end_date: project.end_date || '',
      status: project.status || 'planning',
      responsible_id: project.responsible_id || '',
      assigned_workers: Array.isArray(project.assigned_workers) ? [...project.assigned_workers] : [],
      is_atex: Boolean(project.is_atex),
      is_alimentare: Boolean(project.is_alimentare),
    });
    setShowEditProjectModal(true);
  }

  function toggleProjectWorkerSelection(username) {
    const current = projectForm.assigned_workers || [];
    const updated = current.includes(username) ? current.filter(w => w !== username) : [...current, username];
    setProjectForm({ ...projectForm, assigned_workers: updated });
  }

  async function handleSaveProject(e) {
    e.preventDefault();
    if (!projectForm.code?.trim() || !projectForm.client?.trim() || !projectForm.name?.trim()) {
      toast.error('Codice, Cliente e Titolo Commessa sono campi obbligatori');
      return;
    }
    try {
      const payload = {
        ...projectForm,
        code: projectForm.code.trim(),
        client: projectForm.client.trim(),
        name: projectForm.name.trim(),
        is_atex: Boolean(projectForm.is_atex),
        is_alimentare: Boolean(projectForm.is_alimentare),
      };
      const { data } = await api.put(`/projects/${id}`, payload);
      setProject(prev => ({ ...prev, ...data }));
      setShowEditProjectModal(false);
      toast.success('Dati commessa aggiornati con successo!');
      loadProject();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Errore durante la modifica della commessa');
    }
  }

  function toggleWorkerSelection(w, requireConfirm = false) {
    const isSelected = taskForm.workers.includes(w);
    if (isSelected && requireConfirm && !window.confirm(`Confermi la rimozione dell'addetto "${w}" da questa fase?`)) return;

    let newWorkers;
    if (isSelected) {
      newWorkers = [];
    } else {
      newWorkers = [w];
    }

    const totalHours = Number(taskForm.planned_hours) || (Number(taskForm.duration_days) * 8.0) || 8.0;
    let newWorkerHours = {};
    if (newWorkers.length > 0) {
      newWorkerHours[w] = totalHours;
    }

    setTaskForm({
      ...taskForm,
      workers: newWorkers,
      worker_hours: newWorkerHours,
      excluded_dates: [] // Reset excluded dates when worker changes
    });
  }

  function handleZoom(mode) {
    setViewMode(mode);
    const mesiItaliani = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
    const giorniItaliani = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
    const dayCssFunc = function (date) {
      if (isWeekendOrHoliday(date)) return "gantt_weekend_scale_cell";
      return "";
    };

    switch (mode) {
      case 'day':
        gantt.config.scales = [
          { unit: "month", step: 1, format: function (date) { return `${mesiItaliani[date.getMonth()]} ${date.getFullYear()}`; } },
          { unit: "day", step: 1, css: dayCssFunc, format: function (date) { return giorniItaliani[date.getDay()]; } },
          { unit: "day", step: 1, css: dayCssFunc, format: "%d" },
        ];
        gantt.config.min_column_width = 38;
        gantt.config.scale_height = 66;
        break;
      case 'week':
        gantt.config.scales = [
          { unit: "month", step: 1, format: function (date) { return `${mesiItaliani[date.getMonth()]} ${date.getFullYear()}`; } },
          {
            unit: "week",
            step: 1,
            format: function (date) {
              const weekNum = gantt.date.date_to_str("%W")(date);
              const endDate = gantt.date.add(date, 6, "day");
              return `<div style="line-height: 1.2; padding-top: 4px;">Sett. ${weekNum}<br/><span style="font-size: 11px; font-weight: normal; color: var(--text-secondary);">${date.getDate()} - ${endDate.getDate()} ${mesiItaliani[endDate.getMonth()].substring(0, 3).toLowerCase()}</span></div>`;
            }
          },
        ];
        gantt.config.min_column_width = 80;
        gantt.config.scale_height = 66;
        break;
      case 'month':
        gantt.config.scales = [
          { unit: "year", step: 1, format: "%Y" },
          { unit: "month", step: 1, format: function (date) { return mesiItaliani[date.getMonth()]; } },
        ];
        gantt.config.min_column_width = 60;
        gantt.config.scale_height = 50;
        break;
      case 'quarter':
        gantt.config.scales = [
          { unit: "year", step: 1, format: "%Y" },
          {
            unit: "quarter",
            step: 1,
            format: function (date) {
              const q = Math.floor(date.getMonth() / 3) + 1;
              return "Q" + q;
            }
          },
        ];
        gantt.config.min_column_width = 100;
        gantt.config.scale_height = 50;
        break;
    }
    gantt.render();
  }

  function handleChatGPTAnalysis() {
    const isAtex = Boolean(project.is_atex);
    const isAlimentare = Boolean(project.is_alimentare);
    const tipologia = (isAtex && isAlimentare) ? 'ATEX + Alimentare' : isAtex ? 'ATEX' : isAlimentare ? 'Alimentare' : 'Standard';

    let tipologiaNote = '';
    if (isAtex && isAlimentare) {
      tipologiaNote = ' (Vincoli normativi: Direttiva ATEX 2014/34/UE e idoneità alimentare MOCA/HACCP)';
    } else if (isAtex) {
      tipologiaNote = ' (Vincoli normativi: Direttiva ATEX 2014/34/UE e collaudi antideflagranti)';
    } else if (isAlimentare) {
      tipologiaNote = ' (Vincoli normativi: idoneità al contatto alimentare MOCA e standard igienico-sanitari HACCP)';
    }

    const promptLines = [
      "Comportati da Project Manager esperto e analizza i dati di questa commessa riportati di seguito (e nell'eventuale file allegato).",
      "",
      `COMMESSA: ${project.name} (Codice: ${project.code || 'N/A'})`,
      `Tipologia: ${tipologia}${tipologiaNote}`,
      `Cliente: ${project.client || 'N/A'}`,
      `Descrizione: ${project.description || 'Nessuna descrizione'}`,
      `Inizio: ${project.start_date ? new Date(project.start_date).toLocaleDateString() : 'N/A'}`,
      `Fine: ${project.end_date ? new Date(project.end_date).toLocaleDateString() : 'N/A'}`,
      `Stato: ${project.status || 'N/A'}`,
      "",
      "FASI DELLA COMMESSA:"
    ];

    const sortedTasks = [...(ganttData?.tasks || [])].sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
    sortedTasks.forEach(t => {
      const dept = t.department ? t.department.toUpperCase() : 'N/A';
      const taskName = t.text || 'Fase senza nome';
      const startDate = new Date(t.start_date).toLocaleDateString();
      const endDate = new Date(t.end_date).toLocaleDateString();
      let progressStr = `${Math.round((t.progress || 0) * 100)}% completata`;
      if (isTaskCompleted(t)) {
        progressStr = 'Completata (100%)';
      } else if (Number(t.completed) === -1) {
        progressStr = 'Sospesa';
      }

      const workers = Array.isArray(t.workers) ? t.workers : [];

      promptLines.push(`- [${dept}] ${taskName}`);
      promptLines.push(`  Date: dal ${startDate} al ${endDate} (${t.duration || 0} giorni) | Stato: ${progressStr}`);

      if (workers.length > 0) {
        promptLines.push(`  Addetti:`);
        workers.forEach(w => {
          const wAssigned = (t.worker_hours && t.worker_hours[w] !== undefined && t.worker_hours[w] !== '')
            ? Number(t.worker_hours[w])
            : (Number(t.planned_hours || 8) / workers.length);

          let wActual = 0;
          if (t.actual_hours && t.actual_hours[w] && typeof t.actual_hours[w] === 'object') {
            Object.values(t.actual_hours[w]).forEach(h => {
              wActual += Number(h) || 0;
            });
          }
          promptLines.push(`    - ${w}: ${wActual}h fatte / ${Number(wAssigned.toFixed(1))}h assegnate`);
        });
      } else {
        promptLines.push(`  Addetti: Nessuno`);
      }

      const totOreReg = calculateTaskEffHours(t);
      promptLines.push(`  Totale Fase: ${totOreReg}h fatte su ${t.planned_hours || 0}h previste`);
    });

    const fullPrompt = promptLines.join('\n');
    window.open('https://chatgpt.com/?q=' + encodeURIComponent(fullPrompt), '_blank');
  }

  async function handleExport(type) {
    const selectedSections = Object.entries(exportSections)
      .filter(([_, v]) => v)
      .map(([k]) => k)
      .join(',');
    if (!selectedSections) {
      toast.error('Seleziona almeno una sezione da esportare');
      return;
    }
    try {
      const response = await api.get(`/projects/${id}/export/${type}`, {
        responseType: 'blob',
        params: { sections: selectedSections }
      });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.code || project.name}.${type === 'excel' ? 'xlsx' : 'pdf'}`;
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success(`Export ${type.toUpperCase()} completato (${selectedSections.replace(/,/g, ', ')})!`);
      setShowExportMenu(false);
    } catch {
      toast.error(`Errore export ${type}`);
    }
  }

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;

  const handleSort = (key) => {
    let direction = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  let sortedTasks = [...(ganttData.tasks || [])];
  if (sortConfig.key !== null) {
    sortedTasks.sort((a, b) => {
      let aValue, bValue;
      switch (sortConfig.key) {
        case 'fase':
          aValue = a.text || '';
          bValue = b.text || '';
          break;
        case 'reparto':
          aValue = a.department || '';
          bValue = b.department || '';
          break;
        case 'addetti':
          aValue = (a.workers || []).join(', ');
          bValue = (b.workers || []).join(', ');
          break;
        case 'date':
          aValue = new Date(a.start_date).getTime() || 0;
          bValue = new Date(b.start_date).getTime() || 0;
          break;
        case 'ore':
          aValue = Number(a.planned_hours) || 0;
          bValue = Number(b.planned_hours) || 0;
          break;
        case 'semaforo':
          const weight = { 'ritardo': 3, 'attenzione': 2, 'ok': 1 };
          aValue = weight[computeStato(a)] || 0;
          bValue = weight[computeStato(b)] || 0;
          break;
        default:
          return 0;
      }
      if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }

  return (
    <div className="project-detail animate-fadeIn">
      <div className="project-detail-header">
        <div className="project-detail-info">
          <button className="btn btn-secondary btn-icon" onClick={() => navigate('/projects')} title="Torna alle commesse" aria-label="Torna alle commesse">
            <AppIcon name="arrowLeft" />
          </button>
          <div className="commessa-meta" style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '12px 24px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderLeft: `6px solid ${project?.color || '#185FA5'}`,
            borderRadius: '12px',
            fontSize: '1.15rem',
            boxShadow: 'var(--shadow-sm)'
          }}>
            <span className="commessa-code" style={{ color: 'var(--text-primary)', fontWeight: 800, fontSize: '1.25rem' }}>{project?.code || 'UT-COMM'}</span>
            {project?.is_atex && (
              <span className="badge badge-atex" title="Conforme Direttiva ATEX">
                ATEX
              </span>
            )}
            {project?.is_alimentare && (
              <span className="badge badge-alimentare" title="Conforme Settore Alimentare / Food Grade">
                Alimentare
              </span>
            )}
            {!project?.is_atex && !project?.is_alimentare && (
              <span className="badge badge-standard">
                Standard
              </span>
            )}
            {project?.client && (
              <>
                <span style={{ color: 'var(--border-subtle)', fontSize: '1.2rem' }}>—</span>
                <span className="commessa-client" style={{ color: 'var(--text-secondary)' }}><AppIcon name="building" size={15} />{project.client}</span>
              </>
            )}
            {project?.responsible_name && (
              <>
                <span style={{ color: 'var(--border-subtle)', fontSize: '1.2rem' }}>—</span>
                <span className="commessa-client commessa-responsible" style={{ color: 'var(--text-secondary)' }}><AppIcon name="user" size={15} />{project.responsible_name}</span>
              </>
            )}
            {project?.name && (
              <>
                <span style={{ color: 'var(--border-subtle)', fontSize: '1.2rem' }}>|</span>
                <span className="commessa-title-in-box" style={{ fontWeight: 800, color: 'var(--text-primary)', fontSize: '1.25rem' }}>{project.name}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 4 Tabs Interattive Ufficio Tecnico */}
      <div className="ut-tabs" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        {canManageProject && (
          <button className="btn btn-primary" onClick={openNewTaskModal} style={{ padding: '9px 14px', fontSize: '0.85 rem' }}>
            <AppIcon name="plus" />
            Nuova fase
          </button>
        )}
        <button
          className={`ut-tab-btn ${activeTab === 'gantt' ? 'active' : ''}`}
          onClick={() => setActiveTab('gantt')}
        >
          <AppIcon name="gantt" />
          Gantt
        </button>
        <button
          className={`ut-tab-btn ${activeTab === 'commessa' ? 'active' : ''}`}
          onClick={() => setActiveTab('commessa')}
        >
          <AppIcon name="list" />
          Fasi <span className="tab-badge">{ganttData.tasks.length}</span>
        </button>
        <button
          className={`ut-tab-btn ${activeTab === 'note' ? 'active' : ''}`}
          onClick={() => setActiveTab('note')}
          style={{
            borderColor: openTicketsCount > 0 && activeTab !== 'note' ? 'var(--warning)' : undefined,
            color: openTicketsCount > 0 && activeTab !== 'note' ? 'var(--warning)' : undefined,
            backgroundColor: openTicketsCount > 0 && activeTab !== 'note' ? 'rgba(245, 158, 11, 0.1)' : undefined
          }}
        >
          <AppIcon name="notes" />
          Note
        </button>
        {delaysList.length > 0 && (
          <button
            className={`ut-tab-btn ${activeTab === 'alert' ? 'active' : ''}`}
            onClick={() => setActiveTab('alert')}
          >
            <AppIcon name="alert" />
            Ritardi
            <span className="tab-badge tab-badge-danger">{delaysList.length}</span>
          </button>
        )}

        <button
          className={`ut-tab-btn ${activeTab === 'ai_analysis' ? 'active' : ''}`}
          onClick={() => setActiveTab('ai_analysis')}
          title="Analisi intelligente HiPlan AI e riprogrammazione"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6
          }}
        >
          <Sparkles size={16} />
          Analisi AI
        </button>

        {user?.role === 'admin' && (
          <button
            className={`ut-tab-btn ${activeTab === 'activity_log' ? 'active' : ''}`}
            onClick={() => setActiveTab('activity_log')}
            title="Visualizza la cronologia delle modifiche e delle ore"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <AppIcon name="clock" />
            Cronologia
          </button>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {canManageProject && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={openEditProjectModal}
              title="Modifica commessa e cambia stato"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 38,
                height: 38,
                padding: 0,
                fontSize: '1.2rem',
                borderRadius: '10px'
              }}
            >
              <AppIcon name="edit" />
            </button>
          )}

          <div style={{ position: 'relative' }}>
            <button
              className="btn btn-primary"
              onClick={() => setShowExportMenu(!showExportMenu)}
              title="Esporta commessa"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 38, height: 38, padding: 0, fontSize: '1.3rem', borderRadius: '10px' }}
            >
              <AppIcon name="download" />
            </button>
            {showExportMenu && (
              <div className="action-popover" style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 6,
                background: 'var(--bg-card)', border: '1px solid var(--border-default)',
                borderRadius: 10, padding: 16, zIndex: 300, minWidth: 280,
                boxShadow: '0 8px 32px rgba(0,0,0,0.2)', textAlign: 'left'
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Sezioni da esportare:
                </div>
                {[
                  { id: 'tasks', icon: 'list', label: 'Fasi', desc: 'Tabella fasi, date, addetti, budget ore' },
                  { id: 'hours', icon: 'clock', label: 'Consuntivazione Ore', desc: 'Ore previste vs effettive, saldo' },
                  { id: 'gantt', icon: 'gantt', label: 'Diagramma Gantt', desc: 'Timeline visiva delle fasi' },
                ].map(sec => (
                  <label key={sec.id} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                    padding: '8px 0', cursor: 'pointer', fontSize: 13,
                    color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)'
                  }}>
                    <input
                      type="checkbox"
                      checked={exportSections[sec.id]}
                      onChange={(e) => setExportSections(prev => ({ ...prev, [sec.id]: e.target.checked }))}
                      style={{ marginTop: 2, cursor: 'pointer' }}
                    />
                    <div>
                      <div className="inline-detail-row" style={{ fontWeight: 600 }}><AppIcon name={sec.icon} size={14} />{sec.label}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{sec.desc}</div>
                    </div>
                  </label>
                ))}

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
                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: '#10a37f', color: '#fff', borderColor: '#10a37f', marginBottom: 8 }}
                    onClick={() => { setShowExportMenu(false); handleChatGPTAnalysis(); }}
                  >
                    <img src="/chatgpt-logo.png" style={{ width: 16, height: 16, filter: 'brightness(0) invert(1)' }} alt="ChatGPT" />
                    Analizza con ChatGPT
                  </button>

                  <button
                    className="btn btn-secondary"
                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'var(--accent-600)', color: '#fff', borderColor: 'var(--accent-600)' }}
                    onClick={() => {
                      const isAtex = Boolean(project.is_atex);
                      const isAlim = Boolean(project.is_alimentare);
                      const tipologia = (isAtex && isAlim) ? 'ATEX + Alimentare' : isAtex ? 'ATEX' : isAlim ? 'Alimentare' : 'Standard';

                      let tipologiaContext = `Tipologia: ${tipologia}`;
                      if (isAtex && isAlim) {
                        tipologiaContext += ' (Vincoli normativi: Direttiva ATEX 2014/34/UE e conformità idoneità alimentare MOCA/HACCP)';
                      } else if (isAtex) {
                        tipologiaContext += ' (Vincoli normativi: Direttiva ATEX 2014/34/UE e collaudi antideflagranti)';
                      } else if (isAlim) {
                        tipologiaContext += ' (Vincoli normativi: idoneità al contatto alimentare MOCA e standard igienico-sanitari HACCP)';
                      }

                      setShowExportMenu(false);
                      navigate('/chat', {
                        state: {
                          initialPrompt: `Analizza questa commessa: ${project.name} (Codice: ${project.code || 'N/A'})\n${tipologiaContext}\nCliente: ${project.client || 'N/A'}\nData inizio: ${project.start_date || 'N/A'}\nData fine: ${project.end_date || 'N/A'}\nStatus: ${project.status || 'N/A'}\nPuoi fornirmi un'analisi operativa approfondita con stato di avanzamento reale, rispetto delle scadenze, carichi degli addetti e verifiche di conformità per la tipologia ${tipologia}?`
                        }
                      });
                    }}
                  >
                    <AppIcon name="robot" size={16} />
                    Analizza con HiPlan AI
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
                    disabled={!Object.values(exportSections).some(v => v)}
                  >
                    Export {exportFormat.toUpperCase()}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* TOOLBAR DI AZIONE POSIZIONATA SOTTO ALLE TABS */}
      {activeTab === 'gantt' && <div className="project-toolbar">
        <div className="toolbar-left" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>


          {activeTab === 'gantt' && (
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px' }}
                onClick={handleResetGanttFiltersAndSort}
                title="Reimposta tutti i filtri e l'ordinamento ai valori predefiniti"
              >
                <AppIcon name="undo" size={14} />
                Reimposta
              </button>
            </div>
          )}

          {activeTab === 'gantt' && (
            <div style={{ position: 'relative' }}>
              <button
                className="btn btn-secondary"
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px' }}
                onClick={() => {
                  setShowColumnsMenu(!showColumnsMenu);
                  setShowPhaseFilterMenu(false); setShowWorkerMenu(false); setShowDeptMenu(false);
                }}
              >
                <AppIcon name="columns" />
                Colonne
                {(visibleColumns.length !== 1 || visibleColumns[0] !== 'workers') && (
                  <span style={{ background: '#6366f1', color: '#fff', borderRadius: 10, fontSize: '0.65rem', fontWeight: 700, padding: '1px 6px' }}>
                    {visibleColumns.length}
                  </span>
                )}
              </button>

              {showColumnsMenu && (
                <div className="action-popover" style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: 4, background: 'var(--bg-card)', border: '1px solid var(--border-default)',
                  borderRadius: 10, padding: 12, zIndex: 200, minWidth: 200, boxShadow: 'var(--shadow-md)'
                }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>MOSTRA/NASCONDI:</div>
                  <div style={{ maxHeight: '280px', overflowY: 'auto' }}>
                    {GANTT_ALL_COLUMNS.map(col => (
                      <label key={col.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)' }}>
                        <input
                          type="checkbox"
                          checked={visibleColumns.includes(col.id)}
                          onChange={(e) => {
                            const newCols = e.target.checked
                              ? [...visibleColumns, col.id]
                              : visibleColumns.filter(c => c !== col.id);
                            setVisibleColumns(newCols);
                          }}
                        />
                        {col.label}
                      </label>
                    ))}
                  </div>
                  <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 8, paddingTop: 8, display: 'flex', gap: 8 }}>
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => setVisibleColumns(GANTT_ALL_COLUMNS.map(c => c.id))} style={{ flex: 1, fontSize: 11 }}>Tutti</button>
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => setVisibleColumns([])} style={{ flex: 1, fontSize: 11 }}>Nessuno</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'gantt' && (
            <div style={{ position: 'relative' }}>
              <button
                className="btn btn-secondary"
                onClick={() => { setShowPhaseFilterMenu(!showPhaseFilterMenu); setShowColumnsMenu(false); setShowDeptMenu(false); setShowWorkerMenu(false); }}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px' }}
              >
                <AppIcon name="filter" />
                Tipo Fase
                {phaseTypes.length === 1 && (
                  <span style={{ background: '#6366f1', color: '#fff', borderRadius: 10, fontSize: '0.65rem', fontWeight: 700, padding: '1px 6px' }}>
                    1
                  </span>
                )}
              </button>
              {showPhaseFilterMenu && (
                <div className="action-popover" style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: 4,
                  background: 'var(--bg-card)', border: '1px solid var(--border-default)',
                  borderRadius: 10, padding: 12, zIndex: 200, minWidth: 200,
                  boxShadow: 'var(--shadow-md)'
                }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>MOSTRA TIPO FASE:</div>
                  <div>
                    {ALL_PHASE_TYPES.map(opt => (
                      <label key={opt.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)' }}>
                        <input
                          type="checkbox"
                          checked={phaseTypes.includes(opt.id)}
                          onChange={(e) => {
                            setPhaseTypes(e.target.checked
                              ? [...phaseTypes, opt.id]
                              : phaseTypes.filter(x => x !== opt.id)
                            );
                          }}
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                  <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 8, paddingTop: 8, display: 'flex', gap: 8 }}>
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => setPhaseTypes(['task', 'milestone'])} style={{ flex: 1, fontSize: 11 }}>Tutti</button>
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => setPhaseTypes([])} style={{ flex: 1, fontSize: 11 }}>Nessuno</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'gantt' && (
            <div style={{ position: 'relative' }}>
              <button
                className="btn btn-secondary"
                onClick={() => { setShowWorkerMenu(!showWorkerMenu); setShowColumnsMenu(false); setShowPhaseFilterMenu(false); setShowDeptMenu(false); }}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px' }}
              >
                <AppIcon name="users" />
                Addetto
                {activeWorkers.length > 0 && activeWorkers.length < predefinedWorkers.length && (
                  <span style={{ background: '#6366f1', color: '#fff', borderRadius: 10, fontSize: '0.65rem', fontWeight: 700, padding: '1px 6px' }}>
                    {activeWorkers.length}
                  </span>
                )}
              </button>
              {showWorkerMenu && (
                <div className="action-popover" style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: 4,
                  background: 'var(--bg-card)', border: '1px solid var(--border-default)',
                  borderRadius: 10, padding: 12, zIndex: 200, minWidth: 200,
                  boxShadow: 'var(--shadow-md)'
                }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>FILTRA PER ADDETTO:</div>
                  <div style={{ maxHeight: '280px', overflowY: 'auto' }}>
                    {[...predefinedWorkers].sort((a, b) => a === user?.username ? -1 : b === user?.username ? 1 : a.localeCompare(b)).map(w => (
                      <label key={w} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)' }}>
                        <input
                          type="checkbox"
                          checked={activeWorkers.includes(w)}
                          onChange={(e) => {
                            setActiveWorkers(e.target.checked
                              ? [...activeWorkers, w]
                              : activeWorkers.filter(x => x !== w)
                            );
                          }}
                        />
                        {w}
                      </label>
                    ))}
                  </div>
                  <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 8, paddingTop: 8, display: 'flex', gap: 8 }}>
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => setActiveWorkers([...predefinedWorkers])} style={{ flex: 1, fontSize: 11 }}>Tutti</button>
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => setActiveWorkers([])} style={{ flex: 1, fontSize: 11 }}>Nessuno</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'gantt' && (
            <div style={{ position: 'relative' }}>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setShowDeptMenu(!showDeptMenu);
                  setShowColumnsMenu(false); setShowPhaseFilterMenu(false); setShowWorkerMenu(false);
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px' }}
              >
                <AppIcon name="building" />
                Reparto
                {activeDepartments.length > 0 && activeDepartments.length < ALL_DEPTS.length && (
                  <span style={{ background: '#6366f1', color: '#fff', borderRadius: 10, fontSize: '0.65rem', fontWeight: 700, padding: '1px 6px' }}>
                    {activeDepartments.length}/{ALL_DEPTS.length}
                  </span>
                )}
              </button>
              {showDeptMenu && (
                <div className="action-popover" style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: 4,
                  background: 'var(--bg-card)', border: '1px solid var(--border-default)',
                  borderRadius: 10, padding: 12, zIndex: 200, minWidth: 200,
                  boxShadow: 'var(--shadow-md)'
                }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>FILTRA PER REPARTO:</div>
                  <div style={{ maxHeight: '280px', overflowY: 'auto' }}>
                    {departmentOptions.map(dept => (
                      <label key={dept.value} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)' }}>
                        <input
                          type="checkbox"
                          checked={activeDepartments.includes(dept.value)}
                          onChange={(e) => {
                            setActiveDepartments(e.target.checked
                              ? [...activeDepartments, dept.value]
                              : activeDepartments.filter(d => d !== dept.value)
                            );
                          }}
                        />
                        <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: dept.color, flexShrink: 0 }} />
                        {dept.label}
                      </label>
                    ))}
                  </div>
                  <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 8, paddingTop: 8, display: 'flex', gap: 8 }}>
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => setActiveDepartments(ALL_DEPTS)} style={{ flex: 1, fontSize: 11 }}>Tutti</button>
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => setActiveDepartments([])} style={{ flex: 1, fontSize: 11 }}>Nessuno</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="toolbar-right">
          {activeTab === 'gantt' && (
            <div className="zoom-controls">
              {['day', 'week', 'month', 'quarter'].map((z) => (
                <button
                  key={z}
                  className={`zoom-chip ${viewMode === z ? 'active' : ''}`}
                  onClick={() => handleZoom(z)}
                >
                  {z === 'day' ? 'Giorno' : z === 'week' ? 'Settimana' : z === 'month' ? 'Mese' : 'Trimestre'}
                </button>
              ))}
            </div>
          )}

        </div>
      </div>}

      {/* TAB 1: GANTT */}
      {activeTab === 'gantt' && (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, width: '100%', maxWidth: '100%' }}>
          <div className="gantt-wrapper">
            <GanttChart
              projectId={id}
              sortResetKey={ganttResetKey}
              tasks={ganttData.tasks.filter(t => {
                // Per addetto e reparto se non ci sono selezioni mostra tutto
                if (activeDepartments.length > 0 && t.department && !activeDepartments.includes(t.department)) return false;

                // Tipo fase (multiselezione): se vuoto o entrambe selezionate mostra tutto
                if (phaseTypes.length > 0 && phaseTypes.length < 2) {
                  const isMs = t.type === 'milestone';
                  if (isMs && !phaseTypes.includes('milestone')) return false;
                  if (!isMs && !phaseTypes.includes('task')) return false;
                }

                // Per addetto se non ci sono selezioni mostra tutto
                if (activeWorkers.length > 0) {
                  if (!t.workers || !t.workers.some(w => activeWorkers.includes(w))) return false;
                }
                return true;
              })}
              links={ganttData.links}
              visibleColumns={visibleColumns}
              readOnly={!canManageProject}
              projectStartDate={project?.start_date}
              projectEndDate={project?.end_date}
              onTaskUpdate={handleTaskUpdate}
              onTaskCreate={handleTaskCreate}
              onTaskDelete={handleTaskDelete}
              onLinkCreate={handleLinkCreate}
              onLinkDelete={handleLinkDelete}
              onEditTask={openEditTaskModal}
              onNewTask={() => openNewTaskModal()}
            />
          </div>
        </div>
      )}

      {/* TAB 2: SCHEDA & FASI */}
      {activeTab === 'commessa' && (
        <div className="animate-fadeIn">
          <div className="commessa-summary-card">
            <h3 style={{ margin: 0, color: 'var(--text-primary)' }}>Riepilogo Generale Commessa</h3>
            {project?.description && (
              <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginTop: 8 }}>{project.description}</p>
            )}
            <div className="commessa-stats-grid">
              <div className="stat-box">
                <div className="stat-box-label">Codice Commessa</div>
                <div className="stat-box-value" style={{ color: 'var(--accent-500)' }}>{project?.code || 'N/D'}</div>
              </div>
              <div className="stat-box">
                <div className="stat-box-label">Cliente</div>
                <div className="stat-box-value">{project?.client || 'N/D'}</div>
              </div>
              <div className="stat-box">
                <div className="stat-box-label">Data Avvio / Fine</div>
                <div className="stat-box-value" style={{ fontSize: '0.95rem' }}>
                  {project?.start_date ? formatDateItalian(project.start_date) : 'N/D'} → {project?.end_date ? formatDateItalian(project.end_date) : 'N/D'}
                </div>
              </div>
              <div className="stat-box">
                <div className="stat-box-label">Ore Previste Totali</div>
                <div className="stat-box-value">{totalPrev} h</div>
              </div>
              <div className="stat-box">
                <div className="stat-box-label">Ore Consuntivate Effettive</div>
                <div className="stat-box-value" style={{ color: totalEff >= totalPrev ? 'var(--success)' : 'var(--text-primary)' }}>
                  {totalEff} h
                </div>
              </div>
              <div className="stat-box">
                <div className="stat-box-label">Stato Avanzamento</div>
                <div className="stat-box-value">
                  {delaysList.length > 0 ? (
                    <span className="semaforo-ritardo"><span className="status-dot danger" />{delaysList.length} Fasi in allarme</span>
                  ) : (
                    <span className="semaforo-ok"><span className="status-dot completed" />In linea</span>
                  )}
                </div>
              </div>
              <div className="stat-box">
                <div className="stat-box-label">Referente Commessa</div>
                <div className="stat-box-value" style={{ fontSize: '0.95rem' }}>
                  {project?.responsible_name || project?.responsible_username || project?.responsible?.full_name || project?.responsible?.username || 'N/D'}
                </div>
              </div>
              <div className="stat-box">
                <div className="stat-box-label">Addetti Commessa</div>
                <div className="stat-box-value" style={{ fontSize: '0.9rem', whiteSpace: 'normal', lineHeight: '1.3' }}>
                  {Array.isArray(project?.assigned_workers) && project.assigned_workers.length > 0
                    ? project.assigned_workers.join(', ')
                    : 'Nessuno specifico'}
                </div>
              </div>
            </div>



          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10, position: 'relative' }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setShowTableColumnsMenu(!showTableColumnsMenu)}
            >
              <AppIcon name="columns" size={15} />
              Colonne
              <AppIcon name="chevronDown" size={13} />
            </button>
            {showTableColumnsMenu && (
              <div style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 4, background: 'var(--bg-card)', border: '1px solid var(--border-default)',
                borderRadius: 8, padding: 10, zIndex: 100, minWidth: 200, boxShadow: 'var(--shadow-md)', textAlign: 'left'
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>MOSTRA/NASCONDI:</div>
                {[{ id: 'reparto', label: 'Reparto' }, { id: 'addetti', label: 'Addetti Assegnati' }, { id: 'date', label: 'Inizio / Fine' }, { id: 'ore', label: 'Ore Prev vs Eff' }, { id: 'semaforo', label: 'Semaforo Avanzamento' }, { id: 'azioni', label: 'Azioni' }].map(col => (
                  <label key={col.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)' }}>
                    <input
                      type="checkbox"
                      checked={tableVisibleColumns.includes(col.id)}
                      onChange={() => toggleTableColumn(col.id)}
                    />
                    {col.label}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="phases-table-container">
            <table className="phases-table">
              <thead>
                <tr>
                  <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('fase')}>
                    Fase Lavorazione <span style={{ color: 'var(--accent-500)', marginLeft: 4 }}>{sortConfig.key === 'fase' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}</span>
                  </th>
                  {tableVisibleColumns.includes('reparto') && (
                    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('reparto')}>
                      Reparto <span style={{ color: 'var(--accent-500)', marginLeft: 4 }}>{sortConfig.key === 'reparto' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}</span>
                    </th>
                  )}
                  {tableVisibleColumns.includes('addetti') && (
                    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('addetti')}>
                      Addetti Assegnati <span style={{ color: 'var(--accent-500)', marginLeft: 4 }}>{sortConfig.key === 'addetti' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}</span>
                    </th>
                  )}
                  {tableVisibleColumns.includes('date') && (
                    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('date')}>
                      Inizio / Fine <span style={{ color: 'var(--accent-500)', marginLeft: 4 }}>{sortConfig.key === 'date' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}</span>
                    </th>
                  )}
                  {tableVisibleColumns.includes('ore') && (
                    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('ore')}>
                      Ore Prev vs Eff <span style={{ color: 'var(--accent-500)', marginLeft: 4 }}>{sortConfig.key === 'ore' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}</span>
                    </th>
                  )}
                  {tableVisibleColumns.includes('semaforo') && (
                    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('semaforo')}>
                      Semaforo Avanzamento <span style={{ color: 'var(--accent-500)', marginLeft: 4 }}>{sortConfig.key === 'semaforo' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}</span>
                    </th>
                  )}
                  {tableVisibleColumns.includes('azioni') && <th style={{ textAlign: 'right' }}>Azioni</th>}
                </tr>
              </thead>
              <tbody>
                {sortedTasks.length === 0 ? (
                  <tr>
                    <td colSpan={1 + tableVisibleColumns.length} style={{ textAlign: 'center', color: 'var(--text-tertiary)', padding: 32 }}>
                      Nessuna fase aggiunta. Clicca <strong>+ Nuova Fase Lavorazione</strong> in alto.
                    </td>
                  </tr>
                ) : (
                  sortedTasks.map((task) => {
                    const st = computeStato(task);
                    const tEff = calculateTaskEffHours(task);
                    const tColor = getTaskColor(task);
                    const isCompleted = isTaskCompleted(task);
                    return (

                      <tr key={task.id} style={{ backgroundColor: isCompleted ? 'rgba(16, 185, 129, 0.18)' : (task.type === 'milestone' ? 'rgba(245, 158, 11, 0.15)' : undefined) }}>
                        <td style={{ fontWeight: 600 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: tColor, flexShrink: 0, display: 'inline-block', border: '1px solid rgba(255,255,255,0.2)' }} title={`Colore fase: ${tColor}`} />
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              {task.text}
                              {isCompleted && (
                                <div title="Fase completata" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                  <AppIcon name="check" size={16} style={{ color: '#10b981' }} />
                                </div>
                              )}
                            </span>
                          </div>
                        </td>
                        {tableVisibleColumns.includes('reparto') && (
                          <td>
                            {task.department ? (() => {
                              const dept = departmentOptions.find(d => d.value === task.department);
                              return (
                                <span style={{
                                  display: 'inline-block', padding: '3px 10px', borderRadius: 20, fontSize: '0.75rem', fontWeight: 600,
                                  background: (dept?.color || '#6b7280') + '22', color: dept?.color || '#6b7280',
                                  border: `1px solid ${(dept?.color || '#6b7280')}44`, whiteSpace: 'nowrap'
                                }}>
                                  {dept?.label || task.department}
                                </span>
                              );
                            })() : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                          </td>
                        )}
                        {tableVisibleColumns.includes('addetti') && (
                          <td>

                            {Array.isArray(task.workers) && task.workers.length > 0 ? (
                              task.workers.map(w => (
                                <span key={w} className="worker-chip"><AppIcon name="user" size={12} />{w}</span>
                              ))
                            ) : (
                              <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>Nessun addetto</span>
                            )}
                          </td>
                        )}
                        {tableVisibleColumns.includes('date') && (
                          <td style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                            {task.type === 'milestone' ? (
                              <div style={{ fontWeight: 600, color: '#d97706', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}>
                                <AppIcon name="calendar" size={13} /> {formatDateItalian(task.start_date)}
                              </div>
                            ) : (
                              <>
                                <div style={{ whiteSpace: 'nowrap' }}>{formatDateItalian(task.start_date)} → {formatDateItalian(task.end_date)}</div>
                                <div style={{ fontSize: 11, color: 'var(--accent-500)', fontWeight: 600, marginTop: 2, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}>
                                  <AppIcon name="calendar" size={12} />Durata: {task.duration || 1} {task.duration === 1 ? 'giorno' : 'giorni'}
                                </div>
                              </>
                            )}
                          </td>
                        )}
                        {tableVisibleColumns.includes('ore') && (
                          <td>
                            {task.type !== 'milestone' ? (
                              <>
                                <strong>{task.planned_hours || 8}h</strong> prev /{' '}
                                <span style={{ color: tEff < ((task.planned_hours || 8) * 0.5) ? 'var(--danger)' : 'var(--success)', fontWeight: 700 }}>
                                  {tEff}h eff
                                </span>
                              </>
                            ) : (
                              <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>-</span>
                            )}
                          </td>
                        )}
                        {tableVisibleColumns.includes('semaforo') && (
                          <td>
                            {st === 'ok' && <span className="semaforo-ok"><span className="status-dot completed" />Regolare</span>}
                            {st === 'attenzione' && <span className="semaforo-attenzione"><span className="status-dot open" />Attenzione</span>}
                            {st === 'ritardo_ferie' && <span className="semaforo-ritardo"><span className="status-dot danger" />Rischio ritardo ferie</span>}
                            {st === 'ritardo' && <span className="semaforo-ritardo"><span className="status-dot danger" />Ritardo lavorazione</span>}
                            {st === 'sforamento' && <span className="semaforo-ritardo"><span className="status-dot danger" />Sforamento ore</span>}
                            {st === 'mancata_consuntivazione' && <span className="semaforo-mancata-consuntivazione"><span className="status-dot" style={{ background: '#8b5cf6' }} />Mancata consuntivazione</span>}
                          </td>
                        )}
                        {tableVisibleColumns.includes('azioni') && (
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {task.type !== 'milestone' && Number(task.duration) !== 0 && (
                              <button
                                className="btn btn-secondary btn-sm"
                                style={{ marginRight: 6 }}
                                onClick={() => openOreModalForTask(task)}
                                title="Inserisci ore lavorate (Giornale ore)"
                              >
                                <AppIcon name="clock" size={15} />
                                Consuntiva
                              </button>
                            )}
                            {canManageProject && (
                              <>
                                <button
                                  className="btn btn-secondary btn-icon"
                                  style={{ marginRight: 6 }}
                                  onClick={() => openEditTaskModal(task)}
                                  title="Modifica fase"
                                >
                                  <AppIcon name="edit" size={15} />
                                </button>
                                <button
                                  className="btn-ghost btn-icon project-delete"
                                  onClick={() => handleTaskDelete(task.id)}
                                  title="Elimina fase"
                                >
                                  <AppIcon name="trash" size={15} />
                                </button>
                              </>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: NOTE ED ALLEGATI */}
      {activeTab === 'note' && (
        <div className="animate-fadeIn">
          <div className="commessa-summary-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h3 style={{ margin: 0, color: 'var(--text-primary)' }}>Note ed Allegati</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginTop: 6, marginBottom: 0 }}>
                  Area dedicata a note generali della commessa, caricamento di file allegati e accesso diretto ai ticket di assistenza.
                </p>
              </div>
              <button
                className="btn btn-secondary"
                style={{ borderColor: openTicketsCount > 0 ? 'var(--warning)' : 'var(--border-default)', color: openTicketsCount > 0 ? 'var(--warning)' : 'inherit' }}
                onClick={() => navigate('/tickets', { state: { projectId: id } })}
              >
                <AppIcon name="ticket" size={16} />Gestione ticket
                {openTicketsCount > 0 && (
                  <span className="tab-badge" style={{ backgroundColor: 'var(--warning)', color: '#fff', marginLeft: 8 }}>{openTicketsCount} Aperti</span>
                )}
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>
            {/* AREA NOTE */}
            <div className="commessa-summary-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h4 style={{ margin: 0, fontSize: 16, color: 'var(--text-primary)' }}>Note Commessa Condivise</h4>
              </div>
              <textarea
                value={notesText}
                onChange={e => setNotesText(e.target.value)}
                onBlur={handleSaveNotes}
                placeholder="Scrivi qui eventuali note, dettagli tecnici o considerazioni per questa commessa..."
                style={{
                  width: '100%',
                  height: 300,
                  padding: 12,
                  borderRadius: 8,
                  border: '1px solid var(--border-default)',
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  fontSize: 14,
                  resize: 'vertical',
                  fontFamily: 'inherit'
                }}
              />
            </div>

            {/* AREA ALLEGATI */}
            <div className="commessa-summary-card"
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onDrop={handleDropAttachment}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h4 style={{ margin: 0, fontSize: 16, color: 'var(--text-primary)' }}>Allegati</h4>

                <div>
                  <input
                    type="file"
                    id="project-attachment-upload-note"
                    multiple
                    style={{ display: 'none' }}
                    onChange={handleUploadAttachment}
                  />
                  <label htmlFor="project-attachment-upload-note" className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
                    + Aggiungi
                  </label>
                </div>
              </div>

              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 16 }}>
                {Array.isArray(project?.attachments) && project.attachments.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {project.attachments.map((att, idx) => (
                      <div key={idx} style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '8px 12px', background: 'var(--bg-card)',
                        border: '1px solid var(--border-subtle)', borderRadius: 8, fontSize: 13
                      }}>
                        <a href={`${BACKEND_URL}/${att.path}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-500)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <AppIcon name="paperclip" size={14} /> {att.name}
                        </a>
                        <button
                          onClick={() => handleDeleteAttachment(att.name)}
                          style={{ background: 'var(--danger-light)', border: 'none', cursor: 'pointer', color: 'var(--danger)', padding: '4px 8px', borderRadius: 4, fontSize: 12 }}
                          title="Elimina allegato"
                        >
                          Elimina
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic', textAlign: 'center', padding: '24px 0', border: '1px dashed var(--border-default)', borderRadius: 8 }}>
                    Nessun allegato presente.<br />Trascina qui i file o usa il pulsante Aggiungi.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: RITARDI & ALLARMI */}
      {activeTab === 'alert' && (
        <div className="animate-fadeIn">
          <div
            className="commessa-summary-card"
            style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column' }}
            onClick={() => setIsAlertsExpanded(!isAlertsExpanded)}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h3 style={{ margin: 0, color: 'var(--text-primary)' }}>Motore Semafori ed Allarmi Lavorazioni</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginTop: 6, marginBottom: 0 }}>
                  Questo pannello identifica automaticamente tutte le lavorazioni e commesse che non stanno rispettando la consuntivazione oraria attesa (meno del 50% delle ore previste o giorni lavorativi trascorsi con 0 ore registrate).
                </p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 16, marginTop: 25 }}>
                {delaysList.length > 0 && (
                  <span style={{
                    background: '#dd3333', color: '#fff',
                    padding: '4px 10px', borderRadius: 12, fontSize: 13, fontWeight: 600,
                    whiteSpace: 'nowrap'
                  }}>
                    {delaysList.length} {delaysList.length === 1 ? 'allerta' : 'allerte'}
                  </span>
                )}
                <AppIcon name={isAlertsExpanded ? "chevronUp" : "chevronDown"} size={20} color="var(--text-secondary)" />
              </div>
            </div>

            {isAlertsExpanded && (
              <div style={{ marginTop: 24, borderTop: '1px solid var(--border-subtle)', paddingTop: 24 }}>
                {delaysList.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 24 }}>
                    <div className="empty-state-icon" style={{ margin: '0 auto 12px' }}><AppIcon name="check" size={26} /></div>
                    <h4 style={{ color: 'var(--success)', margin: 0 }}>Nessuna Allerta di Ritardo!</h4>
                    <p style={{ color: 'var(--text-secondary)', marginTop: 8, fontSize: 14 }}>
                      Tutte le {ganttData.tasks.length} fasi di lavorazione della commessa sono regolarmente coperte dalla consuntivazione oraria degli addetti.
                    </p>
                  </div>
                ) : (
                  delaysList.map((item, idx) => {
                    if (item.isProjectAlert) {
                      return (
                        <div
                          key={`proj-alert-${idx}`}
                          className={`alert-card no_responsible`}
                          style={{ marginBottom: 12, cursor: 'default' }}
                          onClick={e => e.stopPropagation()}
                        >
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                              <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>
                                Allarme Commessa
                              </span>
                              <span className="semaforo-dato-mancante"><span className="status-dot" style={{ background: '#0ea5e9' }} />Dato mancante</span>
                            </div>
                            <div className="inline-detail-row" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                              <AppIcon name="alertTriangle" size={14} style={{ color: '#0ea5e9' }} /> <strong style={{ marginLeft: 6 }}>{item.text}</strong>
                            </div>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={item.task.id}
                        className={`alert-card ${item.stato}`}
                        style={{ marginBottom: 12, cursor: 'default' }}
                        onClick={e => e.stopPropagation()}
                      >
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                            <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>
                              {item.task.text}
                            </span>
                            {item.stato === 'ritardo' ? (
                              <span className="semaforo-ritardo"><span className="status-dot danger" />Ritardo critico</span>
                            ) : item.stato === 'ritardo_ferie' ? (
                              <span className="semaforo-ritardo"><span className="status-dot danger" />Rischio ritardo ferie</span>
                            ) : item.stato === 'sforamento' ? (
                              <span className="semaforo-ritardo"><span className="status-dot danger" />Sforamento ore</span>
                            ) : item.stato === 'orfana' ? (
                              <span className="semaforo-attenzione" style={{ color: '#f59e0b', background: '#fffbeb', border: '1px solid #fef3c7' }}><span className="status-dot warning" />Nessun addetto</span>
                            ) : item.stato === 'mancata_consuntivazione' ? (
                              <span className="semaforo-mancata-consuntivazione"><span className="status-dot" style={{ background: '#8b5cf6' }} />Mancata consuntivazione</span>
                            ) : (
                              <span className="semaforo-attenzione"><span className="status-dot open" />Attenzione</span>
                            )}
                          </div>
                          <div className="inline-detail-row" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                            <AppIcon name="calendar" size={14} /> Inizio/Fine: <strong>{formatDateItalian(item.task.start_date)} → {formatDateItalian(item.task.end_date)}</strong> |{' '}
                            Addetti: <strong>{Array.isArray(item.task.workers) ? item.task.workers.join(', ') : 'Nessuno'}</strong>
                          </div>
                          <div className="inline-detail-row" style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 4 }}>
                            <AppIcon name="clock" size={13} />Ore previste: <strong>{item.task.planned_hours || 8}h</strong> | Consuntivate finora: <strong>{item.tEff}h</strong>
                          </div>
                        </div>
                        <button
                          className="btn btn-primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            openOreModalForTask(item.task);
                          }}
                        >
                          <AppIcon name="clock" />
                          Registra ore
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* SEZIONE OTTIMIZZATORE & REBALANCE CARICHI (Solo Admin ed Editor) */}
          {(user?.role === 'admin' || user?.role === 'editor') && (
            <SmartReplanningSection
              projectId={id}
              user={user}
              onReloadTasks={loadGanttDataOnly}
              tasks={ganttData.tasks}
              links={ganttData.links}
              projectStartDate={project?.start_date}
              projectEndDate={project?.end_date}
            />
          )}
        </div>
      )}

      {/* TAB 5: ANALISI AI */}
      {activeTab === 'ai_analysis' && (
        <div className="animate-fadeIn">
          <div
            className="commessa-summary-card"
            style={{
              background: 'var(--bg-secondary)',
              borderRadius: '16px',
              border: '1px solid rgba(59, 130, 246, 0.35)',
              boxShadow: '0 4px 20px rgba(59, 130, 246, 0.06)',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            {/* Header del Box AI */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '20px 24px',
                background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.08), rgba(99, 102, 241, 0.04))',
                borderBottom: '1px solid var(--border-subtle)'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                <div
                  style={{
                    width: '42px',
                    height: '42px',
                    borderRadius: '12px',
                    background: 'linear-gradient(135deg, var(--accent-500, #3b82f6), var(--accent-600, #2563eb))',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    boxShadow: '0 2px 10px rgba(37, 99, 235, 0.3)'
                  }}
                >
                  <Sparkles size={22} />
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <h3 style={{ margin: 0, fontSize: '1.15rem', color: 'var(--text-primary)', fontWeight: '700' }}>
                      Analisi Commessa
                    </h3>
                    <span
                      style={{
                        background: 'linear-gradient(135deg, #3b82f6, #6366f1)',
                        color: '#fff',
                        fontSize: '11px',
                        fontWeight: '700',
                        padding: '2px 8px',
                        borderRadius: '10px',
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px'
                      }}
                    >
                      HiPlan AI
                    </span>
                    {/* Badge Tipologia Commessa */}
                    {project?.is_atex && (
                      <span className="badge badge-atex" style={{ fontSize: '11px', padding: '2px 9px', borderRadius: 20 }}>
                        ATEX
                      </span>
                    )}
                    {project?.is_alimentare && (
                      <span className="badge badge-alimentare" style={{ fontSize: '11px', padding: '2px 9px', borderRadius: 20 }}>
                        Alimentare
                      </span>
                    )}
                    {!project?.is_atex && !project?.is_alimentare && (
                      <span className="badge badge-standard" style={{ fontSize: '11px', padding: '2px 9px', borderRadius: 20 }}>
                        Standard
                      </span>
                    )}
                  </div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '13.5px', margin: '4px 0 0 0' }}>
                    Verifica ritardi, sovrapposizioni, ferie, sovraccarichi multi-commessa, requisiti normativi e dati mancanti con consigli di riprogrammazione.
                  </p>
                </div>
              </div>

              <button
                className="btn btn-primary"
                onClick={() => handleRunAiAnalysis(true)}
                disabled={isAiAnalyzing}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '9px 18px',
                  borderRadius: '10px',
                  fontWeight: '600',
                  fontSize: '13.5px',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
                }}
              >
                {isAiAnalyzing ? (
                  <>
                    <RefreshCw size={16} className="animate-spin" />
                    Analisi in corso...
                  </>
                ) : (
                  <>
                    <Sparkles size={16} />
                    {aiAnalysis ? 'Rianalizza Commessa' : 'Avvia Analisi con AI'}
                  </>
                )}
              </button>
            </div>

            {/* Contenuto del Box AI */}
            <div style={{ padding: '24px' }}>
              {isAiAnalyzing ? (
                <div style={{ textAlign: 'center', padding: '48px 20px' }}>
                  <div
                    style={{
                      width: '54px',
                      height: '54px',
                      borderRadius: '50%',
                      background: 'rgba(59, 130, 246, 0.1)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      margin: '0 auto 16px',
                      color: 'var(--accent-500)'
                    }}
                  >
                    <Bot size={30} className="animate-pulse" />
                  </div>
                  <h4 style={{ margin: '0 0 8px 0', color: 'var(--text-primary)', fontSize: '1.1rem' }}>
                    Analisi intelligente in corso...
                  </h4>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '14px', maxWidth: '520px', margin: '0 auto' }}>
                    HiPlan AI sta esaminando le date della commessa, le fasi, la tipologia normativa (Standard / ATEX / Alimentare), le ferie e i carichi di lavoro degli addetti per individuare conflitti e suggerire le soluzioni ottimali.
                  </p>
                </div>
              ) : aiAnalysis ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {/* Badge di stato */}
                  <div
                    style={{
                      padding: '12px 16px',
                      borderRadius: '10px',
                      background: aiAnalysis.has_conflicts ? 'rgba(239, 68, 68, 0.08)' : 'rgba(16, 185, 129, 0.08)',
                      border: `1px solid ${aiAnalysis.has_conflicts ? 'rgba(239, 68, 68, 0.25)' : 'rgba(16, 185, 129, 0.25)'}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: '12px'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      {aiAnalysis.has_conflicts ? (
                        <AlertTriangle size={20} color="#ef4444" />
                      ) : (
                        <CheckCircle size={20} color="#10b981" />
                      )}
                      <span style={{ fontWeight: '600', fontSize: '14px', color: 'var(--text-primary)' }}>
                        {aiAnalysis.has_conflicts
                          ? `Rilevati conflitti/sovraccarichi e dati da verificare`
                          : 'Nessun conflitto rilevato: la commessa è pianificata regolarmente'}
                      </span>
                      {/* Pill di tipologia verificata */}
                      <span style={{
                        fontSize: '11px',
                        fontWeight: 600,
                        padding: '2px 8px',
                        borderRadius: 12,
                        background: 'var(--bg-tertiary)',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border-subtle)'
                      }}>
                        Tipologia: {project?.is_atex && project?.is_alimentare ? 'ATEX + Alimentare' : project?.is_atex ? 'ATEX' : project?.is_alimentare ? 'Alimentare' : 'Standard'}
                      </span>
                    </div>
                    <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                      Generato {aiAnalysis.generated_date ? `il ${aiAnalysis.generated_date} ` : ''}alle {aiAnalysis.generated_at || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>

                  {/* Markdown Report Formattato */}
                  <div
                    className="chat-markdown"
                    style={{
                      background: 'var(--bg-primary)',
                      padding: '20px',
                      borderRadius: '12px',
                      border: '1px solid var(--border-subtle)',
                      lineHeight: '1.65',
                      fontSize: '0.95rem'
                    }}
                  >
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {aiAnalysis.analysis}
                    </ReactMarkdown>
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    textAlign: 'center',
                    padding: '40px 20px',
                    background: 'rgba(59, 130, 246, 0.02)',
                    borderRadius: '12px',
                    border: '1px dashed var(--border-color)'
                  }}
                >
                  <div style={{ color: 'var(--accent-500)', marginBottom: '12px' }}>
                    <Sparkles size={36} style={{ margin: '0 auto' }} />
                  </div>
                  <h4 style={{ margin: '0 0 6px 0', color: 'var(--text-primary)', fontSize: '1.1rem' }}>
                    Vuoi analizzare questa commessa con HiPlan AI?
                  </h4>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '14px', maxWidth: '600px', margin: '0 auto 20px' }}>
                    HiPlan AI verificherà all'istante eventuali ritardi, conflitti con ferie, sovraccarichi degli addetti (incrociando anche le altre commesse) e ti fornirà consigli pratici di riprogrammazione.
                  </p>
                  <button
                    className="btn btn-primary"
                    onClick={handleRunAiAnalysis}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '10px 22px',
                      borderRadius: '10px',
                      fontWeight: '600',
                      fontSize: '14px'
                    }}
                  >
                    <Sparkles size={18} />
                    Avvia Analisi Intelligente
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODALE NUOVA / MODIFICA FASE (TASK MODAL) */}
      {showTaskModal && (
        <div className="modal-overlay">
          <div
            className="modal task-editor-modal"
            style={{
              maxWidth: 'min(1560px, 96vw)',
              width: '96vw',
              height: '92vh',
              maxHeight: '94vh',
              display: 'flex',
              flexDirection: 'column'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700 }}>
                  {editingTask ? 'Dettagli Fase Lavorazione' : 'Nuova Fase Lavorazione'}
                </h2>
                {editingTask && (
                  <div className="task-tab-switcher">
                    {canManageProject && (
                      <button
                        type="button"
                        className={`task-tab-btn ${taskModalTab === 'generale' ? 'active' : ''}`}
                        onClick={() => setTaskModalTab('generale')}
                      >
                        <AppIcon name="edit" size={15} />
                        <span>Generale</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className={`task-tab-btn ${taskModalTab === 'checklist' ? 'active' : ''}`}
                      onClick={() => setTaskModalTab('checklist')}
                    >
                      <AppIcon name="checkSquare" size={15} />
                      <span>Checklist</span>
                    </button>
                    <button
                      type="button"
                      className={`task-tab-btn ${taskModalTab === 'commenti' ? 'active' : ''}`}
                      onClick={() => setTaskModalTab('commenti')}
                    >
                      <AppIcon name="messageSquare" size={15} />
                      <span>Commenti</span>
                    </button>
                    {editingTask.type !== 'milestone' && (
                      <button
                        type="button"
                        className={`task-tab-btn ${taskModalTab === 'consuntivo' ? 'active' : ''}`}
                        onClick={() => {
                          const currentTaskForHours = {
                            ...editingTask,
                            ...taskForm,
                            budget_mode: taskForm.budgetMode || editingTask.budget_mode
                          };
                          prepareOreDataForTask(currentTaskForHours, false);
                          setTaskModalTab('consuntivo');
                        }}
                      >
                        <AppIcon name="clock" size={15} />
                        <span>Consuntivo</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
              <button className="btn-ghost btn-icon" onClick={() => setShowTaskModal(false)} aria-label="Chiudi">
                <AppIcon name="close" />
              </button>
            </div>

            {taskModalTab === 'generale' && (() => {
              const isMilestone = taskForm.taskType === 'milestone';
              const currentAssignedTotal = taskForm.workers.reduce((sum, w) => sum + (Number(taskForm.worker_hours?.[w]) || 0), 0);
              const sDateForBudget = taskForm.start_date;
              const eDateForBudget = taskForm.end_date;
              const diffDaysForBudget = sDateForBudget && eDateForBudget ? countWorkingDays(sDateForBudget, eDateForBudget, taskForm.excluded_dates) : 1;
              const finalDaysForBudget = Math.max(1, Number(taskForm.duration_days) || diffDaysForBudget);
              const currentBudgetTotal = isMilestone ? 0 : (Number(taskForm.planned_hours) || (finalDaysForBudget * 8.0));

              const roundedAssigned = Math.round(currentAssignedTotal * 10) / 10;
              const roundedBudget = Math.round(currentBudgetTotal * 10) / 10;
              const isOverBudget = !isMilestone && roundedAssigned > roundedBudget;

              let totalColor = 'var(--text-secondary)';
              if (!isMilestone) {
                if (roundedAssigned < roundedBudget) totalColor = '#f59e0b';
                else if (roundedAssigned === roundedBudget) totalColor = '#10b981';
                else totalColor = '#ef4444';
              }

              return (
                <form onSubmit={handleSaveTaskForm} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
                  <div className="task-form-layout">
                    {/* COLONNA SINISTRA: Informazioni Fase, Tipologia, Colore, Reparto, Addetti */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                      {/* Scelta Tipo Fase: Normale o Milestone */}
                      <div className="task-type-selector" style={{ margin: 0 }}>
                        <label>Tipo di Voce:</label>
                        <div>
                          <label className={`task-type-option ${taskForm.taskType !== 'milestone' ? 'selected' : ''}`}>
                            <input
                              type="radio"
                              name="taskType"
                              value="task"
                              checked={taskForm.taskType !== 'milestone'}
                              onChange={() => setTaskForm({ ...taskForm, taskType: 'task' })}
                            />
                            <div className="option-content">
                              <div className="option-title">
                                <AppIcon name="list" size={18} />
                                Fase di lavorazione
                              </div>
                            </div>
                          </label>
                          <label className={`task-type-option ${taskForm.taskType === 'milestone' ? 'selected' : ''}`}>
                            <input
                              type="radio"
                              name="taskType"
                              value="milestone"
                              checked={taskForm.taskType === 'milestone'}
                              onChange={() => setTaskForm({ ...taskForm, taskType: 'milestone', color: taskForm.color === PHASE_DEFAULT_COLORS[PREDEFINED_PHASES[0]] ? '#f59e0b' : taskForm.color })}
                            />
                            <div className="option-content">
                              <div className="option-title">
                                <AppIcon name="calendar" size={18} />
                                Milestone
                              </div>
                            </div>
                          </label>
                        </div>
                      </div>

                      {/* Card Dati Principali */}
                      <div className="task-card-section">
                        <div className="task-card-section-title">
                          <AppIcon name="fileText" size={14} />
                          Informazioni Base
                        </div>

                        <div className="input-group" style={{ position: 'relative' }}>
                          <label>{taskForm.taskType === 'milestone' ? 'Nome Evento / Scadenza *' : 'Fase di Lavorazione *'}</label>
                          <SearchableCombobox
                            options={getAvailableTemplates().map(tpl => ({
                              value: tpl.name,
                              label: tpl.name,
                              department: (tpl.department && tpl.department !== 'tutti') ? tpl.department : 'condivisa',
                              ...tpl
                            }))}
                            value={taskForm.faseSel === '__custom__' ? taskForm.customText : taskForm.faseSel}
                            onChange={(val, opt) => {
                              if (opt) {
                                if (opt.default_budget_mode) {
                                  setBudgetMode(opt.default_budget_mode);
                                }
                                const newDays = opt.default_days != null ? opt.default_days : taskForm.duration_days;
                                const newHours = opt.default_hours != null ? opt.default_hours : taskForm.planned_hours;
                                const sDate = taskForm.start_date || new Date().toISOString().split('T')[0];
                                const newEnd = addWorkingDays(sDate, newDays, taskForm.excluded_dates);
                                setTaskForm({
                                  ...taskForm,
                                  faseSel: opt.name,
                                  customText: '',
                                  color: opt.default_color || PHASE_DEFAULT_COLORS[opt.name] || taskForm.color,
                                  duration_days: newDays,
                                  planned_hours: newHours,
                                  end_date: newEnd,
                                  department: opt.department && opt.department !== 'tutti' ? opt.department : 'condivisa'
                                });
                              } else {
                                setTaskForm({
                                  ...taskForm,
                                  faseSel: '__custom__',
                                  customText: val
                                });
                              }
                            }}
                            placeholder="Seleziona o digita una nuova fase..."
                            allowCustom={true}
                            groupBy={user?.role === 'admin' ? 'department' : undefined}
                            groupLabels={deptNameMap}
                            renderOption={(opt, searchStr) => (
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                  <span style={{ width: 12, height: 12, borderRadius: '50%', background: opt.default_color || PHASE_DEFAULT_COLORS[opt.name] || '#3b82f6', border: '1px solid var(--border-default)', flexShrink: 0 }} />
                                  <span style={{ fontWeight: (taskForm.faseSel === opt.name || taskForm.customText === opt.name) ? 600 : 400, color: 'var(--text-primary)' }}>{opt.name}</span>
                                </div>
                                <button
                                  type="button"
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    handleDeleteTemplateFromDropdown(opt);
                                  }}
                                  className="btn-ghost btn-icon"
                                  style={{ padding: '2px 6px', color: 'var(--danger)', fontSize: '0.9rem' }}
                                  title="Elimina dall'elenco a tendina"
                                >
                                  <AppIcon name="trash" size={14} />
                                </button>
                              </div>
                            )}
                          />
                          {taskForm.faseSel === '__custom__' && taskForm.customText && (
                            <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--bg-tertiary)', borderRadius: 6, border: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                                <AppIcon name="alert" size={14} style={{ color: 'var(--accent-500)' }} /> Questa nuova fase verrà automaticamente aggiunta all'elenco suggerito per il reparto selezionato:
                              </span>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                                  {DEPT_OPTIONS.map(d => {
                                    const currentVal = taskForm.department || user?.department || 'ufficio_tecnico';
                                    const isSelected = currentVal === d.value;
                                    return (
                                      <button
                                        type="button"
                                        key={d.value}
                                        onClick={(e) => {
                                          e.preventDefault();
                                          setTaskForm({
                                            ...taskForm,
                                            department: d.value,
                                            color: d.color === '#6b7280' ? taskForm.color : d.color
                                          });
                                        }}
                                        style={{
                                          padding: '5px 14px', borderRadius: 20, fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
                                          background: isSelected ? (d.color + '22') : 'var(--bg-primary)',
                                          color: isSelected ? d.color : 'var(--text-secondary)',
                                          border: `1.5px solid ${isSelected ? d.color : 'var(--border-default)'}`,
                                          boxShadow: isSelected ? `0 0 0 2px ${d.color}33` : 'none',
                                          transition: 'all 0.18s ease', display: 'inline-flex', alignItems: 'center', gap: 6
                                        }}
                                      >
                                        <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: d.color, opacity: isSelected ? 1 : 0.4 }} />
                                        <span>{d.label}</span>
                                      </button>
                                    );
                                  })}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Colore personalizzato della fase */}
                        <div className="input-group">
                          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <span>Colore Fase (Gantt & Timeline)</span>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontWeight: 'normal' }}>Personalizzabile</span>
                          </label>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
                            <input
                              type="color"
                              value={taskForm.color || '#3b82f6'}
                              onChange={(e) => setTaskForm({ ...taskForm, color: e.target.value })}
                              style={{ width: 44, height: 38, padding: 2, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', cursor: 'pointer', background: 'var(--bg-tertiary)' }}
                            />
                            <input
                              type="text"
                              className="input"
                              value={(taskForm.color || '#3b82f6').toUpperCase()}
                              onChange={(e) => setTaskForm({ ...taskForm, color: e.target.value })}
                              style={{ width: 100, fontFamily: 'monospace' }}
                              maxLength={7}
                            />
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {Object.values(PHASE_DEFAULT_COLORS).slice(0, 8).map((c) => (
                                <button
                                  key={c}
                                  type="button"
                                  onClick={() => setTaskForm({ ...taskForm, color: c })}
                                  style={{
                                    width: 24,
                                    height: 24,
                                    borderRadius: '50%',
                                    backgroundColor: c,
                                    border: taskForm.color === c ? '2px solid #fff' : '1px solid var(--border-subtle)',
                                    boxShadow: taskForm.color === c ? '0 0 0 2px var(--accent-500)' : 'none',
                                    cursor: 'pointer',
                                    padding: 0
                                  }}
                                  title={`Colore preset: ${c}`}
                                />
                              ))}
                            </div>
                          </div>
                        </div>

                        {/* Reparto */}
                        <div className="input-group">
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <AppIcon name="building" size={15} />
                            Reparto Competente
                            {user?.role !== 'admin' && taskForm.faseSel !== '__custom__' && (
                              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>(assegnato automaticamente)</span>
                            )}
                          </label>
                          {user?.role === 'admin' || taskForm.faseSel === '__custom__' ? (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                              {DEPT_OPTIONS.map(d => {
                                const isSelected = taskForm.department === d.value;
                                return (
                                  <button
                                    type="button"
                                    key={d.value}
                                    onClick={() => setTaskForm(prev => ({
                                      ...prev,
                                      department: d.value,
                                      color: d.color || prev.color || '#3b82f6'
                                    }))}
                                    style={{
                                      padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                                      background: isSelected ? (d.color + '22') : 'var(--bg-primary)',
                                      color: isSelected ? d.color : 'var(--text-secondary)',
                                      border: `1.5px solid ${isSelected ? d.color : 'var(--border-default)'}`,
                                      boxShadow: isSelected ? `0 0 0 2px ${d.color}33` : 'none',
                                      display: 'inline-flex', alignItems: 'center', gap: 8, transition: 'all 0.18s ease'
                                    }}
                                  >
                                    <span style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: d.color, opacity: isSelected ? 1 : 0.4 }} />
                                    <span>{d.label}</span>
                                  </button>
                                );
                              })}
                            </div>
                          ) : (
                            <div style={{
                              padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                              background: taskForm.department ? (DEPT_OPTIONS.find(d => d.value === taskForm.department)?.color || '#6b7280') + '18' : 'var(--bg-secondary)',
                              color: taskForm.department ? (DEPT_OPTIONS.find(d => d.value === taskForm.department)?.color || '#6b7280') : 'var(--text-muted)',
                              border: `1px solid ${taskForm.department ? (DEPT_OPTIONS.find(d => d.value === taskForm.department)?.color || '#6b7280') + '44' : 'var(--border-subtle)'}`,
                              display: 'flex', alignItems: 'center', gap: 8
                            }}>
                              {taskForm.department ? DEPT_OPTIONS.find(d => d.value === taskForm.department)?.label || taskForm.department : '— Nessun reparto —'}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Card Addetti Assegnati */}
                      <div className="task-card-section">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div className="task-card-section-title">
                            <AppIcon name="user" size={14} />
                            Addetto Assegnato (Singolo)
                          </div>
                          {!isMilestone && (
                            <span style={{ fontSize: '0.82rem', fontWeight: 700, color: totalColor }}>
                              Totale assegnato: {roundedAssigned}h / {roundedBudget}h
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                          {[...predefinedWorkers]
                            .filter(w => {
                              if (taskForm.workers.includes(w)) return true;
                              if (!taskForm.department || taskForm.department === 'condivisa') return true;
                              const wUser = usersList.find(u => u.username === w);
                              return wUser && wUser.department === taskForm.department;
                            })
                            .sort((a, b) => a === user?.username ? -1 : b === user?.username ? 1 : a.localeCompare(b))
                            .map(w => {
                              const sel = taskForm.workers.includes(w);
                              const wUser = usersList.find(u => u.username === w);
                              const wDept = wUser ? wUser.department : null;
                              const deptColor = wDept ? (DEPT_OPTIONS.find(d => d.value === wDept)?.color || 'var(--accent-600)') : 'var(--accent-600)';

                              return (
                                <button
                                  type="button"
                                  key={w}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    background: sel ? deptColor : 'var(--bg-primary)',
                                    color: sel ? '#fff' : 'var(--text-secondary)',
                                    border: `1.5px solid ${sel ? deptColor : 'var(--border-default)'}`,
                                    boxShadow: sel ? `0 2px 6px ${deptColor}44` : 'none',
                                    padding: '6px 14px',
                                    borderRadius: '16px',
                                    cursor: 'pointer',
                                    fontSize: '0.85rem',
                                    fontWeight: sel ? 600 : 500,
                                    transition: 'all 0.15s ease'
                                  }}
                                  onClick={() => toggleWorkerSelection(w)}
                                >
                                  <AppIcon name={sel ? "check" : "plus"} size={13} />
                                  <span>{w}</span>
                                </button>
                              );
                            })}
                        </div>
                      </div>
                    </div>

                    {/* COLONNA DESTRA: Commessa info, Pianificazione, Durate, Calendario Date/Ferie */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                      {/* Banner Fine Commessa */}
                      <div style={{ padding: '12px 16px', background: 'var(--bg-primary)', borderRadius: '10px', border: '1px solid var(--border-subtle)', borderLeft: '4px solid var(--accent-500)', display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.9rem' }}>
                        <AppIcon name="calendar" size={18} style={{ color: 'var(--accent-500)' }} />
                        <div>
                          <span style={{ color: 'var(--text-secondary)', marginRight: 6 }}>Scadenza / Fine Commessa:</span>
                          <strong style={{ color: 'var(--text-primary)' }}>{project?.end_date ? formatDateItalian(project.end_date) : 'Non impostata'}</strong>
                        </div>
                      </div>

                      {/* Sezione Pianificazione Temporale e Durate / Data Evento */}
                      {taskForm.taskType === 'milestone' ? (
                        <div className="task-card-section">
                          <div className="task-card-section-title">
                            <AppIcon name="calendar" size={14} />
                            Data Evento o Milestone
                          </div>
                          <div className="input-group" style={{ maxWidth: 280 }}>
                            <label>Data Evento</label>
                            <input
                              type="date"
                              className="input"
                              value={taskForm.start_date}
                              onChange={(e) => setTaskForm({ ...taskForm, start_date: e.target.value, end_date: e.target.value })}
                            />
                          </div>
                        </div>
                      ) : (
                        <div className="task-card-section">
                          <div className="task-card-section-title">
                            <AppIcon name="calendar" size={14} />
                            Pianificazione e Calcolo Durate
                          </div>

                          {/* Scelta Modalità Budget e Pianificazione Date */}
                          <div style={{ padding: '12px', background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border-default)' }}>
                            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                              Modalità calcolo budget e pianificazione date:
                            </label>
                            <select
                              className="input"
                              style={{ width: '100%', fontWeight: 600, background: 'var(--bg-primary)', borderColor: 'var(--accent-500)', color: 'var(--text-primary)' }}
                              value={budgetMode}
                              onChange={(e) => handleBudgetModeChange(e.target.value)}
                            >
                              <option value="start_end">Data Inizio / Data Fine (calcola giorni lavorativi ed ore escludendo sab/dom e festivi)</option>
                              <option value="start_hours">Data Inizio / Ore (calcola data fine escludendo sab/dom e festivi, giorni = ore/8)</option>
                              <option value="end_hours">Data Fine / Ore (calcola data inizio a ritroso escludendo sab/dom e festivi)</option>
                              <option value="start_days">Data Inizio / Giorni (calcola data fine escludendo sab/dom e festivi, ore = giorni×8)</option>
                              <option value="end_days">Data Fine / Giorni (calcola data inizio a ritroso escludendo sab/dom e festivi)</option>
                              <option value="start_days_hours">Data Inizio / Giorni / Ore (es. 24h spalmate su 10 gg escludendo sab/dom e festivi)</option>
                              <option value="end_days_hours">Data Fine / Giorni / Ore (es. 24h spalmate a ritroso su 10 gg escludendo sab/dom e festivi)</option>
                              <option value="custom_dates">📅 Selezione Date da Calendario (giorni singoli o contigui con ore personalizzate/8h)</option>
                            </select>
                          </div>

                          {budgetMode === 'custom_dates' ? (
                            <div style={{ marginTop: 4 }}>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                                <div className="input-group">
                                  <label>Data Inizio (prima data)</label>
                                  <input
                                    type="date"
                                    className="input"
                                    value={taskForm.start_date}
                                    readOnly
                                    style={{ background: 'var(--bg-secondary)', opacity: 0.85, cursor: 'not-allowed' }}
                                    title="Calcolata automaticamente dalla prima data selezionata"
                                  />
                                </div>
                                <div className="input-group">
                                  <label>Data Fine (ultima data)</label>
                                  <input
                                    type="date"
                                    className="input"
                                    value={taskForm.end_date}
                                    readOnly
                                    style={{ background: 'var(--bg-secondary)', opacity: 0.85, cursor: 'not-allowed' }}
                                    title="Calcolata automaticamente dall'ultima data selezionata"
                                  />
                                </div>
                                <div className="input-group">
                                  <label>Giorni Lavorativi Selezionati</label>
                                  <div style={{ position: 'relative' }}>
                                    <input
                                      type="number"
                                      className="input"
                                      readOnly
                                      value={taskForm.duration_days || (taskForm.custom_dates?.length || 0)}
                                      style={{ fontWeight: 600, color: 'var(--accent-500)', paddingRight: '70px', background: 'var(--bg-secondary)', cursor: 'not-allowed' }}
                                    />
                                    <span style={{ position: 'absolute', right: 40, top: 9, fontSize: 12, color: 'var(--text-tertiary)', pointerEvents: 'none' }}>giorni</span>
                                  </div>
                                </div>
                                <div className="input-group">
                                  <label>Totale Ore Previste (Budget)</label>
                                  <div style={{ position: 'relative' }}>
                                    <input
                                      type="number"
                                      className="input"
                                      readOnly
                                      value={taskForm.planned_hours}
                                      style={{ fontWeight: 600, color: 'var(--success)', paddingRight: '60px', background: 'var(--bg-secondary)', cursor: 'not-allowed' }}
                                    />
                                    <span style={{ position: 'absolute', right: 40, top: 9, fontSize: 12, color: 'var(--text-tertiary)', pointerEvents: 'none' }}>ore</span>
                                  </div>
                                </div>
                              </div>

                              {/* Calendario interattivo per la selezione delle date e ore */}
                              <CustomDatesCalendarPicker
                                customDates={taskForm.custom_dates || []}
                                onChange={handleCustomDatesChange}
                                workers={taskForm.workers || []}
                                allVacations={allVacations}
                                initialDate={taskForm.start_date}
                              />
                            </div>
                          ) : (
                            <>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                                <div className="input-group">
                                  <label>Data Avvio Lavorazione</label>
                                  <input
                                    type="date"
                                    className="input"
                                    value={taskForm.start_date}
                                    onChange={(e) => handleStartDateChange(e.target.value)}
                                    disabled={budgetMode === 'end_hours' || budgetMode === 'end_days' || budgetMode === 'end_days_hours'}
                                    style={{ opacity: (budgetMode === 'end_hours' || budgetMode === 'end_days' || budgetMode === 'end_days_hours') ? 0.6 : 1 }}
                                    title={(budgetMode === 'end_hours' || budgetMode === 'end_days' || budgetMode === 'end_days_hours') ? "Data inizio calcolata automaticamente a ritroso" : ""}
                                  />
                                </div>
                                <div className="input-group">
                                  <label>Data Fine Lavorazione</label>
                                  <input
                                    type="date"
                                    className="input"
                                    value={taskForm.end_date}
                                    onChange={(e) => handleEndDateChange(e.target.value)}
                                    disabled={budgetMode === 'start_hours' || budgetMode === 'start_days' || budgetMode === 'start_days_hours'}
                                    style={{ opacity: (budgetMode === 'start_hours' || budgetMode === 'start_days' || budgetMode === 'start_days_hours') ? 0.6 : 1 }}
                                    title={(budgetMode === 'start_hours' || budgetMode === 'start_days' || budgetMode === 'start_days_hours') ? "Data fine calcolata automaticamente escludendo sab e dom" : ""}
                                  />
                                </div>
                                <div className="input-group">
                                  <label>Durata in Giorni (Lun-Ven)</label>
                                  <div style={{ position: 'relative' }}>
                                    <input
                                      type="number"
                                      min="1"
                                      step="1"
                                      className="input"
                                      style={{ fontWeight: 600, color: 'var(--accent-500)', paddingRight: '70px', opacity: (budgetMode === 'start_end' || budgetMode === 'start_hours' || budgetMode === 'end_hours') ? 0.6 : 1 }}
                                      value={taskForm.duration_days}
                                      onChange={(e) => handleDurationDaysChange(e.target.value)}
                                      disabled={budgetMode === 'start_end' || budgetMode === 'start_hours' || budgetMode === 'end_hours'}
                                    />
                                    <span style={{ position: 'absolute', right: 40, top: 9, fontSize: 12, color: 'var(--text-tertiary)', pointerEvents: 'none' }}>giorni</span>
                                  </div>
                                </div>
                                <div className="input-group">
                                  <label>Durata in Ore (Budget Lavoro)</label>
                                  <div style={{ position: 'relative' }}>
                                    <input
                                      type="number"
                                      min="0.5"
                                      step="0.5"
                                      className="input"
                                      style={{ fontWeight: 600, color: 'var(--success)', paddingRight: '60px', opacity: (budgetMode === 'start_days' || budgetMode === 'end_days') ? 0.6 : 1 }}
                                      value={taskForm.planned_hours}
                                      onChange={(e) => handlePlannedHoursChange(e.target.value)}
                                      disabled={budgetMode === 'start_days' || budgetMode === 'end_days'}
                                    />
                                    <span style={{ position: 'absolute', right: 40, top: 9, fontSize: 12, color: 'var(--text-tertiary)', pointerEvents: 'none' }}>ore</span>
                                  </div>
                                </div>
                              </div>

                              {taskForm.workers && taskForm.workers.length > 0 && taskForm.start_date && (
                                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
                                  <h4 style={{ marginBottom: 6, fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                    Calendario Ferie Addetti
                                  </h4>
                                  <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: 10 }}>
                                    Seleziona i giorni da saltare (ferie o permessi). La durata della fase si estenderà automaticamente.
                                  </p>
                                  <MultiDatePicker
                                    startDate={taskForm.start_date}
                                    allVacations={allVacations}
                                    workers={taskForm.workers}
                                    excludedDates={taskForm.excluded_dates || []}
                                    onChange={(newExcluded) => {
                                      setTaskForm(prev => {
                                        let updates = { excluded_dates: newExcluded };

                                        if (budgetMode === 'start_end') {
                                          const days = countWorkingDays(prev.start_date, prev.end_date, newExcluded);
                                          updates.duration_days = days;
                                          updates.planned_hours = days * 8.0;
                                        } else {
                                          const newDays = Math.max(1, Number(prev.duration_days) || 1);
                                          if (budgetMode === 'end_days' || budgetMode === 'end_days_hours' || budgetMode === 'end_hours') {
                                            updates.start_date = subtractWorkingDays(prev.end_date || new Date(), newDays, newExcluded);
                                          } else {
                                            updates.end_date = addWorkingDays(prev.start_date || new Date(), newDays, newExcluded);
                                          }
                                        }

                                        return { ...prev, ...updates };
                                      });
                                    }}
                                  />
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* MODAL FOOTER */}
                  <div className="modal-footer" style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '16px 28px',
                    borderTop: '1px solid var(--border-subtle)',
                    background: 'var(--bg-secondary)',
                    margin: 0,
                    flexShrink: 0
                  }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      {editingTask && (user?.role === 'admin' || user?.role === 'editor') && (
                        <>
                          <button
                            type="button"
                            className="btn btn-danger"
                            onClick={async () => {
                              setShowTaskModal(false);
                              await handleTaskDelete(editingTask.id);
                            }}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                            title={isMilestone ? "Elimina milestone" : "Elimina fase"}
                          >
                            <AppIcon name="trash" size={15} />
                            <span>{isMilestone ? 'Elimina Milestone' : 'Elimina Fase'}</span>
                          </button>

                          <button
                            type="button"
                            className="btn"
                            onClick={async () => {
                              const success = await handleToggleTaskCompleted(editingTask, isTaskCompleted(editingTask));
                              if (success) {
                                setShowTaskModal(false);
                              }
                            }}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              background: isTaskCompleted(editingTask) ? 'var(--bg-tertiary)' : '#10b981',
                              color: isTaskCompleted(editingTask) ? 'var(--text-primary)' : '#ffffff',
                              border: isTaskCompleted(editingTask) ? '1px solid var(--border-default)' : '1px solid #059669',
                              fontWeight: 600
                            }}
                            title={isTaskCompleted(editingTask) ? "Riapri fase (segna in corso)" : "Segna come completata"}
                          >
                            <AppIcon name={isTaskCompleted(editingTask) ? "undo" : "check"} size={15} />
                            <span>{isTaskCompleted(editingTask) ? 'Riapri Fase' : (isMilestone ? 'Completa Milestone' : 'Completa Fase')}</span>
                          </button>
                        </>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <button type="button" className="btn btn-secondary" onClick={() => setShowTaskModal(false)}>
                        Annulla
                      </button>
                      <button type="submit" className="btn btn-primary" disabled={isOverBudget}>
                        {editingTask ? 'Salva Modifiche' : 'Aggiungi Fase'}
                      </button>
                    </div>
                  </div>
                </form>
              );
            })()}

            {taskModalTab === 'checklist' && editingTask && (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', padding: '20px 28px' }}>
                <TaskChecklist projectId={id} taskId={editingTask.id} />
              </div>
            )}

            {taskModalTab === 'commenti' && editingTask && (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', padding: '20px 28px' }}>
                <TaskComments projectId={id} taskId={editingTask.id} currentUser={user} />
              </div>
            )}

            {taskModalTab === 'consuntivo' && editingTask && selectedTaskForHours && (() => {
              const plannedDates = getAssignedDatesForTask(selectedTaskForHours);
              const datesSet = new Set([...plannedDates, ...modalExtraDates]);
              Object.values(actualHoursMap).forEach(workerMap => {
                if (workerMap && typeof workerMap === 'object') {
                  Object.keys(workerMap).forEach(dKey => {
                    if (dKey !== '__extra__' && /^\d{4}-\d{2}-\d{2}$/.test(dKey) && workerMap[dKey] !== '' && workerMap[dKey] !== undefined && workerMap[dKey] !== null) {
                      datesSet.add(dKey);
                    }
                  });
                }
              });
              const dates = Array.from(datesSet).sort();
              const plannedSet = new Set(plannedDates);

              const assignedWorkers = Array.isArray(selectedTaskForHours.workers) && selectedTaskForHours.workers.length > 0
                ? selectedTaskForHours.workers
                : ['Addetto Generico'];
              const allWorkersSet = new Set(assignedWorkers);
              Object.keys(actualHoursMap).forEach(w => {
                if (w !== '__extra__') allWorkersSet.add(w);
              });
              const workers = Array.from(allWorkersSet);

              const isCustomDates = selectedTaskForHours.budget_mode === 'custom_dates';
              let customDatesList = [];
              if (isCustomDates) {
                let cList = selectedTaskForHours.custom_dates;
                if (typeof cList === 'string') {
                  try { cList = JSON.parse(cList); } catch (e) { cList = []; }
                }
                if (Array.isArray(cList)) {
                  customDatesList = cList.map(item => typeof item === 'string' ? { date: item, hours: 8 } : { date: item.date, hours: Number(item.hours) || 8 });
                }
              }

              const oreGgTotale = plannedDates.length > 0 ? workers.reduce((acc, w) => {
                const wAssigned = (selectedTaskForHours.worker_hours && selectedTaskForHours.worker_hours[w] !== undefined && selectedTaskForHours.worker_hours[w] !== '')
                  ? Number(selectedTaskForHours.worker_hours[w])
                  : (assignedWorkers.includes(w) ? (Number(selectedTaskForHours.planned_hours || 8) / assignedWorkers.length) : 0);
                return acc + (wAssigned / plannedDates.length);
              }, 0) : (Number(selectedTaskForHours.planned_hours || 8));

              return (
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, padding: '16px 24px', overflow: 'hidden' }}>
                  {/* Sottotitolo & Barra azioni date */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
                    <div>
                      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                        Fase: <strong style={{ color: 'var(--accent-500)' }}>{selectedTaskForHours.text}</strong> |{' '}
                        Ore previste: <strong>{selectedTaskForHours.planned_hours || 8}h</strong>
                        {user?.role !== 'admin' && (
                          <span style={{ marginLeft: 10, fontSize: 11, color: 'var(--text-tertiary)', background: 'var(--bg-tertiary)', padding: '2px 8px', borderRadius: 6 }}>
                            Puoi modificare solo le tue ore
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {/* Date picker per data specifica */}
                      <div
                        title="Clicca per scegliere una data specifica da aggiungere"
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          background: specificExtraDate ? 'var(--bg-tertiary)' : 'transparent',
                          border: `1px solid ${specificExtraDate ? 'var(--border-default)' : 'transparent'}`,
                          borderRadius: 8, padding: '4px 10px',
                          opacity: specificExtraDate ? 1 : 0.6,
                          transition: 'opacity 0.2s, background 0.2s, border-color 0.2s',
                          cursor: 'pointer',
                        }}
                        onMouseEnter={e => { if (!specificExtraDate) e.currentTarget.style.opacity = '0.9'; }}
                        onMouseLeave={e => { if (!specificExtraDate) e.currentTarget.style.opacity = '0.6'; }}
                      >
                        <AppIcon name="calendar" size={14} style={{ color: specificExtraDate ? 'var(--accent-500)' : 'var(--text-muted)', flexShrink: 0 }} />
                        <input
                          type="date"
                          value={specificExtraDate}
                          onChange={e => {
                            const val = e.target.value;
                            if (!val) return;
                            handleSpecificDateChange(val);
                          }}
                          style={{ border: 'none', background: 'transparent', fontSize: '0.82rem', color: 'var(--text-primary)', outline: 'none', cursor: 'pointer', width: specificExtraDate ? 'auto' : 100 }}
                          title="Scegli una data specifica da aggiungere — si inserisce subito"
                        />
                        {!specificExtraDate && <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Aggiungi data specifica</span>}
                      </div>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={handleAddExtraDayToModal}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', fontWeight: 600 }}
                        title="Aggiungi il prossimo giorno lavorativo dopo l'ultimo presente"
                      >
                        <AppIcon name="plus" size={14} />Aggiungi giorno extra in coda
                      </button>
                      {modalExtraDates.length > 0 && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={handleRemoveLastExtraDay}
                          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', fontWeight: 600, color: '#ef4444' }}
                          title="Rimuovi l'ultimo giorno extra aggiunto"
                        >
                          <AppIcon name="trash" size={14} />Rimuovi giorno
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Tabella Consuntivo scrollabile */}
                  <div style={{ flex: 1, overflowX: 'auto', overflowY: 'auto', minHeight: 280, border: '1px solid var(--border-default)', borderRadius: 8 }}>
                    <table className="ore-grid-table">
                      <thead>
                        <tr>
                          <th style={{ minWidth: 140, textAlign: 'left' }}>Addetto / Giorno</th>
                          {dates.map(d => {
                            const dateObj = new Date(d + 'T00:00:00');
                            const isFestivo = isWeekendOrHoliday(dateObj);
                            const shortDay = dateObj.toLocaleDateString('it-IT', { weekday: 'short' });
                            const dayName = shortDay.charAt(0).toUpperCase() + shortDay.slice(1);

                            return (
                              <th key={d} style={{ minWidth: 88, background: !plannedSet.has(d) ? 'rgba(239, 68, 68, 0.08)' : (isFestivo ? '#fef08a' : undefined) }}>
                                <span style={{ display: 'block', fontSize: '0.8rem', fontWeight: 700, color: isFestivo ? '#b45309' : 'var(--text-primary)', marginBottom: '2px' }}>
                                  {dayName}
                                </span>
                                {d.split('-')[2]}/{d.split('-')[1]}<br />
                                {!plannedSet.has(d) && (
                                  <span style={{ fontSize: 11, fontWeight: 400, color: '#ef4444' }}>
                                    Extra
                                  </span>
                                )}
                              </th>
                            );
                          })}
                          <th style={{ minWidth: 140 }}>Totale Addetto</th>
                        </tr>
                      </thead>
                      <tbody>
                        {workers.map(w => {
                          let totW = 0;
                          const assignedH = (selectedTaskForHours.worker_hours && selectedTaskForHours.worker_hours[w] !== undefined && selectedTaskForHours.worker_hours[w] !== '')
                            ? Number(selectedTaskForHours.worker_hours[w])
                            : null;
                          const targetH = assignedH !== null ? assignedH : (assignedWorkers.includes(w) ? Number((Number(selectedTaskForHours.planned_hours || 8) / assignedWorkers.length).toFixed(1)) : 0);

                          const activeDates = dates.filter(d => {
                            if (!plannedSet.has(d)) return false;
                            if (allVacations.some(v => v.username === w && d >= v.start_date && d <= v.end_date)) return false;
                            return true;
                          });

                          const defaultWorkerDailyTarget = activeDates.length > 0 ? (targetH / activeDates.length) : 0;

                          const isCurrentUser = (w === user?.username || w === (user?.full_name || user?.username));
                          return (
                            <tr key={w} style={isCurrentUser ? { background: 'rgba(59,130,246,0.10)', outline: '2px solid rgba(59,130,246,0.35)', outlineOffset: '-2px', borderRadius: 8 } : {}}>
                              <td style={{ textAlign: 'left', fontWeight: isCurrentUser ? 800 : 600, color: isCurrentUser ? 'var(--accent-400)' : undefined }}>
                                <span className="inline-detail-row"><AppIcon name="user" size={13} />{w}{isCurrentUser ? ' (tu)' : ''}</span>
                              </td>
                              {dates.map(d => {
                                const val = (actualHoursMap[w] && actualHoursMap[w][d]) || '';
                                totW += Number(val) || 0;
                                const isHoliday = allVacations.some(v => v.username === w && d >= v.start_date && d <= v.end_date);
                                const isExtra = !plannedSet.has(d);
                                const isActiveDay = !isExtra && !isHoliday;

                                let dayPrevHours = 0;
                                if (isActiveDay) {
                                  if (isCustomDates) {
                                    const cItem = customDatesList.find(c => c.date === d);
                                    if (cItem && cItem.hours !== undefined) {
                                      const totalCustomTaskH = customDatesList.reduce((acc, it) => acc + (Number(it.hours) || 8), 0);
                                      if (totalCustomTaskH > 0 && targetH > 0) {
                                        dayPrevHours = (cItem.hours * targetH) / totalCustomTaskH;
                                      } else {
                                        dayPrevHours = assignedWorkers.length > 0 ? (cItem.hours / assignedWorkers.length) : cItem.hours;
                                      }
                                    } else {
                                      dayPrevHours = defaultWorkerDailyTarget;
                                    }
                                  } else {
                                    dayPrevHours = defaultWorkerDailyTarget;
                                  }
                                }

                                return (
                                  <td key={d}>
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                                      <input
                                        type="number"
                                        step="0.5"
                                        min="0"
                                        max="24"
                                        className="ore-input"
                                        style={isHoliday ? { backgroundColor: '#fef08a' } : {}}
                                        disabled={user?.role !== 'admin' && w !== user?.username && w !== (user?.full_name || user?.username)}
                                        value={val}
                                        placeholder={`${dayPrevHours.toFixed(1)}h`}
                                        onChange={(e) => {
                                          const newVal = e.target.value;
                                          setActualHoursMap(prev => {
                                            const next = { ...prev };
                                            next[w] = { ...(next[w] || {}), [d]: newVal };
                                            return next;
                                          });
                                        }}
                                      />
                                      {isHoliday && <span style={{ fontSize: '0.65rem', color: '#b45309', fontWeight: 'bold' }}>Ferie</span>}
                                      {!isHoliday && (
                                        <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-tertiary)' }}>
                                          ({dayPrevHours.toFixed(1)}h prev)
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                );
                              })}
                              <td style={{ fontWeight: 700 }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                                  <span style={{ color: 'var(--accent-500)' }}>{totW} h</span>
                                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' }}>/ {targetH} h prev</span>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Barra Totali & Bottoni Footer */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, background: 'var(--bg-primary)', padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border-color)', flexWrap: 'wrap', gap: 12 }}>
                    <div>
                      {(() => {
                        const tempTask = {
                          ...selectedTaskForHours,
                          actual_hours: actualHoursMap
                        };
                        const totAll = calculateTaskEffHours(tempTask);
                        const st = computeStato(tempTask);
                        const plannedH = Number(selectedTaskForHours.planned_hours || 8);
                        const isModalCompleted = isTaskCompleted(tempTask);
                        return (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 14, color: 'var(--text-primary)', fontWeight: 600 }}>
                              Totale consuntivato finora: <strong style={{ color: 'var(--accent-500)' }}>{totAll} h</strong> / {plannedH} h prev
                            </span>
                            {st === 'ok' && <span className="semaforo-ok"><span className="status-dot completed" />Stato regolare</span>}
                            {st === 'attenzione' && <span className="semaforo-attenzione"><span className="status-dot open" />Stato attenzione</span>}
                            {st === 'ritardo_ferie' && <span className="semaforo-ritardo"><span className="status-dot danger" />Rischio ritardo (ferie)</span>}
                            {st === 'ritardo' && <span className="semaforo-ritardo"><span className="status-dot danger" />Stato ritardo</span>}
                            {st === 'sforamento' && <span className="semaforo-ritardo" style={{ background: 'rgba(239, 68, 68, 0.18)', color: '#ef4444', border: '1px solid #dc2626', padding: '3px 10px', borderRadius: '12px', fontWeight: 700 }}><span className="status-dot danger" />Sforamento ore</span>}
                            {st === 'mancata_consuntivazione' && <span className="semaforo-mancata-consuntivazione"><span className="status-dot" style={{ background: '#8b5cf6' }} />Mancata consuntivazione</span>}
                            {isModalCompleted && (
                              <span style={{ background: 'rgba(16, 185, 129, 0.18)', color: '#10b981', padding: '3px 10px', borderRadius: '12px', fontWeight: 600, fontSize: '0.82rem', border: '1px solid #059669' }}>
                                ✓ Fase Completata
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <button
                        type="button"
                        className={`btn ${Number(selectedTaskForHours.completed) === 1 ? '' : 'btn-secondary'}`}
                        style={{
                          marginRight: 6,
                          borderColor: Number(selectedTaskForHours.completed) === 1 ? '#10b981' : undefined,
                          color: Number(selectedTaskForHours.completed) === 1 ? '#10b981' : undefined,
                          background: Number(selectedTaskForHours.completed) === 1 ? 'rgba(16, 185, 129, 0.1)' : undefined,
                          display: 'flex', alignItems: 'center', gap: 6,
                          fontWeight: 600,
                          fontSize: '0.85rem'
                        }}
                        onClick={() => {
                          const isCurrentlyCompleted = Number(selectedTaskForHours.completed) === 1;
                          handleToggleTaskCompleted(selectedTaskForHours, isCurrentlyCompleted).then((success) => {
                            if (success) {
                              setSelectedTaskForHours(prev => ({ ...prev, completed: isCurrentlyCompleted ? -1 : 1 }));
                              setEditingTask(prev => ({ ...prev, completed: isCurrentlyCompleted ? -1 : 1 }));
                            }
                          });
                        }}
                      >
                        {Number(selectedTaskForHours.completed) === 1 ? (
                          <><AppIcon name="check" size={15} /> Fase Completata</>
                        ) : (
                          <><AppIcon name="checkCircle" size={15} /> Segna Completata</>
                        )}
                      </button>
                      <button type="button" className="btn btn-secondary" onClick={() => setShowTaskModal(false)}>
                        Annulla
                      </button>
                      <button type="button" className="btn btn-primary" onClick={handleSaveOreModal}>
                        Salva Consuntivo Ore
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Modale Modifica Dati Commessa */}
      {showEditProjectModal && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 1200, width: '95vw', maxHeight: '92vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header" style={{ marginBottom: 16 }}>
              <h2>Modifica Dati Commessa</h2>
              <button className="btn-ghost btn-icon" onClick={() => setShowEditProjectModal(false)} aria-label="Chiudi">
                <AppIcon name="close" />
              </button>
            </div>
            <form onSubmit={handleSaveProject}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(460px, 1fr))', gap: 32, alignItems: 'start' }}>
                {/* COLONNA SINISTRA: Informazioni e Tempistiche */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ display: 'flex', gap: 12 }}>
                    <div className="input-group" style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="edit-proj-code">Codice Commessa *</label>
                      <input
                        id="edit-proj-code"
                        className="input"
                        value={projectForm.code}
                        onChange={(e) => setProjectForm({ ...projectForm, code: e.target.value })}
                        required
                        placeholder="es. UT-COMM"
                      />
                    </div>
                    <div className="input-group" style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="edit-proj-client">Cliente *</label>
                      <input
                        id="edit-proj-client"
                        className="input"
                        value={projectForm.client}
                        onChange={(e) => setProjectForm({ ...projectForm, client: e.target.value })}
                        required
                        placeholder="es. HiWay s.r.l."
                      />
                    </div>
                  </div>

                  <div className="input-group">
                    <label htmlFor="edit-proj-name">Titolo Commessa *</label>
                    <input
                      id="edit-proj-name"
                      className="input"
                      value={projectForm.name}
                      onChange={(e) => setProjectForm({ ...projectForm, name: e.target.value })}
                      required
                      placeholder="es. Lancio ERP e HiPlan Q3"
                    />
                  </div>

                  <div style={{ display: 'flex', gap: 12 }}>
                    <div className="input-group" style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="edit-proj-start">Data di Inizio</label>
                      <input
                        id="edit-proj-start"
                        type="date"
                        className="input"
                        value={projectForm.start_date}
                        onChange={(e) => setProjectForm({ ...projectForm, start_date: e.target.value })}
                      />
                    </div>
                    <div className="input-group" style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="edit-proj-end">Data di Fine</label>
                      <input
                        id="edit-proj-end"
                        type="date"
                        className="input"
                        value={projectForm.end_date}
                        onChange={(e) => setProjectForm({ ...projectForm, end_date: e.target.value })}
                      />
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 12 }}>
                    <div className="input-group" style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="edit-proj-color">Colore Identificativo</label>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          id="edit-proj-color"
                          type="color"
                          value={projectForm.color}
                          onChange={(e) => setProjectForm({ ...projectForm, color: e.target.value })}
                          style={{ width: 44, height: 38, padding: 2, borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', cursor: 'pointer', flexShrink: 0 }}
                        />
                        <input
                          className="input"
                          value={projectForm.color}
                          onChange={(e) => setProjectForm({ ...projectForm, color: e.target.value })}
                          placeholder="#185FA5"
                          style={{ flex: 1, minWidth: 0 }}
                        />
                      </div>
                    </div>
                    <div className="input-group" style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="edit-proj-status">Stato Commessa</label>
                      <select
                        id="edit-proj-status"
                        className="input"
                        value={projectForm.status}
                        onChange={(e) => setProjectForm({ ...projectForm, status: e.target.value })}
                      >
                        {STATUS_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="input-group">
                    <label htmlFor="edit-proj-responsible">Referente di Commessa</label>
                    <select
                      id="edit-proj-responsible"
                      className="input"
                      value={projectForm.responsible_id || ''}
                      onChange={(e) => setProjectForm({ ...projectForm, responsible_id: e.target.value })}
                    >
                      <option value="">-- Nessun referente predefinito --</option>
                      {usersList.map(u => (
                        <option key={u.id} value={u.id}>{u.full_name || u.username} ({u.username})</option>
                      ))}
                    </select>
                  </div>

                  <div className="input-group">
                    <label htmlFor="edit-proj-desc">Descrizione / Note</label>
                    <textarea
                      id="edit-proj-desc"
                      className="input"
                      rows={3}
                      value={projectForm.description}
                      onChange={(e) => setProjectForm({ ...projectForm, description: e.target.value })}
                      placeholder="Dettagli e obiettivo della commessa..."
                      style={{ resize: 'vertical' }}
                    />
                  </div>
                </div>

                {/* COLONNA DESTRA: Tipologia Commessa e Addetti Team */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {/* Tipologia Commessa */}
                  <div className="input-group">
                    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4 }}>
                      <span style={{ fontWeight: 600 }}>Tipologia Commessa</span>
                      <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                        ATEX e Alimentare selezionabili insieme
                      </span>
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(125px, 1fr))', gap: 8, marginTop: 4 }}>
                      {/* Opzione STANDARD */}
                      <div
                        onClick={() => setProjectForm({ ...projectForm, is_atex: false, is_alimentare: false })}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '10px 12px',
                          borderRadius: 10,
                          cursor: 'pointer',
                          border: (!projectForm.is_atex && !projectForm.is_alimentare) ? '2px solid #3b82f6' : '1px solid var(--border-color)',
                          background: (!projectForm.is_atex && !projectForm.is_alimentare) ? 'rgba(59, 130, 246, 0.12)' : 'var(--bg-tertiary)',
                          color: (!projectForm.is_atex && !projectForm.is_alimentare) ? '#2563eb' : 'var(--text-primary)',
                          transition: 'all 0.15s ease',
                          userSelect: 'none'
                        }}
                      >
                        <input
                          type="radio"
                          checked={!projectForm.is_atex && !projectForm.is_alimentare}
                          onChange={() => setProjectForm({ ...projectForm, is_atex: false, is_alimentare: false })}
                          style={{ accentColor: '#3b82f6', cursor: 'pointer' }}
                        />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>Standard</div>
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Nessun vincolo spec.</div>
                        </div>
                      </div>

                      {/* Opzione ATEX */}
                      <div
                        onClick={() => setProjectForm({ ...projectForm, is_atex: !projectForm.is_atex })}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '10px 12px',
                          borderRadius: 10,
                          cursor: 'pointer',
                          border: projectForm.is_atex ? '2px solid #f59e0b' : '1px solid var(--border-color)',
                          background: projectForm.is_atex ? 'rgba(245, 158, 11, 0.15)' : 'var(--bg-tertiary)',
                          color: projectForm.is_atex ? '#d97706' : 'var(--text-primary)',
                          transition: 'all 0.15s ease',
                          userSelect: 'none'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(projectForm.is_atex)}
                          onChange={(e) => setProjectForm({ ...projectForm, is_atex: e.target.checked })}
                          style={{ accentColor: '#f59e0b', cursor: 'pointer' }}
                        />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>ATEX</div>
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Rischio esplosione</div>
                        </div>
                      </div>

                      {/* Opzione ALIMENTARE */}
                      <div
                        onClick={() => setProjectForm({ ...projectForm, is_alimentare: !projectForm.is_alimentare })}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '10px 12px',
                          borderRadius: 10,
                          cursor: 'pointer',
                          border: projectForm.is_alimentare ? '2px solid #10b981' : '1px solid var(--border-color)',
                          background: projectForm.is_alimentare ? 'rgba(16, 185, 129, 0.15)' : 'var(--bg-tertiary)',
                          color: projectForm.is_alimentare ? '#059669' : 'var(--text-primary)',
                          transition: 'all 0.15s ease',
                          userSelect: 'none'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(projectForm.is_alimentare)}
                          onChange={(e) => setProjectForm({ ...projectForm, is_alimentare: e.target.checked })}
                          style={{ accentColor: '#10b981', cursor: 'pointer' }}
                        />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>Alimentare</div>
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Settore Food Grade</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Addetti della Commessa */}
                  <div className="input-group">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <label style={{ margin: 0 }}>Addetti della Commessa (Multi-selezione)</label>
                      <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                        {projectForm.assigned_workers?.length || 0} selezionati
                      </span>
                    </div>
                    <div style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 8,
                      padding: 12,
                      borderRadius: 10,
                      border: '1px solid var(--border-color)',
                      background: 'var(--bg-tertiary)',
                      maxHeight: 250,
                      overflowY: 'auto'
                    }}>
                      {usersList.map(u => {
                        const selected = (projectForm.assigned_workers || []).includes(u.username);
                        const wDept = u.department;
                        const deptColor = wDept ? (DEPT_OPTIONS.find(d => d.value === wDept)?.color || '#3b82f6') : '#3b82f6';
                        return (
                          <button
                            key={u.id}
                            type="button"
                            onClick={() => toggleProjectWorkerSelection(u.username)}
                            style={{
                              padding: '6px 12px',
                              borderRadius: 20,
                              border: selected ? `2px solid ${deptColor}` : '1px solid var(--border-color)',
                              background: selected ? `${deptColor}26` : 'var(--bg-primary)',
                              color: selected ? deptColor : 'var(--text-secondary)',
                              fontSize: 12.5,
                              cursor: 'pointer',
                              fontWeight: selected ? 600 : 400,
                              transition: 'all 0.15s ease'
                            }}
                          >
                            {selected ? '✓ ' : '+ '}{u.full_name || u.username}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              <div className="modal-actions" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
                {(user?.role === 'admin' || user?.role === 'editor') ? (
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={async () => {
                      if (!window.confirm(`Vuoi spostare la commessa "${project?.name || project?.code}" nel cestino? Verrà conservata per 90 giorni prima dell'eliminazione definitiva.`)) return;
                      try {
                        await api.delete(`/projects/${id}`);
                        toast.success('Commessa spostata nel cestino');
                        navigate('/projects');
                      } catch {
                        toast.error("Errore nello spostamento nel cestino");
                      }
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#ef4444', color: '#fff' }}
                  >
                    <AppIcon name="trash" size={14} /> Elimina Commessa
                  </button>
                ) : <div />}
                <div style={{ display: 'flex', gap: 12 }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setShowEditProjectModal(false)}>
                    Annulla
                  </button>
                  <button type="submit" className="btn btn-primary">
                    Salva Modifiche
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {activeTab === 'activity_log' && (
        <ActivityLogPanel projectId={id} />
      )}
      {/* MODAL ELIMINA DIPENDENZA */}
      {linkToDelete && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 450 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Elimina dipendenza</h2>
              <button className="btn-ghost btn-icon" onClick={() => setLinkToDelete(null)} aria-label="Chiudi">
                <AppIcon name="close" />
              </button>
            </div>
            <div style={{ padding: '24px 20px', textAlign: 'center' }}>
              <p style={{ margin: 0, fontSize: 16, color: 'var(--text-primary)' }}>
                Sei sicuro di voler eliminare questa dipendenza tra le fasi?
              </p>
            </div>
            <div className="modal-footer" style={{ padding: '16px 20px', display: 'flex', justifyContent: 'flex-end', gap: 12, borderTop: '1px solid var(--border-color)' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setLinkToDelete(null)}>Annulla</button>
              <button type="button" className="btn btn-danger" onClick={() => handleLinkDelete(linkToDelete, true)}>Elimina</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
