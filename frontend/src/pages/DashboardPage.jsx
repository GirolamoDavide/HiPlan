import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../context/ToastContext';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import TimelineView from '../components/calendar/TimelineView';
import AppIcon from '../components/ui/AppIcon';
import WeatherDateWidget from '../components/ui/WeatherDateWidget';
import './DashboardPage.css';
import { STATUS_LABELS_IT } from '../utils/statusLabels';

export default function DashboardPage() {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [timelineYear, setTimelineYear] = useState(() => new Date().getFullYear());
  const [timelineMonth, setTimelineMonth] = useState(() => new Date().getMonth());
  const [projects, setProjects] = useState([]);
  const [projectsWithTasks, setProjectsWithTasks] = useState([]);
  const [assignedTodos, setAssignedTodos] = useState([]);
  const [myTasksToday, setMyTasksToday] = useState([]);
  const [quickLogHours, setQuickLogHours] = useState({});
  const [vacations, setVacations] = useState([]);
  const [recoveryItems, setRecoveryItems] = useState([]);
  const [dismissedKeys, setDismissedKeys] = useState(
    () => new Set(JSON.parse(localStorage.getItem('recovery_dismissed') || '[]'))
  );
  const [globalBanners, setGlobalBanners] = useState([]);
  const [loading, setLoading] = useState(true);

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
    const now = new Date();
    setTimelineYear(now.getFullYear());
    setTimelineMonth(now.getMonth());
  }

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const [projRes, todosRes, tasksRes, vacRes, recoveryRes, bannerRes] = await Promise.all([
        api.get('/projects'),
        api.get('/todos'),
        api.get('/users/me/tasks/today'),
        api.get('/vacations/me').catch(() => ({ data: [] })),
        api.get('/vacations/me/recovery').catch(() => ({ data: [] })),
        api.get('/settings/global-banner').catch(() => ({ data: [] })),
      ]);
      setProjects(projRes.data);
      if (Array.isArray(bannerRes.data)) {
        setGlobalBanners(bannerRes.data);
      }
      const todosData = todosRes.data || [];
      const openAssigned = todosData.filter(t => !t.is_completed && t.assignees?.includes(user?.id));
      setAssignedTodos(openAssigned);
      setMyTasksToday(tasksRes.data);
      
      const initHours = {};
      tasksRes.data.forEach(t => {
        initHours[t.id] = t.actual_hours_today || t.expected_hours_today || '';
      });
      setQuickLogHours(initHours);

      setVacations(vacRes.data || []);
      setRecoveryItems(recoveryRes.data || []);

      Promise.all(
        projRes.data.map(async (p) => {
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
        <WeatherDateWidget />
      </div>

      <div className="stats-grid">
        <div className="stat-card stat-total">
          <div className="stat-icon" aria-hidden="true">
            <AppIcon name="projects" size={13} />
          </div>
          <div className="stat-info">
            <span className="stat-label">Totale commesse</span>
            <span className="stat-value">{stats.total}</span>
          </div>
        </div>
        <div className="stat-card stat-active">
          <div className="stat-icon" aria-hidden="true">
            <AppIcon name="active_projects" size={13} />
          </div>
          <div className="stat-info">
            <span className="stat-label">Commesse attive</span>
            <span className="stat-value">{stats.active}</span>
          </div>
        </div>
        <div className="stat-card stat-completed">
          <div className="stat-icon" aria-hidden="true">
            <AppIcon name="todo" size={13} />
          </div>
          <div className="stat-info">
            <span className="stat-label">Completate</span>
            <span className="stat-value">{stats.completed}</span>
          </div>
        </div>
        <div className="stat-card stat-progress">
          <div className="stat-icon" aria-hidden="true">
            <AppIcon name="gantt" size={13} />
          </div>
          <div className="stat-info">
            <span className="stat-label">Progresso medio</span>
            <span className="stat-value">{avgProgress}%</span>
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

        <section className="card dashboard-section dashboard-list-panel">
          <div className="dashboard-panel-header">
            <div className="dashboard-panel-title">
              <span className="dashboard-panel-icon project-icon" aria-hidden="true">
                <AppIcon name="projects" size={13} />
              </span>
              <div>
                <h2>Commesse recenti</h2>
                <p>Ultimi progetti aggiornati</p>
              </div>
            </div>
            <button type="button" className="dashboard-link-btn" onClick={() => navigate('/projects')}>
              Vedi tutte <span aria-hidden="true">→</span>
            </button>
          </div>
          {relevantProjects.length === 0 ? (
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
                    <span className={`badge badge-${project.status}`}>{STATUS_LABELS_IT[project.status] || project.status}</span>
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
          )}
        </section>

        <section className="card dashboard-section dashboard-list-panel">
          <div className="dashboard-panel-header">
            <div className="dashboard-panel-title">
              <span className="dashboard-panel-icon todo-icon" aria-hidden="true">
                <AppIcon name="todo" size={13} />
              </span>
              <div>
                <h2>TODO assegnati</h2>
                <p>{assignedTodos.length} ancora da completare</p>
              </div>
            </div>
            <button type="button" className="dashboard-link-btn" onClick={() => navigate('/todo')}>
              Vedi tutti <span aria-hidden="true">→</span>
            </button>
          </div>
          {assignedTodos.length === 0 ? (
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
                  <p>Coordina il recupero con il tuo referente.</p>
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
    </div>
  );
}
