import { useState, useEffect, useMemo } from 'react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import {
  User,
  Mail,
  Shield,
  Building2,
  Calendar,
  CalendarPlus,
  Clock,
  Trash2,
  Edit3,
  Check,
  AlertCircle,
  ArrowRight,
  X,
  Plus,
  Tag,
  Palmtree,
  CalendarDays,
  FolderKanban
} from 'lucide-react';
import './ProfilePage.css';

const DEPARTMENT_LABELS = {
  ufficio_tecnico: 'Ufficio Tecnico',
  produzione: 'Produzione',
  amministrazione: 'Amministrazione',
  acquisti: 'Acquisti',
  commerciale: 'Commerciale',
  admin: 'Admin',
};

function getVacationDays(startDateStr, endDateStr) {
  if (!startDateStr || !endDateStr) return 0;
  const cleanStart = startDateStr.split('T')[0].split(' ')[0];
  const cleanEnd = endDateStr.split('T')[0].split(' ')[0];
  const [sY, sM, sD] = cleanStart.split('-').map(Number);
  const [eY, eM, eD] = cleanEnd.split('-').map(Number);
  const start = new Date(sY, sM - 1, sD);
  const end = new Date(eY, eM - 1, eD);

  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return 0;

  // Calcolo giorni lavorativi (lunedì - venerdì)
  let workdays = 0;
  let current = new Date(start);
  while (current <= end) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) {
      workdays++;
    }
    current.setDate(current.getDate() + 1);
  }

  // Se cade interamente in giorni non feriali (es. weekend o singola festa), si contano i giorni effettivi (almeno 1)
  if (workdays === 0) {
    const msPerDay = 1000 * 60 * 60 * 24;
    const calendarDays = Math.round((end.getTime() - start.getTime()) / msPerDay) + 1;
    return Math.max(1, calendarDays);
  }

  return workdays;
}

