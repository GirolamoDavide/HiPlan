import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import api from '../api/client';
import { useToast } from '../context/ToastContext';
import AppIcon from '../components/ui/AppIcon';
import './AdminPage.css';

const DEPT_LABELS = {
  ufficio_tecnico: 'Ufficio Tecnico',
  produzione: 'Produzione',
  amministrazione: 'Amministrazione',
  acquisti: 'Acquisti',
  commerciale: 'Commerciale',
  condivisa: 'Condivisa tra più reparti'
};
const DEPT_COLORS = {
  ufficio_tecnico: '#3b82f6',
  produzione: '#f59e0b',
  amministrazione: '#64748b',
  acquisti: '#10b981',
  commerciale: '#ec4899',
  condivisa: '#8b5cf6'
};

const BUDGET_MODE_SHORT_LABELS = {
  start_days: 'Data Inizio / Giorni',
  start_hours: 'Data Inizio / Ore',
  start_end: 'Data Inizio / Fine',
  end_days: 'Data Fine / Giorni',
  end_hours: 'Data Fine / Ore',
  start_days_hours: 'Inizio / Giorni / Ore',
  end_days_hours: 'Fine / Giorni / Ore',
  custom_dates: 'Date da Calendario',
};

export default function AdminPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [users, setUsers] = useState([]);
  const [zeroHoursAlerts, setZeroHoursAlerts] = useState([]);
  const [loadingZeroHours, setLoadingZeroHours] = useState(false);
  const [zeroHoursSearch, setZeroHoursSearch] = useState('');
  const [zeroHoursDeptFilter, setZeroHoursDeptFilter] = useState('all');
  const [zeroHoursPage, setZeroHoursPage] = useState(1);
  const [phaseTemplates, setPhaseTemplates] = useState([]);
  const [filterDept, setFilterDept] = useState('all');
  const [showAddTemplateModal, setShowAddTemplateModal] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [templateForm, setTemplateForm] = useState({
    name: '',
    department: 'ufficio_tecnico',
    default_color: '#3b82f6',
    default_days: '',
    default_hours: '',
    default_budget_mode: 'start_days',
  });
  const [globalBannerForm, setGlobalBannerForm] = useState({ text: '', type: 'info', duration_hours: 24, isManualDate: false, manualDate: '' });
  const [globalBanners, setGlobalBanners] = useState([]);
  const [ticketPhases, setTicketPhases] = useState([]);
  const [newTicketPhase, setNewTicketPhase] = useState('');
  const [lastBackup, setLastBackup] = useState(null);
  const [backups, setBackups] = useState([]);
  const [restoringBackup, setRestoringBackup] = useState(null);
  const [uploadingBackup, setUploadingBackup] = useState(false);
  const [emailLogs, setEmailLogs] = useState([]);
  const [scheduledEmails, setScheduledEmails] = useState([]);
  const [emailLogTab, setEmailLogTab] = useState('sent'); // 'sent' | 'scheduled'
  const [loading, setLoading] = useState(true);
  const [todoEmailSettings, setTodoEmailSettings] = useState({ todo_notification_email: '' });
  const [smtpSettings, setSmtpSettings] = useState(null);
  const [savingEmailSettings, setSavingEmailSettings] = useState(false);
  // STATO PER COLONNE TABELLA ADMIN
  const [adminVisibleColumns, setAdminVisibleColumns] = useState(() => {
    const saved = localStorage.getItem('adminVisibleColumns');
    return saved ? JSON.parse(saved) : ['utente', 'email', 'ruolo', 'reparto', 'stato', 'registrato', 'azioni'];
  });
  const [showAdminColumnsMenu, setShowAdminColumnsMenu] = useState(false);
  const [managingUser, setManagingUser] = useState(null);
  const [newPassword, setNewPassword] = useState('');

  const [showAddUserModal, setShowAddUserModal] = useState(false);
  const [newUserForm, setNewUserForm] = useState({
    username: '',
    email: '',
    full_name: '',
    password: '',
    role: 'viewer',
    department: 'ufficio_tecnico'
  });

  function isReportExpired(data) {
    if (!data) return true;
    let ts = data.generated_timestamp;
    if (!ts && data.generated_at) {
      const match = data.generated_at.match(/(\d{2})\/(\d{2})\/(\d{4})\s+alle\s+(\d{2}):(\d{2})/);
      if (match) {
        const [, d, m, y, h, min] = match;
        ts = new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min)).getTime();
      }
    }
    if (!ts) return true;

    const now = new Date();
    // Cutoff delle ore 07:00 di oggi
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 7, 0, 0, 0);
    if (now.getTime() < cutoff.getTime()) {
      // Se sono prima delle 7:00 del mattino, il cutoff è ieri alle 07:00
      cutoff.setDate(cutoff.getDate() - 1);
    }
    return ts < cutoff.getTime();
  }

  const [aiReportData, setAiReportData] = useState(() => {
    try {
      const cached = localStorage.getItem('admin_ai_report_cache');
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  });
  const [aiReportLoading, setAiReportLoading] = useState(false);

  const [collapsedSections, setCollapsedSections] = useState({
    aiReport: true, // Di default compresso mostrando solo i KPI come in Immagine 2
    annunci: true,
    users: true,
    zeroHours: true,
    templates: true,
    ticketPhases: true,
    todoEmail: true,
    emails: true,
    backup: true
  });
  const [automationRulesCount, setAutomationRulesCount] = useState({ total: 0, active: 0 });

  const toggleSection = (section) => {
    setCollapsedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  async function fetchAiReport(showToast = true) {
    if (aiReportLoading) return;
    setAiReportLoading(true);
    try {
      const res = await api.post('/chat/admin-report');
      const dataWithTs = {
        ...res.data,
        generated_timestamp: res.data.generated_timestamp || Date.now()
      };
      setAiReportData(dataWithTs);
      try {
        localStorage.setItem('admin_ai_report_cache', JSON.stringify(dataWithTs));
      } catch (e) {
        console.error("Cache error", e);
      }
      if (showToast) {
        toast.success("Report AI aggiornato con successo!");
      }
    } catch (err) {
      console.error("Errore generazione report AI:", err);
      if (showToast) {
        toast.error(err.response?.data?.detail || "Errore nella generazione del report AI");
      }
    } finally {
      setAiReportLoading(false);
    }
  }

  function copyAiReport() {
    if (!aiReportData?.report) return;
    navigator.clipboard.writeText(aiReportData.report);
    toast.success("Report copiato negli appunti!");
  }

  function toggleAdminColumn(col) {
    setAdminVisibleColumns(prev => {
      const next = prev.includes(col) ? prev.filter(c => c !== col) : [...prev, col];
      localStorage.setItem('adminVisibleColumns', JSON.stringify(next));
      return next;
    });
  }

  useEffect(() => {
    loadData();
    // Controllo aggiornamento report alle 7:00
    if (isReportExpired(aiReportData)) {
      fetchAiReport(false);
    }
  }, []);

  useEffect(() => {
    // Controllo periodico ogni minuto se si sono superate le 07:00 per aggiornamento automatico
    const interval = setInterval(() => {
      if (isReportExpired(aiReportData)) {
        fetchAiReport(false);
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [aiReportData]);

  async function handleCreateUser(e) {
    e.preventDefault();
    try {
      await api.post('/auth/register', newUserForm);
      toast.success('Utente creato con successo!');
      setShowAddUserModal(false);
      setNewUserForm({
        username: '',
        email: '',
        full_name: '',
        password: '',
        role: 'viewer',
        department: 'ufficio_tecnico'
      });
      loadUsers();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Errore durante la creazione utente');
    }
  }

  async function loadAutomationRulesCount() {
    try {
      const { data } = await api.get('/automations/rules');
      if (Array.isArray(data)) {
        setAutomationRulesCount({
          total: data.length,
          active: data.filter(r => r.is_active).length
        });
      }
    } catch (err) {
      console.error('Errore caricamento regole automazioni:', err);
    }
  }

  async function loadData() {
    setLoading(true);
    try {
      await Promise.all([loadUsers(), loadZeroHoursAlerts(), loadPhaseTemplates(), loadGlobalBanners(), loadTicketPhases(), loadLastBackup(), loadEmailLogs(), loadTodoEmailSettings(), loadAutomationRulesCount()]);
    } finally {
      setLoading(false);
    }
  }

  async function loadZeroHoursAlerts() {
    setLoadingZeroHours(true);
    try {
      const { data } = await api.get('/replanning/zero-hours');
      setZeroHoursAlerts(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Errore caricamento mancata consuntivazione:', err);
    } finally {
      setLoadingZeroHours(false);
    }
  }

  const filteredZeroHours = zeroHoursAlerts.filter(item => {
    if (zeroHoursDeptFilter !== 'all' && item.department !== zeroHoursDeptFilter) return false;
    if (zeroHoursSearch.trim()) {
      const q = zeroHoursSearch.toLowerCase();
      const matchWorker = (item.worker || '').toLowerCase().includes(q);
      const matchProject = (item.project_name || '').toLowerCase().includes(q) || (item.project_code || '').toLowerCase().includes(q);
      const matchTask = (item.task_name || '').toLowerCase().includes(q);
      const matchDate = (item.formatted_date || item.date || '').toLowerCase().includes(q);
      if (!matchWorker && !matchProject && !matchTask && !matchDate) return false;
    }
    return true;
  });

  const zeroHoursPerPage = 10;
  const totalZeroHoursPages = Math.ceil(filteredZeroHours.length / zeroHoursPerPage) || 1;
  const currentZeroHoursPage = Math.min(zeroHoursPage, totalZeroHoursPages);
  const paginatedZeroHours = filteredZeroHours.slice((currentZeroHoursPage - 1) * zeroHoursPerPage, currentZeroHoursPage * zeroHoursPerPage);

  async function loadTodoEmailSettings() {
    try {
      const [{ data: emailSettings }, { data: smtp }] = await Promise.all([
        api.get('/settings/todo-email-settings'),
        api.get('/settings/smtp-settings'),
      ]);
      setTodoEmailSettings(emailSettings);
      setSmtpSettings(smtp);
    } catch (e) {
      console.error('Errore caricamento impostazioni email TODO:', e);
    }
  }

  async function saveTodoEmailSettings(e) {
    e.preventDefault();
    setSavingEmailSettings(true);
    try {
      const { data } = await api.put('/settings/todo-email-settings', todoEmailSettings);
      setTodoEmailSettings(data);
      toast.success('Impostazioni email TODO salvate');
    } catch {
      toast.error('Errore nel salvataggio delle impostazioni email');
    } finally {
      setSavingEmailSettings(false);
    }
  }

  async function loadGlobalBanners() {
    try {
      const { data } = await api.get('/settings/global-banner');
      setGlobalBanners(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    }
  }

  async function loadLastBackup() {
    try {
      const { data } = await api.get('/settings/backup/status');
      setLastBackup(data.last_backup);
    } catch (e) {
      console.error('Errore caricamento stato backup:', e);
    }
    loadBackups();
  }

  async function loadBackups() {
    try {
      const { data } = await api.get('/settings/backup/list');
      setBackups(Array.isArray(data.backups) ? data.backups : []);
    } catch (e) {
      console.error('Errore caricamento elenco backup:', e);
    }
  }

  async function handleRestoreBackup(filename) {
    if (!window.confirm(`Sei sicuro di voler ripristinare HiPlan dal backup "${filename}"? I dati attuali verranno sostituiti.`)) return;
    try {
      setRestoringBackup(filename);
      const { data } = await api.post('/settings/backup/restore', { filename });
      toast.success(data.message || 'Ripristino completato');
      await loadBackups();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Errore durante il ripristino');
    } finally {
      setRestoringBackup(null);
    }
  }

  async function handleRestoreUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!window.confirm(`Sei sicuro di voler ripristinare HiPlan dal file "${file.name}"? I dati attuali verranno sostituiti.`)) {
      e.target.value = '';
      return;
    }
    try {
      setUploadingBackup(true);
      const formData = new FormData();
      formData.append('file', file);
      const { data } = await api.post('/settings/backup/restore/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      toast.success(data.message || 'Ripristino completato');
      await loadBackups();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Errore durante il ripristino');
    } finally {
      setUploadingBackup(false);
      e.target.value = '';
    }
  }

  async function loadEmailLogs() {
    try {
      const [{ data: logs }, { data: sched }] = await Promise.all([
        api.get('/admin/email-logs'),
        api.get('/admin/email-logs/scheduled')
      ]);
      setEmailLogs(Array.isArray(logs) ? logs : []);
      setScheduledEmails(Array.isArray(sched) ? sched : []);
    } catch (e) {
      console.error(e);
    }
  }

  async function handleTriggerBackup() {
    try {
      toast.info('Avvio backup in corso...');
      const { data } = await api.post('/settings/backup/trigger');
      toast.success(data.message || 'Backup completato');
      if (data.last_backup) setLastBackup(data.last_backup);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Errore durante il backup');
    }
  }


  async function deleteScheduledEmail(todoId) {
    if (!window.confirm("Sei sicuro di voler annullare questa notifica programmata?")) return;
    try {
      await api.delete(`/admin/email-logs/scheduled/${todoId}`);
      toast.success('Notifica annullata');
      await loadEmailLogs();
    } catch {
      toast.error('Errore durante l\'annullamento della notifica');
    }
  }

  async function addGlobalBanner(e) {
    e.preventDefault();
    if (!globalBannerForm.text.trim()) return;

    let hours = globalBannerForm.duration_hours;
    if (globalBannerForm.isManualDate) {
      if (!globalBannerForm.manualDate) {
        toast.error('Seleziona una data di scadenza valida');
        return;
      }
      const expDate = new Date(globalBannerForm.manualDate);
      const now = new Date();
      if (expDate <= now) {
        toast.error('La data di scadenza deve essere futura');
        return;
      }
      hours = Math.ceil((expDate.getTime() - now.getTime()) / (1000 * 60 * 60));
    }

    try {
      const payload = {
        text: globalBannerForm.text,
        type: globalBannerForm.type,
        duration_hours: hours
      };
      const res = await api.post('/settings/global-banner', payload);
      setGlobalBanners(prev => [...prev, res.data]);
      setGlobalBannerForm({ text: '', type: 'info', duration_hours: 24, isManualDate: false, manualDate: '' });
      toast.success('Annuncio aggiunto con successo');
    } catch {
      toast.error('Errore aggiunta annuncio');
    }
  }

  async function deleteGlobalBanner(id) {
    if (!window.confirm("Sei sicuro di voler eliminare questo annuncio?")) return;
    try {
      await api.delete(`/settings/global-banner/${id}`);
      setGlobalBanners(prev => prev.filter(b => b.id !== id));
      toast.success('Annuncio eliminato');
    } catch {
      toast.error('Errore eliminazione annuncio');
    }
  }

  async function loadTicketPhases() {
    try {
      const res = await api.get('/settings/ticket_phases');
      setTicketPhases(res.data || []);
    } catch { /* ignore */ }
  }

  async function saveTicketPhases(phasesToSave) {
    try {
      const res = await api.put('/settings/ticket_phases', { phases: phasesToSave });
      setTicketPhases(res.data);
      toast.success('Fasi ticket aggiornate');
    } catch {
      toast.error('Errore aggiornamento fasi ticket');
    }
  }

  function handleAddTicketPhase() {
    if (!newTicketPhase.trim()) return;
    const nextPhases = [...ticketPhases, newTicketPhase.trim()];
    setNewTicketPhase('');
    saveTicketPhases(nextPhases);
  }

  function handleRemoveTicketPhase(index) {
    if (!window.confirm("Eliminare questa fase?")) return;
    const nextPhases = ticketPhases.filter((_, i) => i !== index);
    saveTicketPhases(nextPhases);
  }

  async function loadUsers() {
    try {
      const { data } = await api.get('/users');
      setUsers(data);
    } catch {
      toast.error('Errore caricamento utenti');
    }
  }

  async function loadPhaseTemplates() {
    try {
      const { data } = await api.get('/phase-templates', { params: { department: 'all' } });
      setPhaseTemplates(data);
    } catch {
      toast.error('Errore caricamento fasi preimpostate');
    }
  }

  async function handleSaveTemplate(e) {
    e.preventDefault();
    if (!templateForm.name.trim()) {
      toast.error('Il nome della fase è obbligatorio');
      return;
    }
    try {
      const payload = {
        ...templateForm,
        default_days: templateForm.default_days !== '' ? Number(templateForm.default_days) : null,
        default_hours: templateForm.default_hours !== '' ? Number(templateForm.default_hours) : null,
      };

      if (editingTemplate) {
        await api.put(`/phase-templates/${editingTemplate.id}`, payload);
        toast.success('Fase preimpostata modificata con successo');
      } else {
        await api.post('/phase-templates', { ...payload, is_custom: true });
        toast.success('Nuova fase preimpostata aggiunta con successo');
      }
      setShowAddTemplateModal(false);
      setEditingTemplate(null);
      setTemplateForm({ name: '', department: 'ufficio_tecnico', default_color: '#3b82f6', default_days: '', default_hours: '', default_budget_mode: 'start_days' });
      loadPhaseTemplates();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Errore durante il salvataggio della fase');
    }
  }

  async function handleDeleteTemplate(tpl) {
    if (!window.confirm(`Confermi l'eliminazione della fase preimpostata "${tpl.name}" dal reparto ${DEPT_LABELS[tpl.department] || tpl.department}?`)) return;
    try {
      await api.delete(`/phase-templates/${tpl.id}`);
      toast.success('Fase preimpostata eliminata');
      loadPhaseTemplates();
    } catch {
      toast.error('Errore durante l\'eliminazione della fase');
    }
  }

  function openEditTemplate(tpl) {
    setEditingTemplate(tpl);
    setTemplateForm({
      name: tpl.name,
      department: tpl.department,
      default_color: tpl.default_color || '#3b82f6',
      default_days: tpl.default_days != null ? tpl.default_days : '',
      default_hours: tpl.default_hours != null ? tpl.default_hours : '',
      default_budget_mode: tpl.default_budget_mode || 'start_days',
    });
    setShowAddTemplateModal(true);
  }

  function openNewTemplate() {
    setEditingTemplate(null);
    setTemplateForm({
      name: '',
      department: filterDept !== 'all' ? filterDept : 'ufficio_tecnico',
      default_color: DEPT_COLORS[filterDept] || '#3b82f6',
      default_days: '',
      default_hours: '',
      default_budget_mode: 'start_days',
    });
    setShowAddTemplateModal(true);
  }


  async function handleRoleChange(userId, newRole) {
    try {
      await api.patch(`/users/${userId}`, { role: newRole });
      toast.success('Ruolo aggiornato');
      loadUsers();
    } catch {
      toast.error('Errore aggiornamento ruolo');
    }
  }

  async function handleDepartmentChange(userId, newDept) {
    try {
      await api.patch(`/users/${userId}`, { department: newDept || null });
      toast.success('Reparto aggiornato');
      loadUsers();
    } catch {
      toast.error('Errore aggiornamento reparto');
    }
  }

  async function handleToggleActive(userId, isActive) {
    if (!window.confirm(`Confermi la ${isActive ? 'disattivazione' : 'riattivazione'} di questo utente?`)) return;
    try {
      await api.patch(`/users/${userId}`, { is_active: !isActive });
      toast.success(isActive ? 'Utente disattivato' : 'Utente attivato');
      loadUsers();
    } catch {
      toast.error('Errore aggiornamento stato');
    }
  }

  async function handleDeleteUser(user) {
    if (!window.confirm(`Confermi l'eliminazione definitiva dell'utente '${user.username}'?`)) return;
    try {
      await api.delete(`/users/${user.id}`);
      toast.success("Utente eliminato definitivamente");
      if (managingUser?.id === user.id) setManagingUser(null);
      loadUsers();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Errore durante l'eliminazione dell'utente");
    }
  }

  async function handleResetPassword(e) {
    e.preventDefault();
    if (newPassword.length < 6) {
      toast.error("La password deve essere di almeno 6 caratteri");
      return;
    }
    if (!window.confirm(`Confermi di voler reimpostare la password per '${managingUser.username}'?`)) return;
    try {
      await api.post(`/users/${managingUser.id}/reset-password`, { new_password: newPassword });
      toast.success("Password reimpostata con successo");
      setNewPassword('');
    } catch (err) {
      toast.error(err.response?.data?.detail || "Errore durante il reset della password");
    }
  }


  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;

  return (
    <div className="admin-page animate-fadeIn">

      {/* SEZIONE REPORTISTICA AI */}
      <div className={`admin-section-card ${collapsedSections.aiReport ? 'is-collapsed' : ''}`} style={{
        marginBottom: 30,
        background: 'linear-gradient(135deg, var(--bg-card) 0%, rgba(99, 102, 241, 0.04) 100%)',
        border: '1px solid var(--border-default)',
        position: 'relative',
        overflow: 'hidden'
      }}>
        <div className="admin-section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ cursor: 'pointer', flex: 1 }} onClick={() => toggleSection('aiReport')}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                  color: '#fff',
                  boxShadow: '0 2px 6px rgba(99, 102, 241, 0.3)'
                }}>
                  <AppIcon name="robot" size={17} />
                </span>
                Reportistica & Analisi AI
              </h2>
            </div>
            <p className="admin-section-desc">Resoconto intelligente a 360° su commesse, attività TODO, ticket di assistenza e pipeline di preventivazione salvato in cache.</p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
            {aiReportData && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={(e) => { e.stopPropagation(); copyAiReport(); }}
                title="Copia report negli appunti"
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px' }}
              >
                <AppIcon name="copy" size={13} />
                Copia
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={aiReportLoading}
              onClick={(e) => { e.stopPropagation(); fetchAiReport(true); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: '12px',
                background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
                borderColor: '#4f46e5'
              }}
            >
              <AppIcon name={aiReportLoading ? "spinner" : "refresh"} size={13} className={aiReportLoading ? "spin" : ""} />
              {aiReportLoading ? "Analisi in corso..." : (aiReportData ? "Aggiorna Report" : "Genera Report")}
            </button>
            <div style={{ cursor: 'pointer', color: 'var(--text-muted)', marginLeft: 6 }} onClick={() => toggleSection('aiReport')}>
              <AppIcon name={collapsedSections.aiReport ? 'chevronDown' : 'chevronUp'} size={18} />
            </div>
          </div>
        </div>

        {/* KPI Cards: sempre visibili anche a sezione compressa su una sola riga */}
        {aiReportData?.kpis && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(9, minmax(0, 1fr))',
            gap: 8,
            marginTop: 18,
            marginBottom: collapsedSections.aiReport ? 0 : 16,
            overflowX: 'auto',
            paddingBottom: 2
          }}>
            <div style={{ background: 'var(--bg-secondary)', padding: '10px 8px', borderRadius: 8, border: '1px solid var(--border-subtle)', minWidth: 0 }} title="Commesse Attive">
              <div style={{ fontSize: '9.5px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Commesse Attive</div>
              <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#6366f1', marginTop: 2, lineHeight: 1.2 }}>{aiReportData.kpis.active_projects ?? 0}</div>
            </div>
            <div style={{ background: 'var(--bg-secondary)', padding: '10px 8px', borderRadius: 8, border: '1px solid var(--border-subtle)', minWidth: 0 }} title="In Pianificazione">
              <div style={{ fontSize: '9.5px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>In Pianificazione</div>
              <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#f59e0b', marginTop: 2, lineHeight: 1.2 }}>{aiReportData.kpis.planning_projects ?? 0}</div>
            </div>
            <div style={{ background: 'var(--bg-secondary)', padding: '10px 8px', borderRadius: 8, border: '1px solid var(--border-subtle)', minWidth: 0 }} title="Fasi in Corso">
              <div style={{ fontSize: '9.5px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Fasi in Corso</div>
              <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#3b82f6', marginTop: 2, lineHeight: 1.2 }}>{aiReportData.kpis.active_tasks ?? 0}</div>
            </div>
            <div style={{ background: 'var(--bg-secondary)', padding: '10px 8px', borderRadius: 8, border: '1px solid var(--border-subtle)', minWidth: 0 }} title="Fasi in Ritardo">
              <div style={{ fontSize: '9.5px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Fasi in Ritardo</div>
              <div style={{ fontSize: '1.2rem', fontWeight: 700, color: (aiReportData.kpis.overdue_tasks > 0) ? '#ef4444' : '#10b981', marginTop: 2, lineHeight: 1.2 }}>{aiReportData.kpis.overdue_tasks ?? 0}</div>
            </div>
            <div style={{ background: 'var(--bg-secondary)', padding: '10px 8px', borderRadius: 8, border: '1px solid var(--border-subtle)', minWidth: 0 }} title="Addetti Coinvolti">
              <div style={{ fontSize: '9.5px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Addetti Coinvolti</div>
              <div style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)', marginTop: 2, lineHeight: 1.2 }}>{aiReportData.kpis.total_workers ?? 0}</div>
            </div>
            <div style={{ background: 'var(--bg-secondary)', padding: '10px 8px', borderRadius: 8, border: '1px solid var(--border-subtle)', minWidth: 0 }} title="Scadenze a 7gg">
              <div style={{ fontSize: '9.5px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Scadenze a 7gg</div>
              <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#ec4899', marginTop: 2, lineHeight: 1.2 }}>{aiReportData.kpis.upcoming_deadlines_count ?? 0}</div>
            </div>
            <div style={{ background: 'var(--bg-secondary)', padding: '10px 8px', borderRadius: 8, border: '1px solid var(--border-subtle)', minWidth: 0 }} title="TODO in Sospeso">
              <div style={{ fontSize: '9.5px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>TODO in Sospeso</div>
              <div style={{ fontSize: '1.2rem', fontWeight: 700, color: (aiReportData.kpis.overdue_todos > 0) ? '#f43f5e' : '#8b5cf6', marginTop: 2, lineHeight: 1.2, display: 'flex', alignItems: 'baseline', gap: 4 }}>
                {aiReportData.kpis.pending_todos ?? 0}
                {aiReportData.kpis.overdue_todos > 0 && (
                  <span style={{ fontSize: '0.6rem', color: '#ef4444', fontWeight: 600 }}>({aiReportData.kpis.overdue_todos})</span>
                )}
              </div>
            </div>
            <div style={{ background: 'var(--bg-secondary)', padding: '10px 8px', borderRadius: 8, border: '1px solid var(--border-subtle)', minWidth: 0 }} title="Ticket da Gestire">
              <div style={{ fontSize: '9.5px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Ticket da Gestire</div>
              <div style={{ fontSize: '1.2rem', fontWeight: 700, color: (aiReportData.kpis.high_priority_tickets > 0) ? '#ef4444' : '#f59e0b', marginTop: 2, lineHeight: 1.2, display: 'flex', alignItems: 'baseline', gap: 4 }}>
                {aiReportData.kpis.open_tickets ?? 0}
                {aiReportData.kpis.high_priority_tickets > 0 && (
                  <span style={{ fontSize: '0.6rem', color: '#ef4444', fontWeight: 600 }}>({aiReportData.kpis.high_priority_tickets})</span>
                )}
              </div>
            </div>
            <div style={{ background: 'var(--bg-secondary)', padding: '10px 8px', borderRadius: 8, border: '1px solid var(--border-subtle)', minWidth: 0 }} title="Preventivi Attivi">
              <div style={{ fontSize: '9.5px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Preventivi Attivi</div>
              <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#10b981', marginTop: 2, lineHeight: 1.2 }}>{aiReportData.kpis.active_preventivi ?? 0}</div>
            </div>
          </div>
        )}

        {/* Dettaglio del report: mostrato solo se espanso */}
        {!collapsedSections.aiReport && (
          <div className="admin-section-content" style={{ marginTop: 14 }}>
            {/* Timestamp bar */}
            {aiReportData?.generated_at && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '7px 14px',
                background: 'rgba(99, 102, 241, 0.06)',
                borderRadius: 6,
                border: '1px solid rgba(99, 102, 241, 0.18)',
                marginBottom: 14,
                fontSize: '11.5px',
                color: 'var(--text-secondary)'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <AppIcon name="clock" size={13} />
                  <span>Report generato il <strong>{aiReportData.generated_at}</strong> (aggiornato ogni giorno alle ore 07:00)</span>
                </div>
              </div>
            )}

            {/* Report Content */}
            {aiReportLoading ? (
              <div style={{
                padding: '36px 20px',
                textAlign: 'center',
                background: 'var(--bg-secondary)',
                borderRadius: 10,
                border: '1px dashed var(--border-default)'
              }}>
                <div className="spinner" style={{ margin: '0 auto 12px' }} />
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>HiPlan AI sta analizzando...</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Elaborazione commesse attive, carico addetti, checklist TODO, ticket aperti e pipeline preventivi</div>
              </div>
            ) : aiReportData?.report ? (
              <div className="ai-report-markdown" style={{
                padding: '18px 22px',
                background: 'var(--bg-secondary)',
                borderRadius: 10,
                border: '1px solid var(--border-subtle)',
                lineHeight: 1.65,
                fontSize: '13.5px',
                color: 'var(--text-primary)'
              }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {aiReportData.report}
                </ReactMarkdown>
              </div>
            ) : (
              <div style={{
                padding: '30px 20px',
                textAlign: 'center',
                background: 'var(--bg-secondary)',
                borderRadius: 10,
                border: '1px dashed var(--border-default)'
              }}>
                <AppIcon name="robot" size={28} style={{ color: '#6366f1', marginBottom: 8 }} />
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>Nessun report dettagliato in cache</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, marginBottom: 16 }}>
                  Clicca sul pulsante qui sotto per avviare l'analisi dello stato delle commesse e degli addetti.
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => fetchAiReport(true)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
                    borderColor: '#4f46e5'
                  }}
                >
                  <AppIcon name="sparkles" size={14} />
                  Genera Report Esecutivo AI
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* SEZIONE BACHECA AZIENDALE */}
      <div className={`admin-section-card ${collapsedSections.annunci ? 'is-collapsed' : ''}`} style={{ marginBottom: 30 }}>
        <div className="admin-section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ cursor: 'pointer', flex: 1 }} onClick={() => toggleSection('annunci')}>
            <h2><AppIcon name="megaphone" /> Annunci</h2>
            <p className="admin-section-desc">Annunci in evidenza che appariranno a tutti gli utenti in cima alla Dashboard.</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 4 }}>
            <div style={{ cursor: 'pointer', color: 'var(--text-muted)' }} onClick={() => toggleSection('annunci')}>
              <AppIcon name={collapsedSections.annunci ? 'chevronDown' : 'chevronUp'} size={18} />
            </div>
          </div>
        </div>
        {!collapsedSections.annunci && (
          <div className="admin-section-content">
            <form onSubmit={addGlobalBanner} style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="input-group" style={{ flex: 1, minWidth: 250, marginBottom: 0 }}>
                <input
                  className="input"
                  placeholder="Es. Venerdì gli uffici chiudono alle 16:00..."
                  value={globalBannerForm.text}
                  onChange={(e) => setGlobalBannerForm({ ...globalBannerForm, text: e.target.value })}
                />
              </div>
              <div className="input-group" style={{ width: 150, marginBottom: 0 }}>
                <select
                  className="input"
                  value={globalBannerForm.type}
                  onChange={(e) => setGlobalBannerForm({ ...globalBannerForm, type: e.target.value })}
                >
                  <option value="info">Info</option>
                  <option value="warning">Avviso</option>
                  <option value="success">Successo</option>
                  <option value="error">Urgente</option>
                </select>
              </div>
              <div className="input-group" style={{ width: 140, marginBottom: 0 }}>
                <select
                  className="input"
                  value={globalBannerForm.isManualDate ? 'manual' : globalBannerForm.duration_hours}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === 'manual') {
                      setGlobalBannerForm({ ...globalBannerForm, isManualDate: true });
                    } else {
                      setGlobalBannerForm({ ...globalBannerForm, isManualDate: false, duration_hours: Number(val) });
                    }
                  }}
                >
                  <option value={12}>1/2 Giornata</option>
                  <option value={24}>1 Giorno</option>
                  <option value={48}>2 Giorni</option>
                  <option value={168}>1 Settimana</option>
                  <option value={336}>2 Settimane</option>
                  <option value={504}>3 Settimane</option>
                  <option value={720}>1 Mese</option>
                  <option value="manual">Data Manuale...</option>
                </select>
              </div>
              {globalBannerForm.isManualDate && (
                <div className="input-group" style={{ width: 200, marginBottom: 0 }}>
                  <input
                    type="datetime-local"
                    className="input"
                    value={globalBannerForm.manualDate}
                    min={new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)}
                    onChange={(e) => setGlobalBannerForm({ ...globalBannerForm, manualDate: e.target.value })}
                  />
                </div>
              )}
              <button type="submit" className="btn btn-primary" style={{ height: 42 }}>
                Aggiungi Annuncio
              </button>
            </form>

            {globalBanners.length > 0 && (
              <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <h4 style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Annunci Attivi</h4>
                {globalBanners.map(b => (
                  <div key={b.id} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    background: 'var(--bg-tertiary)', padding: '10px 14px', borderRadius: 'var(--radius-sm)',
                    borderLeft: `3px solid ${b.type === 'error' ? '#ef4444' : b.type === 'warning' ? '#f59e0b' : b.type === 'success' ? '#10b981' : '#3b82f6'}`
                  }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: '0.9rem', fontWeight: 500 }}>{b.text}</span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        Creato: {new Date(b.created_at).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        {' | '}Scadenza: {new Date(new Date(b.created_at).getTime() + (b.duration_hours || 24) * 60 * 60 * 1000).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <button onClick={() => deleteGlobalBanner(b.id)} className="btn btn-ghost" style={{ padding: '6px 10px', color: 'var(--text-muted)' }} title="Elimina annuncio">
                      <AppIcon name="trash" size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* SEZIONE AUTOMAZIONI SENZA CODICE */}
      <div
        className="admin-section-card is-collapsed"
        style={{
          marginBottom: 8,
          cursor: 'pointer'
        }}
        onClick={() => navigate('/admin/automations')}
      >
        <div
          className="admin-section-header"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 16,
            margin: 0,
            padding: 0,
            borderBottom: 0
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
                <AppIcon name="zap" /> Automazioni Senza Codice
              </h2>
              <span className="badge badge-primary" style={{ fontSize: '0.75rem', fontWeight: 600 }}>
                {automationRulesCount.active} attive / {automationRulesCount.total} totali
              </span>
            </div>
            <p className="admin-section-desc" style={{ margin: '4px 0 0 0' }}>
              Regole automatiche su avanzamento fasi, consuntivi ore a budget e scadenze con creazione automatica TODO o alert.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              className="btn btn-primary btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                navigate('/admin/automations');
              }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
            >
              <AppIcon name="zap" size={14} />
              Gestisci Automazioni &rarr;
            </button>
          </div>
        </div>
      </div>

      {/* SEZIONE 1: UTENTI DI SISTEMA */}
      <div className={`admin-section-card ${collapsedSections.users ? 'is-collapsed' : ''}`}>
        <div className="admin-section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ cursor: 'pointer', flex: 1 }} onClick={() => toggleSection('users')}>
            <h2><AppIcon name="users" /> Utenti di sistema</h2>
            <p className="admin-section-desc">Utenti registrati con credenziali di login per accedere al gestionale HiPlan ({users.length})</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 4 }}>
            {!collapsedSections.users && (
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => setShowAddUserModal(true)}
                >
                  <AppIcon name="plus" />
                  Crea Utente
                </button>
                <div style={{ position: 'relative' }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setShowAdminColumnsMenu(!showAdminColumnsMenu)}
                  >
                    <AppIcon name="columns" />
                    Colonne
                  </button>
                  {showAdminColumnsMenu && (
                    <div className="dropdown-menu" style={{ position: 'absolute', right: 0, top: '100%', marginTop: 8, zIndex: 50, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 8, boxShadow: 'var(--shadow-lg)', minWidth: 200 }}>
                      {['utente', 'email', 'ruolo', 'reparto', 'stato', 'registrato', 'azioni'].map(col => (
                        <label key={col} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', cursor: 'pointer', textTransform: 'capitalize' }}>
                          <input
                            type="checkbox"
                            checked={adminVisibleColumns.includes(col)}
                            onChange={() => toggleAdminColumn(col)}
                          />
                          {col}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            <div style={{ cursor: 'pointer', color: 'var(--text-muted)' }} onClick={() => toggleSection('users')}>
              <AppIcon name={collapsedSections.users ? 'chevronDown' : 'chevronUp'} size={18} />
            </div>
          </div>
        </div>

        {!collapsedSections.users && (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  {adminVisibleColumns.includes('utente') && <th>Utente</th>}
                  {adminVisibleColumns.includes('email') && <th>Email</th>}
                  {adminVisibleColumns.includes('ruolo') && <th>Ruolo</th>}
                  {adminVisibleColumns.includes('reparto') && <th>Reparto</th>}
                  {adminVisibleColumns.includes('stato') && <th>Stato</th>}
                  {adminVisibleColumns.includes('registrato') && <th>Registrato</th>}
                  {adminVisibleColumns.includes('azioni') && <th>Azioni</th>}
                </tr>
              </thead>
              <tbody>
                {[...users].sort((a, b) => (a.full_name || a.username || '').localeCompare(b.full_name || b.username || '', 'it')).map((u) => (
                  <tr key={u.id}>
                    {adminVisibleColumns.includes('utente') && (
                      <td>
                        <div className="admin-user-cell">
                          <div className="sidebar-avatar" style={{ width: 30, height: 30, fontSize: '0.75rem' }}>
                            {u.username?.[0]?.toUpperCase() || '?'}
                          </div>
                          <div>
                            <span className="admin-username">{u.full_name || u.username}</span>
                            <span className="admin-handle">@{u.username}</span>
                          </div>
                        </div>
                      </td>
                    )}
                    {adminVisibleColumns.includes('email') && <td>{u.email}</td>}
                    {adminVisibleColumns.includes('ruolo') && (
                      <td>
                        <select
                          className="input"
                          value={u.role}
                          onChange={(e) => handleRoleChange(u.id, e.target.value)}
                          style={{ padding: '6px 32px 6px 10px', fontSize: '0.8125rem', minWidth: 100 }}
                        >
                          <option value="admin">Admin</option>
                          <option value="editor">Editor</option>
                          <option value="viewer">Viewer</option>
                        </select>
                      </td>
                    )}
                    {adminVisibleColumns.includes('reparto') && (
                      <td>
                        <select
                          className="input"
                          value={u.department || ''}
                          onChange={(e) => handleDepartmentChange(u.id, e.target.value)}
                          style={{ padding: '6px 32px 6px 10px', fontSize: '0.8125rem', width: 'max-content', minWidth: 160 }}
                        >
                          <option value="">— Nessun reparto —</option>
                          <option value="ufficio_tecnico">Ufficio Tecnico</option>
                          <option value="produzione">Produzione</option>
                          <option value="amministrazione">Amministrazione</option>
                          <option value="acquisti">Acquisti</option>
                          <option value="commerciale">Commerciale</option>
                          <option value="admin">Admin</option>
                        </select>
                      </td>
                    )}
                    {adminVisibleColumns.includes('stato') && (
                      <td>
                        <span className={`badge ${u.is_active ? 'badge-active' : 'badge-archived'}`}>
                          {u.is_active ? 'Attivo' : 'Disattivato'}
                        </span>
                      </td>
                    )}
                    {adminVisibleColumns.includes('registrato') && (
                      <td style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                        {u.created_at ? new Date(u.created_at).toLocaleDateString('it-IT') : '-'}
                      </td>
                    )}
                    {adminVisibleColumns.includes('azioni') && (
                      <td>
                        <button
                          className="btn btn-sm btn-secondary"
                          onClick={() => { setManagingUser(u); setNewPassword(''); }}
                        >
                          Gestisci
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* SEZIONE: MANCATA CONSUNTIVAZIONE ORE */}
      <div className={`admin-section-card ${collapsedSections.zeroHours ? 'is-collapsed' : ''}`} style={{ marginTop: 32 }}>
        <div className="admin-section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ cursor: 'pointer', flex: 1 }} onClick={() => toggleSection('zeroHours')}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h2><AppIcon name="clock" /> Mancata consuntivazione ore</h2>
              {zeroHoursAlerts.length > 0 && (
                <span className="badge" style={{ backgroundColor: 'rgba(239, 68, 68, 0.12)', color: '#ef4444', fontWeight: 600, fontSize: '0.75rem', padding: '2px 8px', borderRadius: 999 }}>
                  {zeroHoursAlerts.length}
                </span>
              )}
            </div>
            <p className="admin-section-desc">
              Rilevamento addetti che non hanno consuntivato ore nelle date lavorative previste ({zeroHoursAlerts.length} segnalazioni)
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 4 }}>
            {!collapsedSections.zeroHours && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={loadZeroHoursAlerts}
                disabled={loadingZeroHours}
                title="Ricarica allerte"
              >
                <AppIcon name="refresh" />
                Aggiorna
              </button>
            )}
            <div style={{ cursor: 'pointer', color: 'var(--text-muted)' }} onClick={() => toggleSection('zeroHours')}>
              <AppIcon name={collapsedSections.zeroHours ? 'chevronDown' : 'chevronUp'} size={18} />
            </div>
          </div>
        </div>

        {!collapsedSections.zeroHours && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', flex: 1 }}>
                <input
                  type="text"
                  className="input"
                  placeholder="Cerca addetto, commessa o fase..."
                  value={zeroHoursSearch}
                  onChange={(e) => { setZeroHoursSearch(e.target.value); setZeroHoursPage(1); }}
                  style={{ maxWidth: 320, fontSize: '0.85rem' }}
                />
                <select
                  className="input"
                  value={zeroHoursDeptFilter}
                  onChange={(e) => { setZeroHoursDeptFilter(e.target.value); setZeroHoursPage(1); }}
                  style={{ maxWidth: 200, fontSize: '0.85rem' }}
                >
                  <option value="all">Tutti i reparti</option>
                  <option value="ufficio_tecnico">Ufficio Tecnico</option>
                  <option value="produzione">Produzione</option>
                  <option value="amministrazione">Amministrazione</option>
                  <option value="acquisti">Acquisti</option>
                  <option value="commerciale">Commerciale</option>
                </select>
              </div>
              <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                Visualizzate <strong>{filteredZeroHours.length}</strong> segnalazioni
              </div>
            </div>

            {loadingZeroHours ? (
              <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-secondary)' }}>
                Caricamento segnalazioni...
              </div>
            ) : filteredZeroHours.length === 0 ? (
              <div className="backup-empty" style={{ padding: 28, textAlign: 'center' }}>
                <div style={{ fontSize: '1.5rem', marginBottom: 8 }}>✅</div>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
                  Nessuna mancata consuntivazione rilevata
                </div>
                <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                  Tutti gli addetti assegnati alle fasi attive hanno registrato regolarmente le loro ore.
                </div>
              </div>
            ) : (
              <>
                <div className="table-wrapper">
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: 110 }}>Data</th>
                        <th>Addetto</th>
                        <th>Commessa</th>
                        <th>Fase</th>
                        <th>Reparto</th>
                        <th style={{ textAlign: 'right', width: 150 }}>Azione</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedZeroHours.map((alert) => (
                        <tr key={alert.id}>
                          <td>
                            <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                              {alert.formatted_date || alert.date}
                            </div>
                          </td>
                          <td>
                            <div className="admin-user-cell" style={{ gap: 10 }}>
                              <div
                                className="sidebar-avatar"
                                style={{
                                  width: 28,
                                  height: 28,
                                  fontSize: '0.75rem',
                                  fontWeight: 700,
                                  borderRadius: 8,
                                  background: alert.department && DEPT_COLORS[alert.department]
                                    ? `linear-gradient(135deg, ${DEPT_COLORS[alert.department]}, ${DEPT_COLORS[alert.department]}cc)`
                                    : 'var(--sidebar-avatar-bg)',
                                  color: '#ffffff',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  boxShadow: '0 2px 6px rgba(0,0,0,0.12)'
                                }}
                              >
                                {alert.worker?.[0]?.toUpperCase() || '?'}
                              </div>
                              <span style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                                {alert.worker}
                              </span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              {alert.project_code && (
                                <span className="badge" style={{ alignSelf: 'flex-start', fontSize: '0.7rem', padding: '1px 6px', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                                  {alert.project_code}
                                </span>
                              )}
                              <span style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-primary)' }}>
                                {alert.project_name}
                              </span>
                            </div>
                          </td>
                          <td>
                            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                              {alert.task_name}
                            </span>
                          </td>
                          <td>
                            {alert.department ? (
                              <span
                                className="badge"
                                style={{
                                  backgroundColor: `${DEPT_COLORS[alert.department] || '#64748b'}20`,
                                  color: DEPT_COLORS[alert.department] || 'var(--text-secondary)',
                                  border: `1px solid ${DEPT_COLORS[alert.department] || '#64748b'}40`,
                                  fontSize: '0.75rem',
                                  padding: '2px 8px'
                                }}
                              >
                                {DEPT_LABELS[alert.department] || alert.department}
                              </span>
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>-</span>
                            )}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <button
                              className="btn btn-sm btn-secondary"
                              onClick={() => navigate(`/projects/${alert.project_id}`)}
                              title="Vai al Gantt della commessa"
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.8rem' }}
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

                {totalZeroHoursPages > 1 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
                    <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                      Pagina {currentZeroHoursPage} di {totalZeroHoursPages}
                    </span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        className="btn btn-sm btn-secondary"
                        disabled={currentZeroHoursPage <= 1}
                        onClick={() => setZeroHoursPage(prev => Math.max(prev - 1, 1))}
                      >
                        Precedente
                      </button>
                      <button
                        className="btn btn-sm btn-secondary"
                        disabled={currentZeroHoursPage >= totalZeroHoursPages}
                        onClick={() => setZeroHoursPage(prev => Math.min(prev + 1, totalZeroHoursPages))}
                      >
                        Successiva
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* SEZIONE 2: FASI DI LAVORAZIONE PREIMPOSTATE */}
      <div className={`admin-section-card ${collapsedSections.templates ? 'is-collapsed' : ''}`} style={{ marginTop: 32 }}>
        <div className="admin-section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ cursor: 'pointer', flex: 1 }} onClick={() => toggleSection('templates')}>
            <h2><AppIcon name="list" /> Fasi di lavorazione preimpostate</h2>
            <p className="admin-section-desc">
              Gestisci l'elenco delle fasi suggerite nel menu a tendina quando gli addetti creano o modificano le attività di commessa ({phaseTemplates.filter(t => filterDept === 'all' || t.department === filterDept || t.department === 'condivisa').length} visualizzate).
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 4 }}>
            {!collapsedSections.templates && (
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <select
                  className="input"
                  value={filterDept}
                  onChange={(e) => setFilterDept(e.target.value)}
                  style={{ padding: '6px 12px', fontSize: '0.85rem', fontWeight: 600 }}
                >
                  <option value="all">Tutti i reparti ({phaseTemplates.length})</option>
                  <option value="ufficio_tecnico">Ufficio Tecnico ({phaseTemplates.filter(t => t.department === 'ufficio_tecnico').length})</option>
                  <option value="produzione">Produzione ({phaseTemplates.filter(t => t.department === 'produzione').length})</option>
                  <option value="amministrazione">Amministrazione ({phaseTemplates.filter(t => t.department === 'amministrazione').length})</option>
                  <option value="acquisti">Acquisti ({phaseTemplates.filter(t => t.department === 'acquisti').length})</option>
                  <option value="commerciale">Commerciale ({phaseTemplates.filter(t => t.department === 'commerciale').length})</option>
                  <option value="condivisa">Condivisa tra più reparti ({phaseTemplates.filter(t => t.department === 'condivisa').length})</option>
                </select>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={openNewTemplate}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <span>+</span> Nuova Fase Preimpostata
                </button>
              </div>
            )}
            <div style={{ cursor: 'pointer', color: 'var(--text-muted)' }} onClick={() => toggleSection('templates')}>
              <AppIcon name={collapsedSections.templates ? 'chevronDown' : 'chevronUp'} size={18} />
            </div>
          </div>
        </div>

        {!collapsedSections.templates && (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>Nome Fase / Lavorazione</th>
                  <th>Reparto Assegnato</th>
                  <th>Colore Predefinito</th>
                  <th>Modalità / Budget</th>
                  <th>Tipo</th>
                  <th style={{ width: 120 }}>Azioni</th>
                </tr>
              </thead>
              <tbody>
                {phaseTemplates.filter(t => filterDept === 'all' || t.department === filterDept || t.department === 'condivisa').length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', padding: '30px 10px', color: 'var(--text-muted)' }}>
                      Nessuna fase preimpostata per il filtro selezionato.
                    </td>
                  </tr>
                ) : (
                  phaseTemplates.filter(t => filterDept === 'all' || t.department === filterDept || t.department === 'condivisa').sort((a, b) => (a.name || '').localeCompare(b.name || '', 'it')).map((tpl) => (
                    <tr key={tpl.id}>
                      <td>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ display: 'inline-block', width: 14, height: 14, borderRadius: '50%', background: tpl.default_color || '#3b82f6', border: '1px solid var(--border-default)', flexShrink: 0 }} />
                          <span>{tpl.name}</span>
                        </div>
                      </td>
                      <td>
                        <span className="badge" style={{ background: DEPT_COLORS[tpl.department] ? `${DEPT_COLORS[tpl.department]}20` : 'var(--bg-tertiary)', color: DEPT_COLORS[tpl.department] || 'var(--text-secondary)', border: `1px solid ${DEPT_COLORS[tpl.department] || 'var(--border)'}40` }}>
                          {DEPT_LABELS[tpl.department] || (tpl.department === 'condivisa' ? 'Condivisa tra più reparti' : tpl.department)}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'monospace', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                          <span style={{ display: 'inline-block', width: 22, height: 22, borderRadius: 6, background: tpl.default_color || '#3b82f6', border: '1px solid var(--border-default)' }} />
                          {tpl.default_color || '#3b82f6'}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontSize: '0.82rem', color: 'var(--text-primary)' }}>
                          <span style={{ fontWeight: 600 }}>{tpl.default_days != null ? `${tpl.default_days} gg` : '-'}</span>
                          <span style={{ color: 'var(--text-muted)', margin: '0 4px' }}>·</span>
                          <span style={{ fontWeight: 600, color: 'var(--accent-600)' }}>{tpl.default_hours != null ? `${tpl.default_hours}h` : '-'}</span>
                        </div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>
                          {BUDGET_MODE_SHORT_LABELS[tpl.default_budget_mode || 'start_days'] || tpl.default_budget_mode}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${tpl.is_custom ? 'badge-archived' : 'badge-active'}`}>
                          {tpl.is_custom ? 'Personalizzata' : 'Predefinita'}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            className="btn btn-secondary btn-icon"
                            onClick={() => openEditTemplate(tpl)}
                            title="Modifica nome, reparto o colore"
                            aria-label="Modifica fase preimpostata"
                          >
                            <AppIcon name="edit" size={15} />
                          </button>
                          <button
                            className="btn btn-ghost btn-icon"
                            style={{ color: 'var(--danger)' }}
                            onClick={() => handleDeleteTemplate(tpl)}
                            title="Elimina fase preimpostata"
                            aria-label="Elimina fase preimpostata"
                          >
                            <AppIcon name="trash" size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* SEZIONE 3: FASI TICKET */}
      <div className={`admin-section-card ${collapsedSections.ticketPhases ? 'is-collapsed' : ''}`} style={{ marginTop: 32 }}>
        <div className="admin-section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ cursor: 'pointer', flex: 1 }} onClick={() => toggleSection('ticketPhases')}>
            <h2><AppIcon name="ticket" /> Fasi ticket</h2>
            <p className="admin-section-desc">
              Personalizza l'elenco delle fasi o eventi selezionabili quando si risponde a un ticket (es. "Inviato al cliente", "In lavorazione").
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 4 }}>
            <div style={{ cursor: 'pointer', color: 'var(--text-muted)' }} onClick={() => toggleSection('ticketPhases')}>
              <AppIcon name={collapsedSections.ticketPhases ? 'chevronDown' : 'chevronUp'} size={18} />
            </div>
          </div>
        </div>
        {!collapsedSections.ticketPhases && (
          <div style={{ maxWidth: '100%' }}>
            <div className="ticket-phases-list" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 12 }}>
              {ticketPhases.map((phase, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-tertiary)', padding: '6px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 500 }}>{phase}</span>
                  <button
                    className="btn-icon"
                    onClick={() => handleRemoveTicketPhase(i)}
                    style={{ color: 'var(--danger)', opacity: 0.7 }}
                    title="Elimina fase ticket"
                  >
                    <AppIcon name="trash" size={15} />
                  </button>
                </div>
              ))}
              {ticketPhases.length === 0 && (
                <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: '0.9rem', gridColumn: '1 / -1' }}>
                  Nessuna fase personalizzata impostata.
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 12, maxWidth: 800 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                placeholder="Es: Risposta dal cliente"
                value={newTicketPhase}
                onChange={e => setNewTicketPhase(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAddTicketPhase(); }}
              />
              <button className="btn btn-primary" onClick={handleAddTicketPhase}>
                Aggiungi Fase
              </button>
            </div>
          </div>
        )}
      </div>

      {/* SEZIONE PREVENTIVAZIONE (RICHIESTE COMMERCIALI) */}
      <RichiesteCommercialiAdminSection users={users} toast={toast} />

      {/* SEZIONE LOG EMAIL */}
      <div className={`admin-section-card ${collapsedSections.emails ? 'is-collapsed' : ''}`} style={{ marginTop: 32, marginBottom: 30 }}>
        <div className="admin-section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ cursor: 'pointer', flex: 1 }} onClick={() => toggleSection('emails')}>
            <h2><AppIcon name="mail" /> Notifiche email</h2>
            <p className="admin-section-desc">Cronologia delle comunicazioni e riepilogo degli invii futuri.</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 4 }}>
            {!collapsedSections.emails && (
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <div className="tabs" style={{ display: 'flex', gap: 8 }}>
                  <button
                    className={`btn btn-sm ${emailLogTab === 'sent' ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setEmailLogTab('sent')}
                  >
                    Inviate ({emailLogs.length})
                  </button>
                  <button
                    className={`btn btn-sm ${emailLogTab === 'scheduled' ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setEmailLogTab('scheduled')}
                  >
                    Programmate ({scheduledEmails.length})
                  </button>
                </div>
              </div>
            )}
            <div style={{ cursor: 'pointer', color: 'var(--text-muted)' }} onClick={() => toggleSection('emails')}>
              <AppIcon name={collapsedSections.emails ? 'chevronDown' : 'chevronUp'} size={18} />
            </div>
          </div>
        </div>

        {!collapsedSections.emails && (
          <div className="table-wrapper" style={{ maxHeight: 520, overflowY: 'auto' }}>
            {emailLogTab === 'sent' ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Destinatario</th>
                    <th>Oggetto</th>
                    <th>Stato</th>
                    <th>Errore</th>
                  </tr>
                </thead>
                <tbody>
                  {emailLogs.length === 0 ? (
                    <tr>
                      <td colSpan="5" style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>
                        Nessuna email inviata di recente.
                      </td>
                    </tr>
                  ) : (
                    emailLogs.map(log => (
                      <tr key={log.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{new Date(log.created_at).toLocaleString()}</td>
                        <td>{log.recipient}</td>
                        <td>{log.subject}</td>
                        <td>
                          {log.status === 'success' ? (
                            <span className="badge badge-success">Inviata</span>
                          ) : (
                            <span className="badge badge-error">Errore</span>
                          )}
                        </td>
                        <td style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>
                          {log.error_message || '-'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Data Prevista</th>
                    <th>Tipo Promemoria</th>
                    <th>Oggetto</th>
                    <th>Destinatari</th>
                    <th style={{ width: 80, textAlign: 'center' }}>Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {scheduledEmails.length === 0 ? (
                    <tr>
                      <td colSpan="4" style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>
                        Nessuna email programmata.
                      </td>
                    </tr>
                  ) : (
                    scheduledEmails.map((log, index) => (
                      <tr key={index}>
                        <td style={{ whiteSpace: 'nowrap' }}>{new Date(log.date).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</td>
                        <td><span className="badge badge-warning">{log.type}</span></td>
                        <td>{log.subject}</td>
                        <td>{log.recipients}</td>
                        <td style={{ textAlign: 'center' }}>
                          <button
                            className="btn btn-sm btn-ghost"
                            title="Annulla notifica"
                            onClick={() => deleteScheduledEmail(log.id)}
                            style={{ color: 'var(--danger)', padding: '4px 8px' }}
                            aria-label="Annulla notifica"
                          >
                            <AppIcon name="close" size={14} />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* SEZIONE BACKUP */}
      <div className={`admin-section-card ${collapsedSections.backup ? 'is-collapsed' : ''}`} style={{ marginTop: 32, marginBottom: 30 }}>
        <div className="admin-section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ cursor: 'pointer', flex: 1 }} onClick={() => toggleSection('backup')}>
            <h2><AppIcon name="save" /> Backup di Sistema</h2>
            <p className="admin-section-desc">Stato del salvataggio dati e archivi ZIP generati.</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 4 }}>
            {!collapsedSections.backup && (
              <button className="btn btn-primary btn-sm" onClick={handleTriggerBackup}>
                <AppIcon name="refresh" size={14} /> Esegui Ora
              </button>
            )}
            <div style={{ cursor: 'pointer', color: 'var(--text-muted)' }} onClick={() => toggleSection('backup')}>
              <AppIcon name={collapsedSections.backup ? 'chevronDown' : 'chevronUp'} size={18} />
            </div>
          </div>
        </div>

        {!collapsedSections.backup && (
          <div style={{ padding: '16px 20px', background: 'var(--bg-tertiary)', borderRadius: 8, marginTop: 16 }}>
            {lastBackup ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14, marginBottom: 16 }}>
                <div><strong>Ultimo backup completato:</strong> {new Date(lastBackup.date).toLocaleString()}</div>
                <div><strong>Dimensione archivio:</strong> {lastBackup.size_mb} MB</div>
                <div><strong>File:</strong> <code>{lastBackup.filename}</code></div>
                <div style={{ marginTop: 8, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  Il backup viene eseguito automaticamente ogni giorno alle 20:00 e conserva le ultime due settimane (14 backup). Include il database completo e tutti gli allegati.
                </div>
              </div>
            ) : (
              <div style={{ color: 'var(--text-muted)', marginBottom: 16 }}>Nessun backup trovato nel sistema.</div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
              <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <AppIcon name="upload" size={14} /> {uploadingBackup ? 'Ripristino in corso...' : 'Ripristina da file'}
                <input
                  type="file"
                  accept=".zip"
                  style={{ display: 'none' }}
                  disabled={uploadingBackup}
                  onChange={handleRestoreUpload}
                />
              </label>
            </div>

            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Backup disponibili</div>
            {backups.length > 0 ? (
              <div style={{ overflowX: 'auto' }}>
                <table className="backup-table">
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>File</th>
                      <th>Dimensione</th>
                      <th style={{ textAlign: 'right' }}>Azioni</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backups.map((b, idx) => (
                      <tr key={b.filename}>
                        <td>
                          {new Date(b.date).toLocaleString()}
                          {idx === 0 && (
                            <span style={{ marginLeft: 8, fontSize: '0.7rem', padding: '2px 6px', borderRadius: 999, background: 'rgba(99,102,241,0.15)', color: 'var(--accent-500, #6366f1)', fontWeight: 600 }}>
                              Ultimo
                            </span>
                          )}
                        </td>
                        <td className="backup-file" title={b.filename}>{b.filename}</td>
                        <td>{b.size_mb} MB</td>
                        <td className="backup-actions">
                          <button
                            className="btn btn-danger btn-sm"
                            disabled={restoringBackup === b.filename}
                            onClick={() => handleRestoreBackup(b.filename)}
                          >
                            <AppIcon name="undo" size={14} /> {restoringBackup === b.filename ? 'Ripristino...' : 'Ripristina'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="backup-empty">Nessun archivio di backup presente.</div>
            )}
          </div>
        )}
      </div>

      {/* MODALE AGGIUNTA/MODIFICA TEMPLATE */}
      {showAddTemplateModal && (
        <div className="modal-overlay animate-fadeIn">
          <div className="modal" style={{ maxWidth: 850, width: '100%', background: 'var(--bg-secondary)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-xl)', padding: '24px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ fontSize: '1.4rem' }}>{editingTemplate ? 'Modifica Fase Preimpostata' : 'Nuova Fase Preimpostata'}</h2>
              <button className="btn-ghost btn-icon" type="button" onClick={() => setShowAddTemplateModal(false)} aria-label="Chiudi">
                <AppIcon name="close" />
              </button>
            </div>
            <form onSubmit={handleSaveTemplate}>
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                <div style={{ display: 'flex', gap: 16 }}>
                  <div className="input-group" style={{ flex: 1.6, minWidth: 0 }}>
                    <label style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 6 }}>Nome Fase di Lavorazione *</label>
                    <input
                      className="input"
                      style={{ fontSize: '0.95rem', height: 42 }}
                      value={templateForm.name}
                      onChange={(e) => setTemplateForm({ ...templateForm, name: e.target.value })}
                      required
                      placeholder="es. Progettazione elettrica avanzata"
                    />
                  </div>

                  <div className="input-group" style={{ flex: 1.2, minWidth: 0 }}>
                    <label style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 6 }}>Reparto di Assegnazione *</label>
                    <select
                      className="input"
                      style={{ fontSize: '0.95rem', height: 42 }}
                      value={templateForm.department}
                      onChange={(e) => {
                        const newDept = e.target.value;
                        setTemplateForm(prev => ({
                          ...prev,
                          department: newDept,
                          default_color: DEPT_COLORS[newDept] || prev.default_color || '#3b82f6'
                        }));
                      }}
                    >
                      <option value="ufficio_tecnico">Ufficio Tecnico</option>
                      <option value="produzione">Produzione</option>
                      <option value="amministrazione">Amministrazione</option>
                      <option value="acquisti">Acquisti</option>
                      <option value="commerciale">Commerciale</option>
                      <option value="condivisa">Condivisa tra più reparti</option>
                    </select>
                  </div>
                </div>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: -10, display: 'block' }}>
                  Questa fase comparirà nel menu a tendina di tutti gli addetti del reparto selezionato.
                </span>

                <div className="input-group">
                  <label style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 6 }}>Modalità calcolo budget e pianificazione date:</label>
                  <select
                    className="input"
                    style={{ fontSize: '0.95rem', height: 42 }}
                    value={templateForm.default_budget_mode || 'start_days'}
                    onChange={(e) => {
                      const newMode = e.target.value;
                      setTemplateForm(prev => {
                        let next = { ...prev, default_budget_mode: newMode };
                        if (newMode === 'start_days' || newMode === 'end_days') {
                          if (next.default_days && !next.default_hours) {
                            next.default_hours = Number(next.default_days) * 8;
                          }
                        } else if (newMode === 'start_hours' || newMode === 'end_hours') {
                          if (next.default_hours && !next.default_days) {
                            next.default_days = Math.max(1, Math.ceil(Number(next.default_hours) / 8));
                          }
                        }
                        return next;
                      });
                    }}
                  >
                    <option value="start_days">Data Inizio / Giorni (calcola data fine escludendo sab/dom e festivi, ore = giorni×8)</option>
                    <option value="start_hours">Data Inizio / Ore (calcola data fine escludendo sab/dom e festivi, giorni = ore/8)</option>
                    <option value="start_end">Data Inizio / Data Fine (calcola giorni lavorativi ed ore escludendo sab/dom e festivi)</option>
                    <option value="end_days">Data Fine / Giorni (calcola data inizio a ritroso escludendo sab/dom e festivi)</option>
                    <option value="end_hours">Data Fine / Ore (calcola data inizio a ritroso escludendo sab/dom e festivi)</option>
                    <option value="start_days_hours">Data Inizio / Giorni / Ore (es. 24h spalmate su 10 gg escludendo sab/dom e festivi)</option>
                    <option value="end_days_hours">Data Fine / Giorni / Ore (es. 24h spalmate a ritroso su 10 gg escludendo sab/dom e festivi)</option>
                    <option value="custom_dates">Selezione Date da Calendario (giorni singoli o contigui con ore personalizzate/8h)</option>
                  </select>
                </div>

                <div style={{ display: 'flex', gap: 16 }}>
                  <div className="input-group" style={{ flex: 1 }}>
                    <label style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 6 }}>Giorni Lavorativi Previsti</label>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      className="input"
                      style={{ fontSize: '0.95rem', height: 42 }}
                      value={templateForm.default_days}
                      onChange={(e) => {
                        const val = e.target.value;
                        setTemplateForm(prev => {
                          const next = { ...prev, default_days: val };
                          if ((prev.default_budget_mode === 'start_days' || prev.default_budget_mode === 'end_days') && val !== '') {
                            next.default_hours = Number(val) * 8;
                          }
                          return next;
                        });
                      }}
                      placeholder="es. 3"
                    />
                  </div>
                  <div className="input-group" style={{ flex: 1 }}>
                    <label style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 6 }}>Ore Previste</label>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      className="input"
                      style={{ fontSize: '0.95rem', height: 42 }}
                      value={templateForm.default_hours}
                      onChange={(e) => {
                        const val = e.target.value;
                        setTemplateForm(prev => {
                          const next = { ...prev, default_hours: val };
                          if ((prev.default_budget_mode === 'start_hours' || prev.default_budget_mode === 'end_hours') && val !== '') {
                            next.default_days = Math.max(1, Math.ceil(Number(val) / 8));
                          }
                          return next;
                        });
                      }}
                      placeholder="es. 24"
                    />
                  </div>
                  <div className="input-group" style={{ flex: 1 }}>
                    <label style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 6 }}>Colore sul Gantt</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                      <input
                        type="color"
                        value={templateForm.default_color || '#3b82f6'}
                        onChange={(e) => setTemplateForm({ ...templateForm, default_color: e.target.value })}
                        style={{ width: 44, height: 42, padding: 2, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', cursor: 'pointer', background: 'var(--bg-tertiary)' }}
                      />
                      <input
                        type="text"
                        className="input"
                        value={templateForm.default_color || '#3b82f6'}
                        onChange={(e) => setTemplateForm({ ...templateForm, default_color: e.target.value })}
                        style={{ width: 110, height: 42, fontSize: '0.95rem', fontFamily: 'monospace' }}
                        placeholder="#3b82f6"
                      />
                    </div>
                  </div>
                </div>
              </div>
              <div className="modal-footer" style={{ marginTop: 20 }}>
                <button type="button" className="btn btn-secondary" style={{ fontSize: '0.95rem', padding: '10px 22px' }} onClick={() => setShowAddTemplateModal(false)}>
                  Annulla
                </button>
                <button type="submit" className="btn btn-primary" style={{ fontSize: '0.95rem', padding: '10px 22px' }}>
                  {editingTemplate ? 'Salva Modifiche' : 'Aggiungi Fase'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* MODAL CREAZIONE UTENTE */}
      {showAddUserModal && (
        <div className="modal-overlay animate-fadeIn">
          <div className="modal" style={{ maxWidth: 500, background: 'var(--bg-secondary)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-xl)' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Crea Nuovo Utente</h2>
              <button className="btn-ghost btn-icon" type="button" onClick={() => setShowAddUserModal(false)} aria-label="Chiudi">
                <AppIcon name="close" />
              </button>
            </div>
            <form onSubmit={handleCreateUser}>
              <div className="modal-body">
                <div className="input-group">
                  <label>Nome Utente (Username) *</label>
                  <input
                    className="input"
                    value={newUserForm.username}
                    onChange={(e) => setNewUserForm({ ...newUserForm, username: e.target.value })}
                    required
                    placeholder="es. mario.rossi"
                  />
                </div>

                <div className="input-group" style={{ marginTop: 14 }}>
                  <label>Email *</label>
                  <input
                    type="email"
                    className="input"
                    value={newUserForm.email}
                    onChange={(e) => setNewUserForm({ ...newUserForm, email: e.target.value })}
                    required
                    placeholder="es. mario@example.com"
                  />
                </div>

                <div className="input-group" style={{ marginTop: 14 }}>
                  <label>Nome Completo</label>
                  <input
                    className="input"
                    value={newUserForm.full_name}
                    onChange={(e) => setNewUserForm({ ...newUserForm, full_name: e.target.value })}
                    placeholder="es. Mario Rossi"
                  />
                </div>

                <div className="input-group" style={{ marginTop: 14 }}>
                  <label>Password *</label>
                  <input
                    type="password"
                    className="input"
                    value={newUserForm.password}
                    onChange={(e) => setNewUserForm({ ...newUserForm, password: e.target.value })}
                    required
                    placeholder="Scegli una password"
                  />
                </div>

                <div style={{ display: 'flex', gap: 16, marginTop: 14 }}>
                  <div className="input-group" style={{ flex: 1 }}>
                    <label>Ruolo *</label>
                    <select
                      className="input"
                      value={newUserForm.role}
                      onChange={(e) => setNewUserForm({ ...newUserForm, role: e.target.value })}
                      required
                    >
                      <option value="viewer">Viewer (Solo lettura)</option>
                      <option value="editor">Editor (Lettura/Scrittura parziale)</option>
                      <option value="admin">Admin (Completo)</option>
                    </select>
                  </div>

                  <div className="input-group" style={{ flex: 1 }}>
                    <label>Reparto *</label>
                    <select
                      className="input"
                      value={newUserForm.department}
                      onChange={(e) => setNewUserForm({ ...newUserForm, department: e.target.value })}
                      required
                    >
                      <option value="ufficio_tecnico">Ufficio Tecnico</option>
                      <option value="produzione">Produzione</option>
                      <option value="amministrazione">Amministrazione</option>
                      <option value="acquisti">Acquisti</option>
                      <option value="commerciale">Commerciale</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowAddUserModal(false)}>
                  Annulla
                </button>
                <button type="submit" className="btn btn-primary">
                  Crea Utente
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL GESTIONE UTENTE */}
      {managingUser && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 450 }}>
            <div className="modal-header">
              <h2>Azioni per @{managingUser.username}</h2>
              <button className="btn-ghost btn-icon" onClick={() => setManagingUser(null)} aria-label="Chiudi">
                <AppIcon name="close" />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              <form onSubmit={handleResetPassword} style={{ background: 'var(--bg-tertiary)', padding: 16, borderRadius: 8 }}>
                <h4 className="inline-heading" style={{ marginBottom: 12 }}><AppIcon name="lock" size={16} />Modifica password</h4>
                <div className="input-group" style={{ marginBottom: 12 }}>
                  <input
                    type="text"
                    className="input"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    placeholder="Nuova password..."
                  />
                </div>
                <button type="submit" className="btn btn-primary btn-sm">Salva Password</button>
              </form>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <h4 className="inline-heading"><AppIcon name="settings" size={16} /> Altre azioni</h4>
                <button
                  className={`btn ${managingUser.is_active ? 'btn-secondary' : 'btn-primary'}`}
                  style={{ justifyContent: 'center' }}
                  onClick={() => { handleToggleActive(managingUser.id, managingUser.is_active); setManagingUser(null); }}
                >
                  {managingUser.is_active ? 'Disattiva account' : 'Attiva account'}
                </button>

                {managingUser.username !== 'admin' && (
                  <button
                    className="btn btn-danger"
                    style={{ justifyContent: 'center' }}
                    onClick={() => handleDeleteUser(managingUser)}
                  >
                    <AppIcon name="trash" />
                    Elimina definitivamente
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// ─── Componente Admin Sezione RC ──────────────────────────────────────────────

function RichiesteCommercialiAdminSection({ users, toast }) {
  const [commerciali, setCommerciali] = useState([]);
  const [acquisti, setAcquisti] = useState([]);
  const [admins, setAdmins] = useState([]);
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [deptDefaults, setDeptDefaults] = useState({
    commerciale: false,
    acquisti: false,
    admin: false,
  });
  const [collapsed, setCollapsed] = useState(true);
  const [saving, setSaving] = useState(false);
  // api is imported at module level

  useEffect(() => {
    loadAll();
  }, []);

  async function loadAll() {
    try {
      const [c, a, adm, em, dd] = await Promise.all([
        api.get('/settings/richieste-commerciali/commerciale-users'),
        api.get('/settings/richieste-commerciali/acquisti-users'),
        api.get('/settings/richieste-commerciali/admin-users'),
        api.get('/settings/richieste-commerciali/email-enabled'),
        api.get('/settings/richieste-commerciali/dept-defaults'),
      ]);
      setCommerciali(c.data || []);
      setAcquisti(a.data || []);
      setAdmins(adm.data || []);
      setEmailEnabled(em.data?.enabled ?? true);
      setDeptDefaults(dd.data || { commerciale: false, acquisti: false, admin: false });
    } catch (e) {
      console.error('[RC Admin]', e);
    }
  }

  async function saveGroup(group, list) {
    setSaving(true);
    try {
      await api.post(`/settings/richieste-commerciali/${group}-users`, { usernames: list });
      toast.success(`Lista "${group}" aggiornata`);
    } catch {
      toast.error('Errore salvataggio');
    } finally {
      setSaving(false);
    }
  }

  async function toggleEmail(val) {
    try {
      await api.put('/settings/richieste-commerciali/email-enabled', { enabled: val });
      setEmailEnabled(val);
      toast.success(val ? 'Email abilitate' : 'Email disabilitate');
    } catch {
      toast.error('Errore aggiornamento');
    }
  }

  async function toggleDeptDefault(group, val) {
    try {
      setDeptDefaults(prev => ({ ...prev, [group]: val }));
      await api.put('/settings/richieste-commerciali/dept-defaults', { [group]: val });
      toast.success(val ? `Inclusione per reparto "${group}" abilitata` : `Inclusione per reparto "${group}" disabilitata`);
    } catch (err) {
      console.error(err);
      toast.error('Errore salvataggio impostazione reparto');
      setDeptDefaults(prev => ({ ...prev, [group]: !val }));
    }
  }

  function getDeptUsers(group) {
    return users.filter(u => {
      const dept = (u.department || '').toLowerCase().trim();
      if (group === 'commerciale') return dept === 'commerciale';
      if (group === 'acquisti') return dept === 'acquisti' || dept === 'ufficio_acquisti';
      if (group === 'admin') return dept === 'amministrazione' || dept === 'admin';
      return false;
    });
  }

  function UserListEditor({ label, list, setList, group, color, deptCheckboxLabel }) {
    const isDeptEnabled = !!deptDefaults[group];
    const deptUsers = getDeptUsers(group);
    const deptUsernames = deptUsers.map(u => u.username);

    // Utenti effettivi: se abilitato, include gli addetti del reparto + gli utenti aggiunti manualmente
    const effectiveUsernames = Array.from(new Set([
      ...(isDeptEnabled ? deptUsernames : []),
      ...list,
    ]));

    const available = users.filter(u => !effectiveUsernames.includes(u.username));
    const [sel, setSel] = useState('');

    return (
      <div style={{ marginBottom: 14 }}>
        {/* Header con titolo, contatore e checkbox per default reparto */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block', boxShadow: `0 0 5px ${color}80` }} />
            <strong style={{ fontSize: '0.88rem', color: 'var(--text-primary)' }}>{label}</strong>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>({effectiveUsernames.length} utenti)</span>
          </div>

          {/* Checkbox aggiungi di default reparto */}
          <label style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'pointer',
            userSelect: 'none',
            background: isDeptEnabled ? `${color}14` : 'var(--bg-secondary)',
            border: `1px solid ${isDeptEnabled ? `${color}55` : 'var(--border)'}`,
            padding: '3px 9px',
            borderRadius: 6,
            fontSize: '0.78rem',
            color: isDeptEnabled ? 'var(--text-primary)' : 'var(--text-secondary)',
            fontWeight: 500,
            transition: 'all 0.15s ease',
          }}>
            <input
              type="checkbox"
              checked={isDeptEnabled}
              onChange={e => toggleDeptDefault(group, e.target.checked)}
              style={{ cursor: 'pointer', accentColor: color, margin: 0 }}
            />
            <span>{deptCheckboxLabel}</span>
            <span style={{
              fontSize: '0.72rem',
              color: isDeptEnabled ? color : 'var(--text-muted)',
              fontWeight: 600,
            }}>
              ({deptUsers.length})
            </span>
          </label>
        </div>

        {/* Lista corrente (badge) */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {effectiveUsernames.map(u => {
            const isAutoFromDept = isDeptEnabled && deptUsernames.includes(u);
            const isManual = list.includes(u);
            const matchedUser = users.find(x => x.username === u);
            const displayName = matchedUser?.full_name ? `${matchedUser.full_name} (${u})` : u;

            return (
              <span
                key={u}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '2px 8px',
                  borderRadius: 16,
                  background: `${color}16`,
                  border: `1px solid ${color}40`,
                  fontSize: '0.8rem',
                  color: 'var(--text-primary)',
                }}
              >
                <AppIcon name="user" size={12} />
                <span>{displayName}</span>
                {isAutoFromDept && (
                  <span
                    style={{
                      fontSize: '0.68rem',
                      fontWeight: 600,
                      padding: '1px 5px',
                      borderRadius: 8,
                      background: `${color}28`,
                      color: color,
                      marginLeft: 2,
                    }}
                    title="Incluso automaticamente tramite il reparto del profilo utente"
                  >
                    Reparto
                  </span>
                )}
                {isManual && (
                  <button
                    onClick={() => {
                      const next = list.filter(x => x !== u);
                      setList(next);
                      saveGroup(group, next);
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--text-secondary)',
                      padding: 0,
                      display: 'inline-flex',
                      alignItems: 'center',
                      marginLeft: 2,
                    }}
                    title={isAutoFromDept ? "Rimuovi dalla lista manuale (rimane comunque incluso dal reparto)" : "Rimuovi"}
                  >
                    <AppIcon name="close" size={11} />
                  </button>
                )}
              </span>
            );
          })}
          {effectiveUsernames.length === 0 && (
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
              Nessun utente nella lista
            </span>
          )}
        </div>

        {/* Aggiungi utente manuale */}
        <div style={{ display: 'flex', gap: 6 }}>
          <select
            className="input"
            value={sel}
            onChange={e => setSel(e.target.value)}
            style={{ flex: 1, padding: '4px 10px', borderRadius: 6, fontSize: '0.82rem', height: '32px' }}
          >
            <option value="">Seleziona utente da aggiungere...</option>
            {available.map(u => (
              <option key={u.id} value={u.username}>
                {u.full_name || u.username} ({u.username}) {u.department ? `— [${u.department}]` : ''}
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary btn-sm"
            disabled={!sel || saving}
            style={{ padding: '4px 12px', height: '32px', fontSize: '0.82rem' }}
            onClick={() => {
              if (!sel) return;
              const next = [...list, sel];
              setList(next);
              saveGroup(group, next);
              setSel('');
            }}
          >
            <AppIcon name="plus" size={12} /> Aggiungi
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`admin-section-card ${collapsed ? 'is-collapsed' : ''}`} style={{ marginTop: 32 }}>
      <div className="admin-section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ cursor: 'pointer', flex: 1 }} onClick={() => setCollapsed(c => !c)}>
          <h2><AppIcon name="briefcase" /> Preventivazione</h2>
          <p className="admin-section-desc">Gestisci le liste utenti e le impostazioni email del modulo Preventivazione.</p>
        </div>
        <div style={{ cursor: 'pointer', color: 'var(--text-muted)', marginTop: 4 }} onClick={() => setCollapsed(c => !c)}>
          <AppIcon name={collapsed ? 'chevronDown' : 'chevronUp'} size={18} />
        </div>
      </div>

      {!collapsed && (
        <div className="admin-section-body">
          {/* Toggle email */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px', background: emailEnabled ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)', borderRadius: 8, border: `1px solid ${emailEnabled ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`, marginBottom: 14 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', color: emailEnabled ? '#16a34a' : '#ef4444' }}>
              <AppIcon name="mail" size={18} />
            </span>
            <div style={{ flex: 1 }}>
              <strong style={{ fontSize: '0.86rem' }}>Notifiche Email</strong>
              <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Abilita o disabilita l'invio di email per i cambiamenti di stato delle richieste</p>
            </div>
            <button
              className={`btn btn-sm ${emailEnabled ? 'btn-danger' : 'btn-primary'}`}
              style={{ padding: '4px 10px', height: '30px', fontSize: '0.8rem' }}
              onClick={() => toggleEmail(!emailEnabled)}
            >
              <AppIcon name="bell" size={12} /> {emailEnabled ? 'Disabilita' : 'Abilita'}
            </button>
            <span style={{ padding: '2px 8px', borderRadius: 16, fontSize: '0.72rem', fontWeight: 700, background: emailEnabled ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)', color: emailEnabled ? '#16a34a' : '#ef4444' }}>
              {emailEnabled ? 'ABILITATE' : 'DISABILITATE'}
            </span>
          </div>

          <UserListEditor
            label="Commerciali"
            list={commerciali}
            setList={setCommerciali}
            group="commerciale"
            color="#ec4899"
            deptCheckboxLabel="Aggiungi di default gli addetti con reparto commerciale"
          />
          <UserListEditor
            label="Ufficio acquisti"
            list={acquisti}
            setList={setAcquisti}
            group="acquisti"
            color="#10b981"
            deptCheckboxLabel="Aggiungi di default gli addetti con reparto acquisti"
          />
          <UserListEditor
            label="Admin"
            list={admins}
            setList={setAdmins}
            group="admin"
            color="#6366f1"
            deptCheckboxLabel="Aggiungi di default gli addetti con reparto amministrazione"
          />
        </div>
      )}
    </div>
  );
}

