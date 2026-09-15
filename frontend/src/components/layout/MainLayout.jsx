import { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { useToast } from '../../context/ToastContext';
import api from '../../api/client';
import { getMyRole } from '../../api/richiesteCommerciali';
import './MainLayout.css';
import GlobalSearch from './GlobalSearch';

/* SVG icons for theme toggle */
function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function AppIcon({ name, size = 19 }) {
  const commonProps = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  };

  const icons = {
    dashboard: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="2" />
        <rect x="14" y="3" width="7" height="7" rx="2" />
        <rect x="3" y="14" width="7" height="7" rx="2" />
        <rect x="14" y="14" width="7" height="7" rx="2" />
      </>
    ),
    projects: (
      <>
        <path d="M3.5 7.5h6l2-2h9a1.5 1.5 0 0 1 1.5 1.5v11.5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 1.5-2Z" />
        <path d="M2.5 10h19" />
      </>
    ),
    alert: (
      <>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
        <path d="M12 9v4M12 17h.01" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="3" />
        <path d="M8 3v4M16 3v4M3 10h18" />
        <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" />
      </>
    ),
    notes: (
      <>
        <path d="M5 3h11l3 3v15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
        <path d="M15 3v4h4M7.5 11h7M7.5 15h7M7.5 19h4" />
      </>
    ),
    todo: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="4" />
        <path d="m8 12 2.5 2.5L16.5 8" />
      </>
    ),
    users: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    ),
    ticket: (
      <>
        <path d="M4 5h16a2 2 0 0 1 2 2v3a2.5 2.5 0 0 0 0 5v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-2a2.5 2.5 0 0 0 0-5V7a2 2 0 0 1 2-2Z" />
        <path d="M13 8v8M9 8v8" />
      </>
    ),
    briefcase: (
      <>
        <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
        <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
      </>
    ),
    handshake: (
      <>
        <path d="M19 14l-4.5 4.5a2.12 2.12 0 0 1-3 0L7 14" />
        <path d="m14 9 3.5-3.5a2.12 2.12 0 0 1 3 3L17 12" />
        <path d="M3 10l3.5-3.5a2.12 2.12 0 0 1 3 0L14 11" />
        <path d="m2 14 3.5 3.5a2.12 2.12 0 0 0 3 0L11 15" />
      </>
    ),
    fileText: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.09A1.7 1.7 0 0 0 9 19.36a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14H3v-4h.09A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63h.01A1.7 1.7 0 0 0 10 3.08V3h4v.09A1.7 1.7 0 0 0 15 4.64a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9v.01A1.7 1.7 0 0 0 20.92 10H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z" />
      </>
    ),
    bell: (
      <>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </>
    ),
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    logout: (
      <>
        <path d="M10 17l5-5-5-5M15 12H3" />
        <path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" />
      </>
    ),
    chevronLeft: <path d="m15 18-6-6 6-6" />,
    chevronRight: <path d="m9 18 6-6-6-6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    check: <path d="m5 12 4 4L19 6" />,
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </>
    ),
    externalLink: (
      <>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </>
    ),
    robot: (
      <>
        <rect x="3" y="11" width="18" height="10" rx="2" />
        <circle cx="12" cy="5" r="2" />
        <path d="M12 7v4" />
        <line x1="8" y1="16" x2="8.01" y2="16" />
        <line x1="16" y1="16" x2="16.01" y2="16" />
      </>
    ),
    messageSquare: (
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    ),
    timeline: (
      <>
        <path d="M4 6h16M4 12h16M4 18h16" />
        <circle cx="8" cy="6" r="2" fill="currentColor" stroke="none" />
        <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
        <circle cx="11" cy="18" r="2" fill="currentColor" stroke="none" />
      </>
    ),
  };

  return <svg {...commonProps}>{icons[name]}</svg>;
}

