import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../context/ToastContext';
import api from '../api/client';
import { listRichieste } from '../api/richiesteCommerciali';
import { useAuth } from '../context/AuthContext';
import TimelineView from '../components/calendar/TimelineView';
import AppIcon from '../components/ui/AppIcon';
import { useWeather, WeatherModal } from '../components/ui/WeatherDateWidget';
import { Sun } from 'lucide-react';
import './DashboardPage.css';
import { STATUS_LABELS_IT } from '../utils/statusLabels';



export default function DashboardPage() {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const weatherState = useWeather();
  const { currentInfo, city, isModalOpen, setIsModalOpen, loadingWeather, now } = weatherState;

  const [timelineYear, setTimelineYear] = useState(() => new Date().getFullYear());
  const [timelineMonth, setTimelineMonth] = useState(() => new Date().getMonth());
  const [projects, setProjects] = useState([]);
  const [projectsWithTasks, setProjectsWithTasks] = useState([]);
  const [assignedTodos, setAssignedTodos] = useState([]);
  const [myTasksToday, setMyTasksToday] = useState([]);
  const [quickLogHours, setQuickLogHours] = useState({});
  const [vacations, setVacations] = useState([]);
  const [recoveryItems, setRecoveryItems] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [richiesteCommerciali, setRichiesteCommerciali] = useState([]);
  const [notes, setNotes] = useState([]);
  const [panel1Tab, setPanel1Tab] = useState(null);
  const [panel2Tab, setPanel2Tab] = useState(null);
  const [dismissedKeys, setDismissedKeys] = useState(
    () => new Set(JSON.parse(localStorage.getItem('recovery_dismissed') || '[]'))
  );
  const [globalBanners, setGlobalBanners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [unloggedHoursData, setUnloggedHoursData] = useState({ unlogged_hours: 0, count: 0, alerts: [] });
  const [showUnloggedModal, setShowUnloggedModal] = useState(false);

  const MONTH_NAMES_IT = [
    'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
    'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'
  ];

  function prevMonth() {
    if (timelineMonth === 0) {
      setTimelineMonth(11);
      setTimelineYear(y => y - 1);
    } else {
      setTimelineMonth(m => m - 1);
    }
  }

  function nextMonth() {
    if (timelineMonth === 11) {
      setTimelineMonth(0);
      setTimelineYear(y => y + 1);
    } else {
      setTimelineMonth(m => m + 1);
    }
  }

  function goToToday() {
    const today = new Date();
    setTimelineYear(today.getFullYear());
    setTimelineMonth(today.getMonth());
  }

  useEffect(() => {
    loadData();

    const handleFocus = () => {
      loadData();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadData();
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  async function loadData() {
    try {
      const [projRes, todosRes, tasksRes, vacRes, recoveryRes, bannerRes, ticketsRes, rcRes, notesRes, unloggedRes] = await Promise.all([
        api.get('/projects'),
        api.get('/todos'),
        api.get('/users/me/tasks/today'),
        api.get('/vacations/me').catch(() => ({ data: [] })),
        api.get('/vacations/me/recovery').catch(() => ({ data: [] })),
        api.get('/settings/global-banner').catch(() => ({ data: [] })),
        api.get('/tickets').catch(() => ({ data: [] })),
        listRichieste().catch(() => []),
        api.get('/notes').catch(() => ({ data: [] })),
        api.get('/users/me/unlogged-hours').catch(() => ({ data: { unlogged_hours: 0, count: 0, alerts: [] } })),
      ]);
      setProjects(projRes.data || []);
      if (Array.isArray(bannerRes.data)) {
        setGlobalBanners(bannerRes.data);
      }
      setUnloggedHoursData(unloggedRes?.data || { unlogged_hours: 0, count: 0, alerts: [] });
      const todosData = todosRes.data || [];
      const openAssigned = todosData.filter(t => !t.is_completed && t.assignees?.includes(user?.id));
      setAssignedTodos(openAssigned);
      setMyTasksToday(tasksRes.data || []);

      const initHours = {};
      (tasksRes.data || []).forEach(t => {
        initHours[t.id] = t.actual_hours_today || t.expected_hours_today || '';
      });
      setQuickLogHours(initHours);

      setVacations(vacRes.data || []);
      setRecoveryItems(recoveryRes.data || []);
      setTickets(Array.isArray(ticketsRes.data) ? ticketsRes.data : []);
      setRichiesteCommerciali(Array.isArray(rcRes) ? rcRes : []);
      setNotes(Array.isArray(notesRes.data) ? notesRes.data : []);

      Promise.all(
        (projRes.data || []).map(async (p) => {
          try {
            const { data: gData } = await api.get(`/projects/${p.id}/gantt`);
            return { ...p, tasks: Array.isArray(gData.tasks) ? gData.tasks : [] };
          } catch {
            return { ...p, tasks: [] };
          }
        })
      ).then(fullData => {
        setProjectsWithTasks(fullData);
      });
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }

  async function handleQuickLog(task) {
    const val = quickLogHours[task.id];
    if (val === '' || isNaN(val)) {
      toast.error('Inserisci un valore numerico valido');
      return;
    }
    try {
      const dateStr = new Date().toISOString().split('T')[0];
      await api.post(`/projects/${task.project_id}/tasks/${task.id}/log-hours`, {
        date: dateStr,
        hours: parseFloat(val)
      });
      toast.success('Ore consuntivate con successo');
      loadData();
    } catch (e) {
      toast.error('Errore durante la consuntivazione delle ore');
      console.error(e);
    }
  }

  function getRecoveryKey(item) {
    return `${item.task_id}_${item.vacation_start}`;
  }

  function dismissRecoveryItem(e, item) {
    e.stopPropagation();
    const key = getRecoveryKey(item);
    setDismissedKeys(prev => {
      const next = new Set(prev);
      next.add(key);
      localStorage.setItem('recovery_dismissed', JSON.stringify([...next]));
      return next;
    });
  }

  const isPrivileged = user?.role === 'admin' || user?.role === 'editor';
  const relevantProjects = isPrivileged
    ? projects
    : projects.filter(p => p.is_assigned || p.owner_id === user?.id || p.responsible_id === user?.id || p.responsible_username === user?.username);

  const stats = {
    total: relevantProjects.length,
    active: relevantProjects.filter((p) => p.status === 'active').length,
    completed: relevantProjects.filter((p) => p.status === 'completed').length,
    planning: relevantProjects.filter((p) => p.status === 'planning').length,
  };

  const activeRelevantProjects = relevantProjects.filter((p) => p.status === 'active');
  const avgProgress = activeRelevantProjects.length > 0
    ? Math.round(activeRelevantProjects.reduce((acc, p) => acc + (p.progress || 0), 0) / activeRelevantProjects.length * 100)
    : 0;

  const timelineProjects = useMemo(() => {
    if (!projectsWithTasks.length) return [];
    return projectsWithTasks.filter(p => {
      if (!p.tasks) return false;
      return p.tasks.some(t => Array.isArray(t.workers) && t.workers.includes(user?.username));
    });
  }, [projectsWithTasks, user?.username]);

  // Formattazione data e ora per Box 1
  const todayFullDate = useMemo(() => {
    return now.toLocaleDateString('it-IT', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
  }, [now]);

  const timeFormatted = useMemo(() => {
    return now.toLocaleTimeString('it-IT', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [now]);

  // Box 3 e Box 4 personalizzati a seconda del reparto e ruolo
  const departmentBoxes = useMemo(() => {
    const role = user?.role || 'viewer';
    const dept = user?.department || (role === 'admin' ? 'admin' : 'ufficio_tecnico');

    const openTickets = tickets.filter(t => t.status !== 'Completato');
    const ticketsDaGestire = tickets.filter(t => t.status === 'Da gestire');

    const richiesteAperte = richiesteCommerciali.filter(r => r.stato === 'aperta');
    const richiesteInLavorazione = richiesteCommerciali.filter(r => r.stato === 'in_lavorazione');
    const richiesteMancaListino = richiesteCommerciali.filter(r => r.stato === 'manca_listino');
    const richiesteCompletate = richiesteCommerciali.filter(r => r.stato === 'completata');
    const richiesteInCorso = richiesteCommerciali.filter(r => r.stato !== 'completata');

    // Default boxes (Fallback / Generic / Ufficio Tecnico)
    let box3 = {
      label: 'Fasi operative oggi',
      value: myTasksToday.length,
      subtitle: `${myTasksToday.length === 1 ? '1 attività in carico' : `${myTasksToday.length} attività in carico`}`,
      detail: 'Apri calendario personale ↗',
      icon: 'gantt',
      themeClass: 'stat-custom-cyan',
      onClick: () => navigate('/personal-calendar'),
    };

    let box4 = {
      label: 'To-Do aperti',
      value: assignedTodos.length,
      subtitle: `${assignedTodos.length === 1 ? '1 checklist assegnata' : `${assignedTodos.length} checklist assegnate`}`,
      detail: 'Vai alle tue to-do ↗',
      icon: 'todo',
      themeClass: 'stat-custom-indigo',
      onClick: () => navigate('/todo'),
    };

    if (dept === 'commerciale') {
      box3 = {
        label: 'Richieste per preventivi',
        value: richiesteInCorso.length,
        subtitle: `${richiesteAperte.length} aperte · ${richiesteInLavorazione.length} in corso`,
        detail: 'Gestisci preventivi ↗',
        icon: 'tag',
        themeClass: 'stat-custom-orange',
        onClick: () => navigate('/richieste-commerciali'),
      };

      if (role === 'viewer') {
        box4 = {
          label: 'Commesse',
          value: stats.total,
          subtitle: `${stats.active} commesse attive`,
          detail: 'Consulta commesse ↗',
          icon: 'projects',
          themeClass: 'stat-custom-blue',
          onClick: () => navigate('/projects'),
        };
      } else {
        box4 = {
          label: 'Offerte pronte',
          value: richiesteCompletate.length,
          subtitle: `${richiesteMancaListino.length} in attesa listino prezzi`,
          detail: 'Visualizza preventivi completati ↗',
          icon: 'fileText',
          themeClass: 'stat-custom-green',
          onClick: () => navigate('/richieste-commerciali'),
        };
      }
    } else if (dept === 'acquisti') {
      box3 = {
        label: 'Richieste listini & prezzi',
        value: richiesteMancaListino.length,
        subtitle: `${richiesteInCorso.length} preventivi commerciali totali`,
        detail: 'Aggiorna quotazioni fornitori ↗',
        icon: 'briefcase',
        themeClass: 'stat-custom-amber',
        onClick: () => navigate('/richieste-commerciali'),
      };
      box4 = {
        label: 'To-Do & ordini acquisti',
        value: assignedTodos.length,
        subtitle: `${assignedTodos.length} task assegnati da completare`,
        detail: 'Gestisci le tue checklist ↗',
        icon: 'todo',
        themeClass: 'stat-custom-purple',
        onClick: () => navigate('/todo'),
      };
    } else if (dept === 'produzione') {
      box3 = {
        label: 'Lavorazioni oggi',
        value: myTasksToday.length,
        subtitle: `${myTasksToday.length} fasi in lavorazione oggi`,
        detail: 'Visualizza e consuntiva ore ↗',
        icon: 'active_projects',
        themeClass: 'stat-custom-emerald',
        onClick: () => navigate('/personal-calendar'),
      };
      box4 = {
        label: 'Segnalazioni & ticket',
        value: openTickets.length,
        subtitle: `${ticketsDaGestire.length} da gestire su ${openTickets.length} aperte`,
        detail: 'Apri registro segnalazioni ↗',
        icon: 'ticket',
        themeClass: 'stat-custom-rose',
        onClick: () => navigate('/tickets'),
      };
    } else if (dept === 'amministrazione') {
      box3 = {
        label: 'Commesse in corso',
        value: stats.active,
        subtitle: `Progresso medio aziendale: ${avgProgress}%`,
        detail: 'Monitora avanzamento commesse ↗',
        icon: 'projects',
        themeClass: 'stat-custom-blue',
        onClick: () => navigate('/projects'),
      };
      box4 = {
        label: 'Ferie & assenze',
        value: vacations.length,
        subtitle: `${vacations.length} richieste registrate a calendario`,
        detail: 'Apri calendario presenze ↗',
        icon: 'vacations',
        themeClass: 'stat-custom-purple',
        onClick: () => navigate('/personal-calendar'),
      };
    } else if (dept === 'ufficio_tecnico') {
      box3 = {
        label: 'Fasi operative oggi',
        value: myTasksToday.length,
        subtitle: `${myTasksToday.length} in programma oggi`,
        detail: 'Dettaglio agenda operativa ↗',
        icon: 'gantt',
        themeClass: 'stat-custom-cyan',
        onClick: () => navigate('/personal-calendar'),
      };
      box4 = {
        label: 'Checklist & To-Do',
        value: assignedTodos.length,
        subtitle: `${assignedTodos.length} to-do aperti assegnati`,
        detail: 'Vai alle tue checklist ↗',
        icon: 'todo',
        themeClass: 'stat-custom-indigo',
        onClick: () => navigate('/todo'),
      };
    } else if (role === 'admin') {
      box3 = {
        label: 'Ticket da gestire',
        value: ticketsDaGestire.length,
        subtitle: `${openTickets.length} ticket aperti totali`,
        detail: 'Apri centro assistenza & ticket ↗',
        icon: 'ticket',
        themeClass: 'stat-custom-rose',
        onClick: () => navigate('/tickets'),
      };
      box4 = {
        label: 'Commesse attive',
        value: stats.active,
        subtitle: `Progresso medio: ${avgProgress}% (${stats.total} totali)`,
        detail: 'Supervisiona tutte le commesse ↗',
        icon: 'active_projects',
        themeClass: 'stat-custom-teal',
        onClick: () => navigate('/projects'),
      };
    }

    let finalBox4 = box4;
    const unloggedHours = unloggedHoursData?.unlogged_hours || 0;
    const unloggedAlerts = unloggedHoursData?.alerts || [];
    if (unloggedHours > 0) {
      finalBox4 = {
        label: 'Ore da consuntivare',
        value: `${unloggedHours}h`,
        subtitle: `${unloggedAlerts.length} ${unloggedAlerts.length === 1 ? 'giornata / fase da registrare' : 'giornate / fasi da registrare'}`,
        detail: 'Clicca per visualizzare le ore mancanti per giorno e fase ↗',
        icon: 'clock',
        themeClass: 'stat-custom-rose',
        onClick: () => setShowUnloggedModal(true),
      };
    }

    return { box3, box4: finalBox4 };
  }, [user, tickets, richiesteCommerciali, myTasksToday, assignedTodos, stats, avgProgress, vacations, navigate, unloggedHoursData]);

  // Default dei tab per i due pannelli inferiori in base a mansione e reparto
  const defaultLeftTab = useMemo(() => {
    const dept = user?.department;
    if (dept === 'commerciale' || dept === 'acquisti') return 'preventivi';
    return 'commesse';
  }, [user?.department]);

  const defaultRightTab = useMemo(() => {
    const dept = user?.department;
    const role = user?.role;
    if (dept === 'produzione' || role === 'admin') return 'tickets';
    if (dept === 'commerciale' || dept === 'amministrazione') return 'note';
    return 'todos';
  }, [user?.department, user?.role]);

  const activeLeftTab = panel1Tab || defaultLeftTab;
  const activeRightTab = panel2Tab || defaultRightTab;

  const WeatherIcon = currentInfo ? currentInfo.icon : Sun;
  const unloggedHours = unloggedHoursData?.unlogged_hours || 0;

  if (loading) {
    return <div className="loading-screen"><div className="spinner" /></div>;
  }

  return (
    <div className="dashboard dashboard-shell animate-fadeIn">
      {globalBanners.map(banner => (
        <div key={banner.id} className={`dashboard-banner dashboard-banner-${banner.type || 'info'}`}>
          <span className="dashboard-banner-icon" aria-hidden="true"><AppIcon name="megaphone" size={19} /></span>
          <span className="dashboard-banner-content">
            <span className="dashboard-banner-label">Annuncio aziendale</span>
            <span>{banner.text}</span>
          </span>
        </div>
      ))}

      <div className="dashboard-hero">
        <div className="dashboard-welcome">
          <span className="dashboard-eyebrow">Workspace personale</span>
          <h1>Bentornato, {user?.full_name || user?.username}</h1>
          <p>Attività, scadenze e avanzamento in un unico colpo d'occhio.</p>
        </div>
      </div>

      {/* Griglia Statistiche Personalizzata */}
      <div className="stats-grid">
        {/* Box 1: Data e Ora (cliccando rimanda al calendario personale) */}
        <div
          className="stat-card stat-clock is-clickable"
          onClick={() => navigate('/personal-calendar')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate('/personal-calendar'); }}
          title="Clicca per aprire il calendario personale"
        >
          <div className="stat-icon" aria-hidden="true">
            <AppIcon name="calendar" size={18} />
          </div>
          <div className="stat-info">
            <span className="stat-label">Data e ora</span>
            <span className="stat-value stat-value--time">{timeFormatted}</span>
            <span className="stat-subtitle">{todayFullDate}</span>
          </div>
        </div>

        {/* Box 2: Meteo e Previsioni (cliccando apre il popup previsioni) */}
        <div
          className="stat-card stat-weather is-clickable"
          onClick={() => setIsModalOpen(true)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setIsModalOpen(true); }}
          title="Clicca per visualizzare le previsioni meteo della settimana"
        >
          <div className="stat-icon" aria-hidden="true">
            <WeatherIcon size={20} />
          </div>
          <div className="stat-info">
            <span className="stat-label">Meteo · {city?.name || 'Milano'}</span>
            <span className="stat-value">
              {currentInfo ? `${currentInfo.temp}°C` : (loadingWeather ? '...' : 'N.D.')}
            </span>
            <span className="stat-subtitle">
              {currentInfo ? `${currentInfo.label}` : 'Dati meteo in aggiornamento'}
            </span>
          </div>
        </div>

        {/* Box 3: Personalizzato per reparto e ruolo */}
        <div
          className={`stat-card ${departmentBoxes.box3.themeClass} is-clickable`}
          onClick={departmentBoxes.box3.onClick}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') departmentBoxes.box3.onClick(); }}
          title={departmentBoxes.box3.detail}
        >
          <div className="stat-icon" aria-hidden="true">
            <AppIcon name={departmentBoxes.box3.icon} size={18} />
          </div>
          <div className="stat-info">
            <span className="stat-label">{departmentBoxes.box3.label}</span>
            <span className="stat-value">{departmentBoxes.box3.value}</span>
            <span className="stat-subtitle">{departmentBoxes.box3.subtitle}</span>
          </div>
        </div>

        {/* Box 4: Personalizzato per reparto e ruolo */}
        <div
          className={`stat-card ${departmentBoxes.box4.themeClass} is-clickable`}
          onClick={departmentBoxes.box4.onClick}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') departmentBoxes.box4.onClick(); }}
          title={departmentBoxes.box4.detail}
        >
          <div className="stat-icon" aria-hidden="true">
            <AppIcon name={departmentBoxes.box4.icon} size={18} />
          </div>
          <div className="stat-info">
            <span className="stat-label">{departmentBoxes.box4.label}</span>
            <span className="stat-value">{departmentBoxes.box4.value}</span>
            <span className="stat-subtitle">{departmentBoxes.box4.subtitle}</span>
          </div>
        </div>
      </div>

      <section className="card dashboard-section dashboard-timeline-panel">
        <div className="dashboard-panel-header">
          <div className="dashboard-panel-title">
            <span className="dashboard-panel-icon calendar-icon" aria-hidden="true">
              <AppIcon name="calendar" size={13} />
            </span>
            <div>
              <h2>La tua timeline</h2>
              <p>{MONTH_NAMES_IT[timelineMonth]} {timelineYear} · attività assegnate</p>
            </div>
          </div>
          <div className="timeline-controls" aria-label="Navigazione timeline">
            <button
              type="button"
              onClick={prevMonth}
              className="btn btn-secondary btn-sm"
              aria-label="Mese precedente"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={goToToday}
              className="btn btn-primary btn-sm"
            >
              Oggi
            </button>
            <button
              type="button"
              onClick={nextMonth}
              className="btn btn-secondary btn-sm"
              aria-label="Mese successivo"
            >
              ›
            </button>
          </div>
        </div>
        <div className="dashboard-timeline-scroll">
          <TimelineView
            projects={timelineProjects}
            currYear={timelineYear}
            currMonth={timelineMonth}
            filterWorker={user?.username}
            onSelectProject={(proj) => navigate(`/projects/${proj.id}`)}
            vacations={vacations}
          />
        </div>
      </section>

      <div className="dashboard-grid">
        <section className="card dashboard-section dashboard-tasks-panel">
          <div className="dashboard-panel-header">
            <div className="dashboard-panel-title">
              <span className="dashboard-panel-icon task-icon" aria-hidden="true">✓</span>
              <div>
                <h2>I miei task di oggi</h2>
                <p>{myTasksToday.length} {myTasksToday.length === 1 ? 'attività pianificata' : 'attività pianificate'}</p>
              </div>
            </div>
            <button type="button" className="dashboard-link-btn" onClick={() => navigate('/calendar')}>
              Apri calendario <span aria-hidden="true">→</span>
            </button>
          </div>
          {myTasksToday.length === 0 ? (
            <div className="empty-state dashboard-empty-state">
              <div className="empty-state-icon">✓</div>
              <h3>Nessun task per oggi</h3>
              <p>La giornata è libera oppure le attività sono già completate.</p>
            </div>
          ) : (
            <div className="today-tasks-grid">
              {myTasksToday.map(task => (
                <div
                  key={task.id}
                  className="recent-project-item today-task-item"
                  style={{ cursor: 'default', display: 'flex', flexDirection: 'column', '--task-color': task.color || 'var(--primary-color)' }}
                >
                  <div style={{ cursor: 'pointer', marginBottom: '8px' }} onClick={() => navigate(`/projects/${task.project_id}`)}>
                    <div className="recent-project-info">
                      <span className="recent-project-name">{task.text}</span>
                      <span className="task-progress-label">{task.progress}%</span>
                    </div>
                    <div className="recent-project-meta">
                      <span>{task.project_name}</span>
                      {task.my_assigned_hours ? (
                        <span>{task.my_assigned_hours}h assegnate / {task.planned_hours}h</span>
                      ) : (
                        <span>{task.planned_hours}h pianificate</span>
                      )}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: 'auto', marginBottom: '8px' }}>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      className="form-input"
                      style={{ width: '80px', padding: '4px 8px', fontSize: '14px', height: '32px' }}
                      value={quickLogHours[task.id] !== undefined ? quickLogHours[task.id] : ''}
                      onChange={e => setQuickLogHours(prev => ({ ...prev, [task.id]: e.target.value }))}
                      placeholder="Ore"
                    />
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ padding: '4px 12px', fontSize: '14px', height: '32px', display: 'flex', alignItems: 'center', gap: '4px' }}
                      onClick={(e) => { e.stopPropagation(); handleQuickLog(task); }}
                      disabled={task.actual_hours_today !== undefined && String(task.actual_hours_today) === String(quickLogHours[task.id]) && String(quickLogHours[task.id]) !== ''}
                    >
                      <AppIcon name="check" size={14} />
                      {task.actual_hours_today ? 'Aggiorna' : 'Conferma'}
                    </button>
                  </div>

                  <div className="progress-bar">
                    <div
                      className="progress-bar-fill"
                      style={{ width: `${task.progress}%`, background: task.progress === 100 ? 'var(--success)' : undefined }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Pannello Sinistro: Commesse o Preventivazione */}
        <section className="card dashboard-section dashboard-list-panel">
          <div className="dashboard-panel-header">
            <div className="dashboard-panel-title">
              <span className={`dashboard-panel-icon ${activeLeftTab === 'commesse' ? 'project-icon' : 'rc-icon'}`} aria-hidden="true">
                <AppIcon name={activeLeftTab === 'commesse' ? 'projects' : 'fileText'} size={14} />
              </span>
              <div>
                <h2>
                  {activeLeftTab === 'commesse'
                    ? 'Commesse recenti'
                    : (user?.department === 'acquisti' ? 'Richieste listini & costi' : 'Preventivazione commerciale')}
                </h2>
                <p>
                  {activeLeftTab === 'commesse'
                    ? `${stats.active} attive su ${stats.total} totali`
                    : `${richiesteCommerciali.filter(r => r.stato !== 'completata').length} in lavorazione · ${richiesteCommerciali.filter(r => r.stato === 'completata').length} pronte`}
                </p>
              </div>
            </div>

            <div className="dashboard-panel-header-actions">
              <div className="dashboard-panel-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeLeftTab === 'commesse'}
                  className={`dashboard-panel-tab ${activeLeftTab === 'commesse' ? 'is-active' : ''}`}
                  onClick={() => setPanel1Tab('commesse')}
                >
                  Commesse
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeLeftTab === 'preventivi'}
                  className={`dashboard-panel-tab ${activeLeftTab === 'preventivi' ? 'is-active' : ''}`}
                  onClick={() => setPanel1Tab('preventivi')}
                >
                  Preventivi
                </button>
              </div>
              <button
                type="button"
                className="dashboard-link-btn"
                onClick={() => navigate(activeLeftTab === 'commesse' ? '/projects' : '/richieste-commerciali')}
              >
                Vedi tutte <span aria-hidden="true">→</span>
              </button>
            </div>
          </div>

          {activeLeftTab === 'commesse' ? (
            relevantProjects.length === 0 ? (
              <div className="empty-state dashboard-empty-state">
                <div className="empty-state-icon">P</div>
                <h3>Nessuna commessa</h3>
                <p>Crea la prima commessa per iniziare a pianificare.</p>
                <button className="btn btn-primary" onClick={() => navigate('/projects')}>
                  Apri commesse
                </button>
              </div>
            ) : (
              <div className="recent-projects dashboard-scroll-list">
                {relevantProjects.filter(p => p.status !== 'archived').slice(0, 5).map((project) => (
                  <button
                    type="button"
                    key={project.id}
                    className="recent-project-item"
                    onClick={() => navigate(`/projects/${project.id}`)}
                  >
                    <div className="recent-project-info">
                      <span className="recent-project-name">
                        {project.code && <small>{project.code}</small>}
                        {project.name}
                      </span>
                      <span className={`badge badge-${project.status}`} style={{ whiteSpace: 'nowrap' }}>{STATUS_LABELS_IT[project.status] || project.status}</span>
                    </div>
                    <div className="progress-bar">
                      <div
                        className="progress-bar-fill"
                        style={{ width: `${(project.progress || 0) * 100}%` }}
                      />
                    </div>
                    <div className="recent-project-meta">
                      <span>{project.task_count} task</span>
                      <span>{project.member_count} membri</span>
                      <span>{Math.round((project.progress || 0) * 100)}%</span>
                    </div>
                  </button>
                ))}
              </div>
            )
          ) : (
            richiesteCommerciali.length === 0 ? (
              <div className="empty-state dashboard-empty-state">
                <div className="empty-state-icon">📋</div>
                <h3>Nessuna richiesta commerciale</h3>
                <p>Nessun preventivo registrato al momento.</p>
                <button className="btn btn-primary" onClick={() => navigate('/richieste-commerciali')}>
                  Apri Preventivi
                </button>
              </div>
            ) : (
              <div className="notifications-list dashboard-scroll-list">
                {richiesteCommerciali.slice(0, 5).map((rc) => (
                  <button
                    type="button"
                    key={rc.id}
                    className="notification-item dashboard-rc-item"
                    onClick={() => navigate('/richieste-commerciali')}
                  >
                    <span className={`dashboard-rc-status ${rc.stato || 'aperta'}`}>
                      {rc.stato === 'in_lavorazione' ? 'In corso' : rc.stato === 'manca_listino' ? 'Manca listino' : rc.stato === 'completata' ? 'Completata' : 'Aperta'}
                    </span>
                    <div className="notification-content">
                      <div className="todo-item-heading">
                        <span className="notification-title">
                          {rc.codice ? `${rc.codice} · ` : ''}{rc.cliente || rc.oggetto || 'Richiesta commerciale'}
                        </span>
                        {rc.tipo_fornitura && (
                          <span className="dashboard-rc-tipo">
                            {rc.tipo_fornitura === 'materie_prime' ? 'MP' : rc.tipo_fornitura === 'mp_lavorazione' ? 'MP + Lav.' : 'Compravendita'}
                          </span>
                        )}
                      </div>
                      <div className="notification-message">
                        {rc.oggetto || (rc.articoli ? `${rc.articoli.length} articoli in elenco` : 'Dettaglio preventivo')}
                      </div>
                      <div className="recent-project-meta" style={{ marginTop: '3px' }}>
                        <span>Richiedente: {rc.richiedente_name || rc.created_by_username || 'Commerciale'}</span>
                        {rc.created_at && (
                          <span>{new Date(rc.created_at).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })}</span>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )
          )}
        </section>

        {/* Pannello Destro: TODO, Ticket o Note */}
        <section className="card dashboard-section dashboard-list-panel">
          <div className="dashboard-panel-header">
            <div className="dashboard-panel-title">
              <span
                className={`dashboard-panel-icon ${activeRightTab === 'todos'
                  ? 'todo-icon'
                  : activeRightTab === 'tickets'
                    ? 'ticket-icon'
                    : 'notes-icon'
                  }`}
                aria-hidden="true"
              >
                <AppIcon
                  name={activeRightTab === 'todos' ? 'todo' : activeRightTab === 'tickets' ? 'ticket' : 'notes'}
                  size={14}
                />
              </span>
              <div>
                <h2>
                  {activeRightTab === 'todos'
                    ? 'TODO assegnati'
                    : activeRightTab === 'tickets'
                      ? 'Ticket & Segnalazioni'
                      : 'Note recenti'}
                </h2>
                <p>
                  {activeRightTab === 'todos'
                    ? `${assignedTodos.length} ancora da completare`
                    : activeRightTab === 'tickets'
                      ? `${tickets.filter(t => t.status === 'Da gestire').length} da gestire · ${tickets.filter(t => t.status !== 'Completato').length} aperti`
                      : `${notes.length} note registrate`}
                </p>
              </div>
            </div>

            <div className="dashboard-panel-header-actions">
              <div className="dashboard-panel-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeRightTab === 'todos'}
                  className={`dashboard-panel-tab ${activeRightTab === 'todos' ? 'is-active' : ''}`}
                  onClick={() => setPanel2Tab('todos')}
                >
                  TODO
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeRightTab === 'tickets'}
                  className={`dashboard-panel-tab ${activeRightTab === 'tickets' ? 'is-active' : ''}`}
                  onClick={() => setPanel2Tab('tickets')}
                >
                  Ticket
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeRightTab === 'note'}
                  className={`dashboard-panel-tab ${activeRightTab === 'note' ? 'is-active' : ''}`}
                  onClick={() => setPanel2Tab('note')}
                >
                  Note
                </button>
              </div>
              <button
                type="button"
                className="dashboard-link-btn"
                onClick={() => navigate(activeRightTab === 'todos' ? '/todo' : activeRightTab === 'tickets' ? '/tickets' : '/notes')}
              >
                Vedi tutti <span aria-hidden="true">→</span>
              </button>
            </div>
          </div>

          {activeRightTab === 'todos' ? (
            assignedTodos.length === 0 ? (
              <div className="empty-state dashboard-empty-state">
                <div className="empty-state-icon">✓</div>
                <h3>Nessun TODO in sospeso</h3>
                <p>Hai completato tutte le attività assegnate.</p>
              </div>
            ) : (
              <div className="notifications-list dashboard-scroll-list">
                {assignedTodos.slice(0, 8).map((todo) => {
                  const due = todo.due_date ? (todo.due_date.includes('T') ? new Date(todo.due_date) : new Date(todo.due_date + 'T00:00:00')) : null;
                  const dueReference = new Date(); dueReference.setHours(0, 0, 0, 0);
                  const dueDay = due ? new Date(due) : null;
                  if (dueDay) dueDay.setHours(0, 0, 0, 0);
                  const daysLeft = dueDay ? Math.ceil((dueDay - dueReference) / 86400000) : null;
                  const isOverdue = daysLeft !== null && daysLeft < 0;

                  return (
                    <button
                      type="button"
                      key={todo.id}
                      className={`notification-item dashboard-todo-item ${isOverdue ? 'is-overdue' : ''}`}
                      onClick={() => navigate('/todo')}
                    >
                      <span className="todo-status-dot" aria-hidden="true">
                        {isOverdue ? '!' : '•'}
                      </span>
                      <div className="notification-content">
                        <div className="todo-item-heading">
                          <span className="notification-title">{todo.title}</span>
                          {due && (
                            <span className="todo-due-date">
                              {isOverdue ? 'Scaduto · ' : ''}
                              {due.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })}
                            </span>
                          )}
                        </div>
                        <div className="notification-message">
                          {todo.content || 'Nessuna descrizione'}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )
          ) : activeRightTab === 'tickets' ? (
            tickets.filter(t => t.status !== 'Completato').length === 0 ? (
              <div className="empty-state dashboard-empty-state">
                <div className="empty-state-icon">🎫</div>
                <h3>Nessun ticket aperto</h3>
                <p>Non ci sono segnalazioni o ticket da gestire al momento.</p>
                <button className="btn btn-primary" onClick={() => navigate('/tickets')}>
                  Apri Ticket
                </button>
              </div>
            ) : (
              <div className="notifications-list dashboard-scroll-list">
                {tickets.filter(t => t.status !== 'Completato').slice(0, 6).map((ticket) => (
                  <button
                    type="button"
                    key={ticket.id}
                    className="notification-item dashboard-ticket-item"
                    onClick={() => navigate('/tickets')}
                  >
                    <span className={`dashboard-ticket-badge ${ticket.status === 'Da gestire' ? 'da-gestire' : ticket.status === 'In attesa del cliente' ? 'in-attesa' : 'completato'}`}>
                      {ticket.status}
                    </span>
                    <div className="notification-content">
                      <div className="todo-item-heading">
                        <span className="notification-title">{ticket.title}</span>
                        <span className={`dashboard-priority-chip ${ticket.priority || 'medium'}`}>
                          {ticket.priority === 'high' ? 'Alta priorità' : ticket.priority === 'low' ? 'Bassa' : 'Media'}
                        </span>
                      </div>
                      <div className="notification-message">
                        {ticket.commessa_name || ticket.description || 'Nessuna nota aggiuntiva'}
                      </div>
                      <div className="recent-project-meta" style={{ marginTop: '3px' }}>
                        <span>Da: {ticket.author_name || ticket.author_username || 'Utente'}</span>
                        {ticket.created_at && (
                          <span>{new Date(ticket.created_at).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })}</span>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )
          ) : (
            notes.length === 0 ? (
              <div className="empty-state dashboard-empty-state">
                <div className="empty-state-icon">📝</div>
                <h3>Nessuna nota</h3>
                <p>Crea la tua prima nota per appunti e checklist.</p>
                <button className="btn btn-primary" onClick={() => navigate('/notes')}>
                  Crea nota
                </button>
              </div>
            ) : (
              <div className="notifications-list dashboard-scroll-list">
                {notes.slice(0, 6).map((note) => (
                  <button
                    type="button"
                    key={note.id}
                    className="notification-item dashboard-note-item"
                    onClick={() => navigate('/notes')}
                  >
                    <span className="dashboard-note-icon-wrap" aria-hidden="true">
                      <AppIcon name="notes" size={14} />
                    </span>
                    <div className="notification-content">
                      <div className="todo-item-heading">
                        <span className="notification-title">{note.title || 'Nota senza titolo'}</span>
                        <span className="dashboard-note-visibility">
                          {note.visibility === 'public' ? 'Pubblica' : note.visibility === 'shared' ? 'Condivisa' : 'Personale'}
                        </span>
                      </div>
                      <div className="notification-message">
                        {note.content ? note.content.replace(/<[^>]+>/g, '').slice(0, 80) : 'Nessun contenuto'}
                      </div>
                      <div className="recent-project-meta" style={{ marginTop: '3px' }}>
                        <span>{note.owner?.full_name || note.owner?.username ? `${note.owner.full_name || note.owner.username}` : 'Personale'}</span>
                        {note.updated_at && (
                          <span>Aggiornata il {new Date(note.updated_at).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })}</span>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )
          )}
        </section>

        {recoveryItems.filter(item => !dismissedKeys.has(getRecoveryKey(item))).length > 0 && (
          <section className="conflict-card card dashboard-section recovery-panel">
            <div className="dashboard-panel-header">
              <div className="dashboard-panel-title">
                <span className="dashboard-panel-icon warning-icon" aria-hidden="true">
                  <AppIcon name="alert" size={17} />
                </span>
                <div>
                  <h2>Ore da recuperare per ferie</h2>
                  <p>Coordina il recupero con il tuo responsabile.</p>
                </div>
              </div>
            </div>
            <div className="recovery-list">
              {recoveryItems
                .filter(item => !dismissedKeys.has(getRecoveryKey(item)))
                .map((item, i) => (
                  <div
                    key={i}
                    className="recovery-item"
                    onClick={() => navigate(`/projects/${item.project_id}`)}
                    onKeyDown={(e) => e.key === 'Enter' && navigate(`/projects/${item.project_id}`)}
                    role="button"
                    tabIndex={0}
                  >
                    <span className="recovery-item-icon" aria-hidden="true">
                      <AppIcon name="clock" size={17} />
                    </span>
                    <div className="recovery-copy">
                      <strong>{item.task_name}</strong>
                      <span>
                        <AppIcon name="projects" size={13} />
                        {item.project_name}
                      </span>
                      <small>
                        <AppIcon name="calendar" size={13} />
                        {item.vacation_days?.length || 0} giorni lavorativi sovrapposti
                      </small>
                    </div>
                    <div className="recovery-actions">
                      <span className="recovery-hours">
                        <strong>{item.hours_to_recover}h</strong>
                        <small>da recuperare</small>
                      </span>
                      <button
                        type="button"
                        onClick={(e) => dismissRecoveryItem(e, item)}
                        title="Segna come recuperata e rimuovi dalla lista"
                        aria-label={`Segna come recuperate le ore di ${item.task_name}`}
                        className="recovery-dismiss"
                      >
                        <AppIcon name="check" size={16} />
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </section>
        )}
      </div>

      {/* Modal Popup Previsioni Meteo */}
      <WeatherModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        weatherState={weatherState}
      />

      {/* Modal Popup Dettaglio Ore Non Consuntivate */}
      {showUnloggedModal && (
        <div className="modal-overlay animate-fadeIn" onClick={() => setShowUnloggedModal(false)}>
          <div
            className="modal"
            style={{ maxWidth: 1040, width: '94%', padding: '28px 32px', maxHeight: '88vh' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div
                  style={{
                    width: 46,
                    height: 46,
                    fontSize: '1rem',
                    background: 'linear-gradient(135deg, #f43f5e, #e11d48)',
                    color: '#fff',
                    borderRadius: 14,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: '0 4px 14px rgba(244, 63, 94, 0.28)'
                  }}
                >
                  <AppIcon name="clock" size={24} />
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.35rem', fontWeight: 750, color: 'var(--text-primary)' }}>
                    Ore non consuntivate
                  </h3>
                  <p style={{ margin: '3px 0 0', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                    Mancano all'appello <strong>{unloggedHoursData?.unlogged_hours || 0}h</strong> complessive suddivise su {unloggedHoursData?.alerts?.length || 0} {(unloggedHoursData?.alerts?.length || 0) === 1 ? 'giornata di lavoro' : 'giornate di lavoro'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setShowUnloggedModal(false)}
                style={{ padding: '6px 12px', borderRadius: 8, fontSize: '0.9rem' }}
                title="Chiudi"
              >
                ✕
              </button>
            </div>

            <div style={{ marginTop: 20 }}>
              {(unloggedHoursData?.alerts || []).length === 0 ? (
                <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                  <div style={{ fontSize: '2.2rem', marginBottom: 10 }}>✅</div>
                  <div style={{ fontWeight: 650, fontSize: '1.1rem', color: 'var(--text-primary)' }}>Tutte le ore risultano consuntivate!</div>
                  <div style={{ fontSize: '0.85rem', marginTop: 6, color: 'var(--text-secondary)' }}>Non ci sono giornate con mancata consuntivazione sulle tue fasi attive.</div>
                </div>
              ) : (
                <div className="table-wrapper" style={{ maxHeight: 460, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 10 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: 120 }}>Giorno</th>
                        <th style={{ minWidth: 240 }}>Fase</th>
                        <th style={{ minWidth: 280 }}>Commessa</th>
                        <th style={{ textAlign: 'center', width: 100 }}>Ore previste</th>
                        <th style={{ textAlign: 'right', width: 150 }}>Azione</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(unloggedHoursData?.alerts || []).map((alert) => (
                        <tr key={alert.id}>
                          <td>
                            <div style={{ fontWeight: 650, fontSize: '0.875rem', color: 'var(--text-primary)' }}>
                              {alert.formatted_date || alert.date}
                            </div>
                          </td>
                          <td>
                            <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--text-primary)' }}>
                              {alert.task_name}
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                              {alert.project_code && (
                                <span className="badge" style={{ alignSelf: 'flex-start', fontSize: '0.7rem', padding: '1px 6px', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                                  {alert.project_code}
                                </span>
                              )}
                              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                                {alert.project_name}
                              </span>
                            </div>
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <span
                              className="badge"
                              style={{
                                backgroundColor: 'rgba(244, 63, 94, 0.12)',
                                color: '#f43f5e',
                                fontWeight: 750,
                                fontSize: '0.82rem',
                                padding: '4px 10px',
                                borderRadius: 999
                              }}
                            >
                              {alert.planned_daily_hours ? `${alert.planned_daily_hours}h` : '-'}
                            </span>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <button
                              className="btn btn-sm btn-secondary"
                              onClick={() => {
                                setShowUnloggedModal(false);
                                navigate(`/projects/${alert.project_id}`);
                              }}
                              title="Vai al Gantt della commessa"
                              style={{ fontSize: '0.8125rem', padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                            >
                              <span>Vai alla commessa</span>
                              <AppIcon name="chevronRight" size={13} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24, paddingTop: 18, borderTop: '1px solid var(--border-subtle)', flexWrap: 'wrap', gap: 12 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setShowUnloggedModal(false);
                  navigate('/personal-calendar');
                }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 16px', fontSize: '0.875rem' }}
              >
                <AppIcon name="calendar" size={16} />
                <span>Apri calendario personale per consuntivare</span>
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowUnloggedModal(false)}
                style={{ padding: '8px 16px', fontSize: '0.875rem' }}
              >
                Chiudi
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