export default function ProfilePage() {
  const { user, fetchUser } = useAuth();
  const toast = useToast();
  const [vacations, setVacations] = useState([]);
  const [recoveryItems, setRecoveryItems] = useState([]);
  const [dismissedKeys, setDismissedKeys] = useState(
    () => new Set(JSON.parse(localStorage.getItem('recovery_dismissed') || '[]'))
  );
  const [form, setForm] = useState({ start_date: '', end_date: '', reason: '' });
  const [showEditModal, setShowEditModal] = useState(false);
  const [editForm, setEditForm] = useState({ full_name: '', username: '', email: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);

  function openEditModal() {
    setEditForm({ full_name: user?.full_name || '', username: user?.username || '', email: user?.email || '' });
    setShowEditModal(true);
  }

  async function handleSaveProfile(e) {
    e.preventDefault();
    if (!editForm.username.trim()) {
      toast.error('Lo username è obbligatorio');
      return;
    }
    try {
      await api.patch('/users/me', {
        full_name: editForm.full_name.trim() || null,
        username: editForm.username.trim(),
        email: editForm.email.trim()
      });
      toast.success('Profilo aggiornato con successo!');
      setShowEditModal(false);
      await fetchUser();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Errore aggiornamento profilo');
    }
  }

  useEffect(() => {
    loadVacations();
    loadRecovery();
  }, []);

  async function loadVacations() {
    try {
      const { data } = await api.get('/vacations/me');
      setVacations(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('Errore caricamento ferie:', e);
    }
  }

  async function loadRecovery() {
    try {
      const { data } = await api.get('/vacations/me/recovery');
      setRecoveryItems(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('Errore caricamento ore da recuperare:', e);
    }
  }

  function getRecoveryKey(item) {
    return `${item.task_id}_${item.vacation_start}`;
  }

  function dismissRecoveryItem(item) {
    const key = getRecoveryKey(item);
    setDismissedKeys(prev => {
      const next = new Set(prev);
      next.add(key);
      localStorage.setItem('recovery_dismissed', JSON.stringify([...next]));
      return next;
    });
    toast.success('Voce rimossa dalla lista.');
  }

  async function handleCreate(e) {
    e.preventDefault();

    if (!form.start_date || !form.end_date) {
      toast.error('Inserisci sia la data di inizio che di fine');
      return;
    }

    const start = new Date(form.start_date);
    const end = new Date(form.end_date);

    if (start > end) {
      toast.error('La data di inizio deve essere prima della data di fine');
      return;
    }

    try {
      setIsSubmitting(true);
      const response = await api.post('/vacations/me', form);
      toast.success('Ferie registrate con successo!');
      if (response.data.recovery_items?.length > 0) {
        toast.warning(`⚠️ ${response.data.recovery_items.length} fase/i con ore da recuperare rilevate.`);
      }
      setForm({ start_date: '', end_date: '', reason: '' });
      await new Promise(resolve => setTimeout(resolve, 300));
      await loadVacations();
      await loadRecovery();
    } catch (err) {
      console.error('Errore creazione ferie:', err.response?.data);
      toast.error(err.response?.data?.detail || 'Errore creazione ferie');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDelete(id) {
    if (!window.confirm('Eliminare queste ferie?')) return;
    try {
      await api.delete(`/vacations/me/${id}`);
      toast.success('Ferie rimosse');
      await new Promise(resolve => setTimeout(resolve, 300));
      await loadVacations();
    } catch (error) {
      console.error('Errore rimozione ferie:', error);
      toast.error('Errore rimozione ferie');
    }
  }

  const totalVacationDays = useMemo(() => {
    return vacations.reduce((acc, v) => {
      return acc + getVacationDays(v.start_date, v.end_date);
    }, 0);
  }, [vacations]);

  const previewDays = useMemo(() => {
    if (!form.start_date || !form.end_date) return null;
    return getVacationDays(form.start_date, form.end_date);
  }, [form.start_date, form.end_date]);

  const departmentText = DEPARTMENT_LABELS[user?.department] || user?.department || 'Nessuno';

  const pendingRecoveryItems = recoveryItems.filter(
    item => !dismissedKeys.has(getRecoveryKey(item))
  );

  return (
    <div className="profile-page">
      {/* Action Bar */}
      <div className="profile-action-bar">
        <div className="profile-context-badge">
          <span className="profile-context-dot" />
          <span>Dati personali, autorizzazioni e disponibilità ferie</span>
        </div>
        <button type="button" className="btn-profile-edit" onClick={openEditModal}>
          <Edit3 size={15} />
          <span>Modifica profilo</span>
        </button>
      </div>

      {/* Profile Stat Cards Grid */}
      <div className="profile-stats-grid">
        <div className="profile-stat-card stat-user">
          <div className="stat-icon-wrap">
            <User size={20} />
          </div>
          <div className="profile-stat-content">
            <span className="profile-stat-label">Nome Utente</span>
            <span className="profile-stat-value" title={user?.full_name || user?.username}>
              {user?.full_name || user?.username}
            </span>
          </div>
        </div>

        <div className="profile-stat-card stat-email">
          <div className="stat-icon-wrap">
            <Mail size={20} />
          </div>
          <div className="profile-stat-content">
            <span className="profile-stat-label">Email Aziendale</span>
            <span className="profile-stat-value" title={user?.email || 'N/D'}>
              {user?.email || '—'}
            </span>
          </div>
        </div>

        <div className="profile-stat-card stat-role">
          <div className="stat-icon-wrap">
            <Shield size={20} />
          </div>
          <div className="profile-stat-content">
            <span className="profile-stat-label">Ruolo di Sistema</span>
            <div className="profile-stat-value">
              <div className="stat-role-pill">
                <Shield size={11} />
                {user?.role?.toUpperCase() || 'USER'}
              </div>
            </div>
          </div>
        </div>

        <div className="profile-stat-card stat-dept">
          <div className="stat-icon-wrap">
            <Building2 size={20} />
          </div>
          <div className="profile-stat-content">
            <span className="profile-stat-label">Reparto Assegnato</span>
            <div className="profile-stat-value">
              <div className="stat-dept-pill">
                <Building2 size={11} />
                {departmentText}
              </div>
            </div>
          </div>
        </div>

        <div className="profile-stat-card stat-vacation">
          <div className="stat-icon-wrap">
            <Palmtree size={20} />
          </div>
          <div className="profile-stat-content">
            <span className="profile-stat-label">Ferie Registrate</span>
            <span className="profile-stat-value">
              {totalVacationDays} {totalVacationDays === 1 ? 'giorno' : 'giorni'}
            </span>
          </div>
        </div>
      </div>

      {/* Main Content Grid: Form + Vacation List */}
      <div className="profile-main-grid">
        {/* Left Column: Form Aggiungi Ferie */}
        <section className="profile-card">
          <div className="profile-card-header">
            <div className="profile-card-header-left">
              <div className="profile-card-icon-badge">
                <CalendarPlus size={20} />
              </div>
              <div>
                <h3 className="profile-card-title">Aggiungi ferie</h3>
                <p className="profile-card-sub">Pianifica un periodo di assenza o riposo</p>
              </div>
            </div>
          </div>

          <div className="profile-card-body">
            <form onSubmit={handleCreate} className="profile-form">
              {/* Riga Date: Inizio e Fine affiancate */}
              <div className="profile-form-dates-row">
                <div className="profile-form-group">
                  <label className="profile-form-label">
                    Inizio <span className="profile-required-mark">*</span>
                  </label>
                  <input
                    type="date"
                    className="profile-input"
                    value={form.start_date}
                    onChange={e => setForm({ ...form, start_date: e.target.value })}
                    required
                  />
                </div>
                <div className="profile-form-group">
                  <label className="profile-form-label">
                    Fine <span className="profile-required-mark">*</span>
                  </label>
                  <input
                    type="date"
                    className="profile-input"
                    value={form.end_date}
                    onChange={e => setForm({ ...form, end_date: e.target.value })}
                    required
                  />
                </div>
              </div>

              {/* Banner anteprima durata se date valide */}
              {previewDays !== null && previewDays > 0 && (
                <div className="profile-preview-banner">
                  <Clock size={15} />
                  <span>
                    Durata calcolata: <strong>{previewDays} {previewDays === 1 ? 'giorno' : 'giorni'}</strong>
                  </span>
                </div>
              )}

              {/* Motivo */}
              <div className="profile-form-group">
                <label className="profile-form-label">Motivo (opzionale)</label>
                <input
                  type="text"
                  className="profile-input"
                  placeholder="Es. Ferie estive, Riposo, Permesso..."
                  value={form.reason}
                  onChange={e => setForm({ ...form, reason: e.target.value })}
                />
              </div>

              <button
                type="submit"
                className="btn-profile-primary"
                disabled={isSubmitting}
              >
                <Plus size={16} />
                <span>{isSubmitting ? 'Registrazione...' : 'Aggiungi ferie'}</span>
              </button>
            </form>
          </div>
        </section>

        {/* Right Column: Le tue ferie */}
        <section className="profile-card">
          <div className="profile-card-header">
            <div className="profile-card-header-left">
              <div className="profile-card-icon-badge">
                <Calendar size={18} />
              </div>
              <div>
                <h3 className="profile-card-title">Le tue ferie</h3>
                <p className="profile-card-sub">Storico delle assenze programmate</p>
              </div>
            </div>
            {vacations.length > 0 && (
              <span className="profile-card-count-badge">
                <Clock size={12} />
                {vacations.length} {vacations.length === 1 ? 'periodo' : 'periodi'} ({totalVacationDays} gg)
              </span>
            )}
          </div>

          <div className="profile-card-body">
            <div className="vacation-list-container">
              {vacations.length === 0 ? (
                <div className="vacation-empty-state">
                  <div className="vacation-empty-icon-wrap">
                    <Palmtree size={28} />
                  </div>
                  <h4 className="vacation-empty-title">Nessuna ferie registrata</h4>
                  <p className="vacation-empty-desc">
                    Usa il modulo a sinistra per aggiungere le tue prossime ferie o periodi di assenza.
                  </p>
                </div>
              ) : (
                vacations.map(v => {
                  const days = getVacationDays(v.start_date, v.end_date);
                  const durationLabel = days === 1 ? '1 giorno' : `${days} giorni`;
                  const isClosure = (v.reason || '').toLowerCase().includes('chiusura');

                  return (
                    <div key={v.id} className="vacation-item-card">
                      <div className="vacation-item-left">
                        <div className="vacation-item-icon-wrap">
                          <CalendarDays size={16} />
                        </div>
                        <div className="vacation-item-info">
                          <div className="vacation-item-dates">
                            <span>{v.start_date}</span>
                            <ArrowRight size={13} className="vacation-date-arrow" />
                            <span>{v.end_date}</span>
                          </div>
                          {v.reason && (
                            <span
                              className={`vacation-pill-reason ${isClosure ? 'closure' : ''}`}
                              title={v.reason}
                            >
                              <Tag size={11} />
                              {v.reason}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="vacation-item-right">
                        <span className="vacation-pill-duration">
                          <Clock size={11} />
                          {durationLabel}
                        </span>
                        <button
                          type="button"
                          className="vacation-delete-btn"
                          onClick={() => handleDelete(v.id)}
                          title="Elimina questo periodo di ferie"
                          aria-label="Elimina ferie"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </section>
      </div>

      {/* Recovery Section: Ore da Recuperare */}
      {pendingRecoveryItems.length > 0 && (
        <section className="profile-recovery-card">
          <div className="profile-recovery-header">
            <AlertCircle size={20} />
            <h3>Ore da Recuperare per Ferie</h3>
          </div>
          <p className="profile-recovery-desc">
            Le seguenti fasi hanno ore pianificate che cadono nei tuoi giorni di ferie. Queste ore andrebbero recuperate in accordo con il tuo referente.
          </p>
          <div className="profile-recovery-list">
            {pendingRecoveryItems.map((item, i) => (
              <div key={i} className="profile-recovery-item">
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  <span className="profile-recovery-task">
                    {item.task_name}
                  </span>
                  <span className="profile-recovery-proj">
                    <FolderKanban size={13} />
                    Progetto: {item.project_code && item.project_code !== "—" ? `${item.project_code}${item.project_name && item.project_name !== item.project_code && item.project_name !== "—" ? ` - ${item.project_name}` : ''}` : item.project_name}
                  </span>
                  <span style={{ color: 'var(--text-tertiary)', fontSize: '0.78rem' }}>
                    {item.vacation_days?.length || 0} giorni lavorativi sovrapposti
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span className="profile-recovery-badge">
                    {item.hours_to_recover}h
                  </span>
                  <button
                    type="button"
                    className="btn-recovery-dismiss"
                    onClick={() => dismissRecoveryItem(item)}
                    title="Segna come recuperata e rimuovi dalla lista"
                    aria-label="Segna recuperata"
                  >
                    <Check size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Modal Modifica Profilo */}
      {showEditModal && (
        <div className="profile-modal-overlay" onClick={() => setShowEditModal(false)}>
          <div className="profile-edit-modal" onClick={e => e.stopPropagation()}>
            <div className="profile-edit-header">
              <div className="profile-edit-header-left">
                <div className="profile-edit-icon-badge">
                  <User size={20} />
                </div>
                <div>
                  <h3>Modifica Profilo</h3>
                  <p>Aggiorna le tue informazioni personali</p>
                </div>
              </div>
              <button
                type="button"
                className="profile-modal-close"
                onClick={() => setShowEditModal(false)}
                aria-label="Chiudi"
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleSaveProfile} className="profile-edit-form">
              <div className="profile-form-group">
                <label className="profile-form-label">Nome Completo</label>
                <input
                  className="profile-input"
                  value={editForm.full_name}
                  onChange={e => setEditForm({ ...editForm, full_name: e.target.value })}
                  placeholder="Es. Mario Rossi"
                />
              </div>
              <div className="profile-form-group">
                <label className="profile-form-label">Username *</label>
                <input
                  className="profile-input"
                  required
                  value={editForm.username}
                  onChange={e => setEditForm({ ...editForm, username: e.target.value })}
                  placeholder="Es. m.rossi"
                />
              </div>
              <div className="profile-form-group">
                <label className="profile-form-label">Email *</label>
                <input
                  type="email"
                  className="profile-input"
                  required
                  value={editForm.email}
                  onChange={e => setEditForm({ ...editForm, email: e.target.value })}
                  placeholder="Es. m.rossi@hiway.it"
                />
              </div>
              <div className="profile-modal-footer">
                <button
                  type="button"
                  className="btn-profile-secondary"
                  onClick={() => setShowEditModal(false)}
                >
                  Annulla
                </button>
                <button type="submit" className="btn-profile-primary" style={{ width: 'auto', padding: '0 20px', height: '40px', marginTop: 0 }}>
                  Salva Modifiche
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