export default function MainLayout() {
  const { user, logout } = useAuth();
  const { theme, cycleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem('hiplan-sidebar-collapsed');
    return saved ? saved === 'true' : true;
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [agentSuggestionsCount, setAgentSuggestionsCount] = useState(0);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [rcEnabled, setRcEnabled] = useState(() => user?.role === 'admin');

  useEffect(() => {
    if (user?.role === 'admin') {
      setRcEnabled(true);
      return;
    }
    if (!user) {
      setRcEnabled(false);
      return;
    }
    getMyRole()
      .then((res) => setRcEnabled(Boolean(res?.enabled)))
      .catch(() => setRcEnabled(false));
  }, [user]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setShowGlobalSearch(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    localStorage.setItem('hiplan-sidebar-collapsed', collapsed);
  }, [collapsed]);

  const notifiedIdsRef = useRef(new Set());
  const initialLoadRef = useRef(true);

  useEffect(() => {
    fetchNotificationsData();
    fetchAgentCount();
    const interval = setInterval(() => {
      fetchNotificationsData();
      fetchAgentCount();
    }, 60000);
    window.addEventListener('notifications-changed', fetchNotificationsData);
    window.addEventListener('agent-suggestions-changed', fetchAgentCount);
    window.addEventListener('agent-data-modified', fetchAgentCount);
    return () => {
      clearInterval(interval);
      window.removeEventListener('notifications-changed', fetchNotificationsData);
      window.removeEventListener('agent-suggestions-changed', fetchAgentCount);
      window.removeEventListener('agent-data-modified', fetchAgentCount);
    };
  }, [user]);

  async function fetchAgentCount() {
    if (user?.role !== 'admin' && user?.role !== 'editor') return;
    try {
      const { data } = await api.get('/replanning/suggestions');
      const archived = JSON.parse(localStorage.getItem('hiplan-archived-suggestions') || '[]');
      const active = data.filter(s => {
        const key = `${s.project_id}_${s.task_id}_${s.action_type}`;
        return !archived.includes(key);
      });
      setAgentSuggestionsCount(active.length);
    } catch { /* ignore */ }
  }

  async function fetchNotificationsData() {
    try {
      const { data } = await api.get('/notifications');
      setNotifications(data);
      setUnreadCount(data.filter(n => !n.is_read).length);

      if (initialLoadRef.current) {
        data.forEach(n => notifiedIdsRef.current.add(n.id));
        initialLoadRef.current = false;
      } else {
        data.forEach(n => {
          if (!n.is_read && !notifiedIdsRef.current.has(n.id)) {
            toast.info(`Nuova notifica: ${n.title}`);
            notifiedIdsRef.current.add(n.id);
          }
        });
      }
    } catch { /* ignore */ }
  }

  useEffect(() => {
    if (showNotifications) {
      fetchNotificationsData();
    }
  }, [showNotifications]);

  async function markAsRead(id) {
    try {
      await api.patch(`/notifications/${id}/read`);
      fetchNotificationsData();
    } catch { /* ignore */ }
  }

  async function deleteNotification(id) {
    try {
      await api.delete(`/notifications/${id}`);
      fetchNotificationsData();
    } catch { /* ignore */ }
  }

  async function deleteAllNotifications() {
    try {
      await api.delete('/notifications');
      fetchNotificationsData();
    } catch { /* ignore */ }
  }

  function handleLogout() {
    logout();
    navigate('/login');
  }

  const themeLabel = theme === 'system' ? 'Sistema' : theme === 'light' ? 'Chiaro' : 'Scuro';
  const ThemeIcon = theme === 'system' ? MonitorIcon : theme === 'light' ? SunIcon : MoonIcon;
  const showSidebarText = !collapsed || mobileOpen;
  const layoutPageKey = location.pathname.startsWith('/projects/')
    ? 'project-detail'
    : location.pathname.split('/')[1] || 'dashboard';
  const pageMeta = location.pathname.startsWith('/projects/')
    ? { title: 'Dettaglio commessa', subtitle: 'Pianificazione, ore e avanzamento' }
    : {
      '/dashboard': { title: 'Dashboard', subtitle: 'Il tuo spazio di lavoro' },
      '/projects': { title: 'Commesse', subtitle: 'Pianificazione e avanzamento' },
      '/calendar': { title: 'Calendario Commesse', subtitle: 'Attività e disponibilità' },
      '/personal-calendar': { title: 'Calendario personale', subtitle: 'I tuoi impegni e attività assegnate' },
      '/notes': { title: 'Blocchi Note', subtitle: 'Appunti e documenti condivisi' },
      '/todo': { title: 'TODO', subtitle: 'Priorità personali e di team' },
      '/conflicts': { title: 'Panoramica addetti', subtitle: 'Carichi e sovrapposizioni' },
      '/replanning': { title: 'Rilevatore Conflitti', subtitle: 'Analisi e conflitti' },
      '/tickets': { title: 'Ticket', subtitle: 'Richieste e supporto operativo' },
      '/richieste-commerciali': { title: 'Preventivazione', subtitle: 'Coordinamento commerciale e acquisti' },
      '/admin': { title: 'Amministrazione', subtitle: 'Utenti e configurazione' },
      '/me': { title: 'Il mio profilo', subtitle: 'Profilo, reparto e ferie' },
      '/chat': { title: 'HiPlan AI', subtitle: 'Assistente Virtuale' },
    }[location.pathname] || { title: 'HiPlan', subtitle: 'Workspace operativo' };

  useEffect(() => {
    setMobileOpen(false);
    // Assicura che i tooltip di DHTMLX Gantt rimasti appesi vengano eliminati al cambio di pagina
    document.querySelectorAll('.gantt_tooltip').forEach(t => t.remove());
  }, [location.pathname]);



  return (
    <div className={`app-layout ${collapsed ? 'sidebar-collapsed' : ''} ${mobileOpen ? 'sidebar-mobile-open' : ''}`}>
      <button
        className="sidebar-mobile-backdrop"
        type="button"
        aria-label="Chiudi menu"
        onClick={() => setMobileOpen(false)}
      />
      <aside className="sidebar">
        <div className="sidebar-header">
          <div
            className="sidebar-logo"
            onClick={() => navigate('/dashboard')}
            title="Torna alla Dashboard"
          >
            <img
              src="/hiway-icon.png"
              alt="HiWay"
              className="hiway-sidebar-img"
            />
            {showSidebarText && (
              <div className="sidebar-brand-copy">
                <span className="sidebar-logo-text">HiPlan</span>
                <span className="sidebar-logo-caption">for HiWay</span>
              </div>
            )}
          </div>
          <button
            className="sidebar-toggle"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? 'Espandi menu' : 'Riduci menu'}
            title={collapsed ? 'Espandi menu' : 'Riduci menu'}
          >
            <AppIcon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={17} />
          </button>
        </div>

        <nav className="sidebar-nav">
          <span className="sidebar-section-label">Workspace</span>
          <NavLink to="/dashboard" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            <span className="sidebar-link-icon"><AppIcon name="dashboard" /></span>
            {showSidebarText && <span>Dashboard</span>}
          </NavLink>
          <NavLink to="/projects" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            <span className="sidebar-link-icon"><AppIcon name="projects" /></span>
            {showSidebarText && <span>Commesse</span>}
          </NavLink>
          <NavLink to="/calendar" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            <span className="sidebar-link-icon"><AppIcon name="timeline" /></span>
            {showSidebarText && <span>Calendario Commesse</span>}
          </NavLink>

          {rcEnabled && (
            <>
              <span className="sidebar-section-label">Coordinamento</span>
              <NavLink to="/richieste-commerciali" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                <span className="sidebar-link-icon"><AppIcon name="briefcase" /></span>
                {showSidebarText && <span>Preventivazione</span>}
              </NavLink>
            </>
          )}

          <span className="sidebar-section-label">Produttività</span>
          <NavLink to="/personal-calendar" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            <span className="sidebar-link-icon"><AppIcon name="calendar" /></span>
            {showSidebarText && <span>Calendario Personale</span>}
          </NavLink>
          <NavLink to="/todo" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            <span className="sidebar-link-icon"><AppIcon name="todo" /></span>
            {showSidebarText && <span>TODO</span>}
          </NavLink>
          <NavLink to="/notes" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            <span className="sidebar-link-icon"><AppIcon name="notes" /></span>
            {showSidebarText && <span>Blocchi Note</span>}
          </NavLink>
          <NavLink to="/tickets" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            <span className="sidebar-link-icon"><AppIcon name="ticket" /></span>
            {showSidebarText && <span>Ticket</span>}
          </NavLink>

          <span className="sidebar-section-label">Controllo & AI</span>
          <NavLink to="/chat" className={({ isActive }) => `sidebar-link sidebar-link--ai ${isActive ? 'active' : ''}`}>
            <span className="sidebar-link-icon"><AppIcon name="robot" /></span>
            {showSidebarText && <span>HiPlan AI</span>}
          </NavLink>
          <NavLink to="/conflicts" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            <span className="sidebar-link-icon"><AppIcon name="users" /></span>
            {showSidebarText && <span>Panoramica addetti</span>}
          </NavLink>
          {(user?.role === 'admin' || user?.role === 'editor') && (
            <NavLink to="/replanning" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
              <span className="sidebar-link-icon"><AppIcon name="alert" /></span>
              {showSidebarText && <span>Rilevatore Conflitti</span>}
              {agentSuggestionsCount > 0 && (
                <span className="sidebar-badge">
                  {agentSuggestionsCount}
                </span>
              )}
            </NavLink>
          )}
          {user?.role === 'admin' && (
            <NavLink to="/admin" end className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
              <span className="sidebar-link-icon"><AppIcon name="settings" /></span>
              {showSidebarText && <span>Admin</span>}
            </NavLink>
          )}

          <span className="sidebar-section-label">Software Esterni</span>
          <a href="http://192.168.2.13/accounts/login/" target="_blank" rel="noopener noreferrer" className="sidebar-link">
            <span className="sidebar-link-icon"><AppIcon name="externalLink" /></span>
            {showSidebarText && <span>HiGest</span>}
          </a>
        </nav>


        <div className="sidebar-footer">
          <button className="sidebar-user" type="button" onClick={() => navigate('/me')} title="Apri il mio profilo">
            <div className="sidebar-avatar">{user?.username?.[0]?.toUpperCase() || '?'}</div>
            {showSidebarText && (
              <div className="sidebar-user-info">
                <span className="sidebar-user-name">{user?.full_name || user?.username}</span>
                <span className="sidebar-user-role">{user?.role} · {user?.department?.replace('_', ' ') || 'team'}</span>
              </div>
            )}
          </button>

          <button className="sidebar-logout" onClick={handleLogout} title="Esci">
            <AppIcon name="logout" size={18} />
            {showSidebarText && <span>Esci</span>}
          </button>
        </div>
      </aside>

      <main className="main-content">
        <header className="app-topbar">
          <div className="topbar-page">
            <button
              type="button"
              className="topbar-icon-btn topbar-menu-btn"
              onClick={() => setMobileOpen(true)}
              aria-label="Apri menu"
            >
              <AppIcon name="menu" size={21} />
            </button>
            <div>
              <h1>{pageMeta.title}</h1>
              <p>{pageMeta.subtitle}</p>
            </div>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className="topbar-icon-btn"
              onClick={() => setShowGlobalSearch(true)}
              title="Ricerca Globale (Ctrl+K)"
              aria-label="Cerca"
            >
              <AppIcon name="search" size={20} />
            </button>
            <button
              type="button"
              className="topbar-icon-btn"
              onClick={() => setShowNotifications(true)}
              title="Notifiche"
              aria-label={`Notifiche${unreadCount > 0 ? `, ${unreadCount} non lette` : ''}`}
            >
              <AppIcon name="bell" size={20} />
              {unreadCount > 0 && <span className="notification-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
            </button>
            <button
              type="button"
              className="topbar-theme-btn"
              onClick={cycleTheme}
              title={`Tema: ${themeLabel}. Clicca per cambiare.`}
            >
              <ThemeIcon />
              <span>{themeLabel}</span>
            </button>
            <button type="button" className="topbar-profile" onClick={() => navigate('/me')} title="Apri il mio profilo">
              <span className="topbar-avatar">{user?.username?.[0]?.toUpperCase() || '?'}</span>
              <span className="topbar-profile-copy">
                <strong>{user?.full_name || user?.username}</strong>
                <small>{user?.role}</small>
              </span>
            </button>
          </div>
        </header>
        <div className={`main-body main-body-${layoutPageKey}`}>
          <Outlet />
        </div>
      </main>

      {showNotifications && (
        <div className="modal-overlay">
          <div className="modal layout-notification-modal" onClick={e => e.stopPropagation()}>
            <div className="layout-notification-header">
              <div>
                <span>Centro attività</span>
                <h2>Notifiche</h2>
              </div>
              <div className="layout-notification-header-actions">
                {notifications.length > 0 && (
                  <button
                    className="btn btn-ghost btn-sm notification-delete-all"
                    onClick={deleteAllNotifications}
                    title="Elimina tutte le notifiche"
                  >
                    Elimina tutte
                  </button>
                )}
                <button
                  type="button"
                  className="layout-notification-close"
                  onClick={() => setShowNotifications(false)}
                  aria-label="Chiudi notifiche"
                >
                  <AppIcon name="close" size={17} />
                </button>
              </div>
            </div>

            <div className="layout-notification-body">
              {notifications.length === 0 ? (
                <div className="empty-state layout-notification-empty">
                  <div className="empty-state-icon"><AppIcon name="bell" size={22} /></div>
                  <h3>Nessuna notifica</h3>
                  <p>Quando ci saranno novità le troverai qui.</p>
                </div>
              ) : (
                <div className="layout-notification-list">
                  {notifications.map((n) => (
                    <div key={n.id} className={`notification-item ${n.is_read ? '' : 'unread'}`}
                      onClick={() => {
                        if (n.project_id && n.task_id) {
                          navigate(`/projects/${n.project_id}?open_task=${n.task_id}`);
                        } else if (n.project_id) {
                          navigate(`/projects/${n.project_id}`);
                        }
                        setShowNotifications(false);
                      }}
                      role={n.project_id ? 'button' : undefined}
                      tabIndex={n.project_id ? 0 : undefined}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && n.project_id) {
                          navigate(n.task_id ? `/projects/${n.project_id}?open_task=${n.task_id}` : `/projects/${n.project_id}`);
                          setShowNotifications(false);
                        }
                      }}
                    >
                      <span className={`notification-type-icon notification-type-${n.type || 'update'}`} aria-hidden="true">
                        {n.type === 'assignment' ? 'A' : n.type === 'deadline' ? '!' : 'i'}
                      </span>
                      <div className="notification-content">
                        <div className="notification-title">{n.title}</div>
                        <div className="notification-message">{n.message}</div>
                        <div className="notification-time">
                          {(() => {
                            // Se il backend non restituisce informazioni sul fuso orario, assumiamo UTC (SQLite standard)
                            // per far sì che il browser lo converta correttamente nell'ora locale
                            const dateStr = n.created_at.endsWith('Z') ? n.created_at : n.created_at + 'Z';
                            return new Date(dateStr).toLocaleString('it-IT');
                          })()}
                        </div>
                      </div>
                      <div className="notification-actions">
                        {!n.is_read && (
                          <button
                            className="notification-action-btn notification-read-btn"
                            title="Segna come letta"
                            onClick={(e) => { e.stopPropagation(); markAsRead(n.id); }}
                          >
                            <AppIcon name="check" size={14} />
                          </button>
                        )}
                        <button
                          className="notification-action-btn notification-remove-btn"
                          title="Elimina"
                          onClick={(e) => { e.stopPropagation(); deleteNotification(n.id); }}
                        >
                          <AppIcon name="close" size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <GlobalSearch
        isOpen={showGlobalSearch}
        onClose={() => setShowGlobalSearch(false)}
      />
    </div>
  );
}
