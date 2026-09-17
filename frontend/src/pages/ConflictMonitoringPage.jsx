import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import AppIcon from '../components/ui/AppIcon';
import './ConflictMonitoringPage.css';
import { isWeekendOrHoliday } from '../utils/workingDays';

import WorkloadHeatmap from '../components/workload/WorkloadHeatmap';

export default function ConflictMonitoringPage() {
  const { user } = useAuth();
  const [conflicts, setConflicts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isConflictsOpen, setIsConflictsOpen] = useState(false);
  const [conflictFilter, setConflictFilter] = useState('all');

  const filteredConflicts = useMemo(() => {
    if (conflictFilter === 'all') return conflicts;
    return conflicts.filter(c => c.type === conflictFilter);
  }, [conflicts, conflictFilter]);

  const overloadCount = useMemo(() => conflicts.filter(c => c.type === 'overload').length, [conflicts]);
  const vacationCount = useMemo(() => conflicts.filter(c => c.type === 'vacation').length, [conflicts]);

  const [vacations, setVacations] = useState([]);
  const [isVacationsOpen, setIsVacationsOpen] = useState(false);
  const [editingVacation, setEditingVacation] = useState(null);
  const [deletingVacation, setDeletingVacation] = useState(null);

  const [vacationSortConfig, setVacationSortConfig] = useState({ key: 'created_at', direction: 'desc' });

  function handleVacationSort(key) {
    if (vacationSortConfig.key === key) {
      setVacationSortConfig({ key, direction: vacationSortConfig.direction === 'asc' ? 'desc' : 'asc' });
    } else {
      setVacationSortConfig({ key, direction: 'asc' });
    }
  }

  const sortedVacations = useMemo(() => {
    return [...vacations].sort((a, b) => {
      let valA = a[vacationSortConfig.key];
      let valB = b[vacationSortConfig.key];

      if (vacationSortConfig.key === 'username') {
        valA = (a.full_name || a.username || '').toLowerCase();
        valB = (b.full_name || b.username || '').toLowerCase();
      } else if (vacationSortConfig.key === 'start_date' || vacationSortConfig.key === 'end_date' || vacationSortConfig.key === 'created_at') {
        valA = valA ? new Date(valA).getTime() : 0;
        valB = valB ? new Date(valB).getTime() : 0;
      } else if (vacationSortConfig.key === 'reason') {
        valA = (valA || '').toLowerCase();
        valB = (valB || '').toLowerCase();
      }

      if (valA < valB) return vacationSortConfig.direction === 'asc' ? -1 : 1;
      if (valA > valB) return vacationSortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [vacations, vacationSortConfig]);

  const [usersList, setUsersList] = useState([]);
  const [addingVacation, setAddingVacation] = useState(false);
  const [newVacation, setNewVacation] = useState({ user_id: '', start_date: '', end_date: '', reason: '' });
  
  const [addingClosure, setAddingClosure] = useState(false);
  const [newClosure, setNewClosure] = useState({ start_date: '', end_date: '', reason: 'Chiusura Aziendale' });
  
  const [submittingVacation, setSubmittingVacation] = useState(false);

  // Search Slots State
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchParams, setSearchParams] = useState({
    department: 'all',
    userId: 'all',
    type: 'days',
    quantity: 1,
  });
  const [searchResults, setSearchResults] = useState(null);
  const [isSearching, setIsSearching] = useState(false);
  const [visibleResultsCount, setVisibleResultsCount] = useState(10);
  const [visibleVacationsCount, setVisibleVacationsCount] = useState(10);

  const navigate = useNavigate();
  const toast = useToast();

  useEffect(() => {
    loadConflicts();
    loadVacations();
    loadUsers();

    const handleDataModified = () => {
      loadConflicts();
      loadVacations();
    };

    window.addEventListener('agent-data-modified', handleDataModified);
    return () => window.removeEventListener('agent-data-modified', handleDataModified);
  }, []);

  async function loadUsers() {
    try {
      const { data } = await api.get('/users');
      // Ordine alfabetico case-insensitive
      const sortedUsers = data.sort((a, b) => {
        const nameA = (a.full_name || a.username || '').toLowerCase();
        const nameB = (b.full_name || b.username || '').toLowerCase();
        return nameA.localeCompare(nameB);
      });
      setUsersList(sortedUsers);
    } catch (err) {
      console.error('Errore caricamento utenti', err);
    }
  }

  async function loadVacations() {
    try {
      const { data } = await api.get('/vacations/all');
      setVacations(data);
    } catch (err) {
      toast.error('Errore durante il caricamento ferie');
    }
  }

  async function handleEditVacation(e) {
    e.preventDefault();
    try {
      await api.put(`/vacations/admin/${editingVacation.id}`, {
        start_date: editingVacation.start_date,
        end_date: editingVacation.end_date,
        reason: editingVacation.reason
      });
      toast.success('Ferie modificate con successo');
      setEditingVacation(null);
      loadVacations();
      loadConflicts();
    } catch (err) {
      toast.error('Errore durante la modifica');
    }
  }

  async function handleDeleteVacation() {
    try {
      await api.delete(`/vacations/admin/${deletingVacation.id}`);
      toast.success('Ferie eliminate con successo');
      setDeletingVacation(null);
      loadVacations();
      loadConflicts();
    } catch (err) {
      toast.error('Errore durante l\'eliminazione');
    }
  }

  async function handleAddVacation(e) {
    e.preventDefault();
    if (!newVacation.user_id || !newVacation.start_date || !newVacation.end_date) {
      toast.error('Compila tutti i campi obbligatori.');
      return;
    }
    setSubmittingVacation(true);
    try {
      const res = await api.post(`/vacations/admin/user/${newVacation.user_id}`, {
        start_date: newVacation.start_date,
        end_date: newVacation.end_date,
        reason: newVacation.reason
      });
      toast.success('Ferie aggiunte con successo.');
      if (res.data.recovery_items?.length > 0) {
        toast.warning(`⚠️ ${res.data.recovery_items.length} fase/i con ore da recuperare rilevate.`);
      }
      setAddingVacation(false);
      setNewVacation({ user_id: '', start_date: '', end_date: '', reason: '' });
      loadVacations();
      loadConflicts();
      // Reload heatmap is handled by page refresh or could be handled by context/events. For now it's okay.
      window.dispatchEvent(new Event('vacationsUpdated'));
    } catch (err) {
      toast.error('Errore durante l\'aggiunta delle ferie');
    } finally {
      setSubmittingVacation(false);
    }
  }

  async function handleAddClosure(e) {
    e.preventDefault();
    if (!newClosure.start_date || !newClosure.end_date) {
      toast.error('Compila tutte le date obbligatorie.');
      return;
    }
    setSubmittingVacation(true);
    try {
      const res = await api.post(`/vacations/admin/company_closure`, {
        start_date: newClosure.start_date,
        end_date: newClosure.end_date,
        reason: newClosure.reason
      });
      toast.success('Chiusura aziendale aggiunta per tutti gli addetti.');
      if (res.data.recovery_items?.length > 0) {
        toast.warning(`⚠️ ${res.data.recovery_items.length} fase/i con ore da recuperare rilevate in totale.`);
      }
      setAddingClosure(false);
      setNewClosure({ start_date: '', end_date: '', reason: 'Chiusura Aziendale' });
      loadVacations();
      loadConflicts();
      window.dispatchEvent(new Event('vacationsUpdated'));
    } catch (err) {
      toast.error('Errore durante l\'aggiunta della chiusura aziendale');
    } finally {
      setSubmittingVacation(false);
    }
  }

  async function handleSearchSlots(e) {
    e.preventDefault();
    setIsSearching(true);
    setSearchResults(null);
    setIsSearchOpen(true);
    try {
      const { data } = await api.get('/workload/heatmap');
      const heatmap = data.heatmap;

      let results = [];

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const endDate = new Date(today);
      endDate.setMonth(endDate.getMonth() + 6);

      const targetUsers = usersList.filter(u => {
        if (searchParams.department !== 'all' && u.department !== searchParams.department) return false;
        if (searchParams.userId !== 'all' && String(u.id) !== String(searchParams.userId)) return false;
        return true;
      });

      for (const targetUser of targetUsers) {
        const uData = heatmap[targetUser.id];
        if (!uData) continue;

        let currentRun = [];
        let totalHoursInRun = 0;

        for (let d = new Date(today); d <= endDate; d.setDate(d.getDate() + 1)) {
          const dateStr = [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0')
          ].join('-');

          if (isWeekendOrHoliday(dateStr)) continue;

          const onVacation = uData.vacations && uData.vacations.some(v => dateStr >= v.start_date && dateStr <= v.end_date);
          if (onVacation) continue;

          const dailyWorkload = uData.workload[dateStr] ? uData.workload[dateStr].hours : 0;
          const freeHours = Math.max(0, 8 - dailyWorkload);

          if (searchParams.type === 'days') {
            if (freeHours === 8) {
              currentRun.push(dateStr);
              if (currentRun.length === parseInt(searchParams.quantity)) {
                results.push({
                  user: targetUser,
                  startDate: currentRun[0],
                  endDate: currentRun[currentRun.length - 1],
                  type: 'days',
                  quantity: searchParams.quantity,
                  totalHours: searchParams.quantity * 8
                });
                currentRun = [];
              }
            } else {
              currentRun = [];
            }
          } else {
            if (freeHours > 0) {
              currentRun.push({ date: dateStr, hours: freeHours });
              totalHoursInRun += freeHours;

              if (totalHoursInRun >= parseInt(searchParams.quantity)) {
                results.push({
                  user: targetUser,
                  startDate: currentRun[0].date,
                  endDate: currentRun[currentRun.length - 1].date,
                  type: 'hours',
                  quantity: searchParams.quantity,
                  totalHours: totalHoursInRun
                });
                currentRun = [];
                totalHoursInRun = 0;
              }
            } else {
              currentRun = [];
              totalHoursInRun = 0;
            }
          }
        }
      }

      results.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

      setSearchResults(results);
      setVisibleResultsCount(10);
      if (results.length === 0) {
        toast.info('Nessuno slot trovato per i criteri selezionati.');
      }
    } catch (err) {
      toast.error('Errore durante la ricerca degli slot liberi');
    } finally {
      setIsSearching(false);
    }
  }

  async function loadConflicts() {
    try {
      setLoading(true);
      const { data } = await api.get('/users/conflicts');
      setConflicts(data);
    } catch (err) {
      toast.error('Errore durante il caricamento dei conflitti');
    } finally {
      setLoading(false);
    }
  }

  function formatDate(isoString) {
    const d = new Date(isoString);
    return d.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'long', year: 'numeric' });
  }

  function formatDateShort(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;

  return (
    <div className="conflicts-page animate-fadeIn">
      <WorkloadHeatmap />

      {/* Ricerca Slot Liberi Section */}
      <div className={`workload-heatmap-container ${!isSearchOpen ? 'is-collapsed' : ''}`}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: isSearchOpen ? 16 : 0,
            cursor: 'pointer',
            userSelect: 'none'
          }}
          onClick={() => setIsSearchOpen(!isSearchOpen)}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="conflict-icon-badge conflict-badge-search">
              <AppIcon name="search" size={19} />
            </span>
            <div>
              <h3 style={{ margin: 0, fontSize: '0.98rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                Ricerca Slot Liberi
              </h3>
              <span className="conflict-section-desc">
                Trova gli spazi di tempo disponibili per uno o più addetti.
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
            {searchResults && searchResults.length > 0 && (
              <span className="badge badge-success" style={{ padding: '3px 8px', fontSize: '0.8rem', borderRadius: '12px' }}>
                {searchResults.length}
              </span>
            )}
            <div
              className="conflict-toggle-chevron"
              onClick={() => setIsSearchOpen(!isSearchOpen)}
              title={isSearchOpen ? "Comprimi" : "Espandi"}
            >
              <AppIcon name={isSearchOpen ? "chevronUp" : "chevronDown"} size={18} />
            </div>
          </div>
        </div>

        {isSearchOpen && (
          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 16 }}>
            <form onSubmit={handleSearchSlots} style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', padding: '16px', background: 'var(--bg-primary)', borderRadius: '8px' }}>
              <div style={{ flex: '1 1 200px' }}>
                <label style={{ display: 'block', marginBottom: '4px', fontSize: '0.85rem', fontWeight: 600 }}>Reparto</label>
                <select
                  value={searchParams.department}
                  onChange={e => setSearchParams({ ...searchParams, department: e.target.value, userId: 'all' })}
                  className="input"
                >
                  <option value="all">Tutti i reparti</option>
                  {[...new Set(usersList.map(u => u.department).filter(Boolean))].map(dept => (
                    <option key={dept} value={dept}>{dept === 'ufficio_tecnico' ? 'Ufficio Tecnico' : dept.charAt(0).toUpperCase() + dept.slice(1)}</option>
                  ))}
                </select>
              </div>

              <div style={{ flex: '1 1 200px' }}>
                <label style={{ display: 'block', marginBottom: '4px', fontSize: '0.85rem', fontWeight: 600 }}>Addetto</label>
                <select
                  value={searchParams.userId}
                  onChange={e => setSearchParams({ ...searchParams, userId: e.target.value })}
                  className="input"
                >
                  <option value="all">Qualsiasi Addetto</option>
                  {usersList
                    .filter(u => searchParams.department === 'all' || u.department === searchParams.department)
                    .map(u => (
                      <option key={u.id} value={u.id}>{u.full_name || u.username}</option>
                    ))}
                </select>
              </div>

              <div style={{ flex: '1 1 150px' }}>
                <label style={{ display: 'block', marginBottom: '4px', fontSize: '0.85rem', fontWeight: 600 }}>Tipo di Ricerca</label>
                <select
                  value={searchParams.type}
                  onChange={e => setSearchParams({ ...searchParams, type: e.target.value })}
                  className="input"
                >
                  <option value="days">Giorni Consecutivi</option>
                  <option value="hours">Ore Cumulate</option>
                </select>
              </div>

              <div style={{ flex: '1 1 100px' }}>
                <label style={{ display: 'block', marginBottom: '4px', fontSize: '0.85rem', fontWeight: 600 }}>
                  Quantità ({searchParams.type === 'days' ? 'gg' : 'h'})
                </label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={searchParams.quantity}
                  onChange={e => setSearchParams({ ...searchParams, quantity: e.target.value })}
                  className="input"
                  required
                />
              </div>

              <div style={{ flex: '1 1 150px' }}>
                <label style={{ display: 'block', marginBottom: '4px', fontSize: '0.85rem', fontWeight: 600 }}>A partire dal</label>
                <input
                  type="date"
                  className="input"
                  value={searchParams.fromDate}
                  onChange={e => setSearchParams({ ...searchParams, fromDate: e.target.value })}
                />
              </div>

              <div style={{ flex: '1 1 100%', display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
                <button type="submit" className="btn btn-primary" disabled={isSearching}>
                  <AppIcon name="search" />
                  {isSearching ? 'Ricerca in corso...' : 'Cerca Slot'}
                </button>
              </div>
            </form>

            {/* Risultati Slot */}
            {searchResults && searchResults.length > 0 && (
              <div style={{ marginTop: '16px', background: 'var(--bg-primary)', borderRadius: '8px', border: '1px solid var(--border-default)', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.9rem' }}>
                  <thead>
                    <tr style={{ background: 'var(--bg-tertiary)', borderBottom: '1px solid var(--border-default)' }}>
                      <th style={{ padding: '12px 16px' }}>Addetto</th>
                      <th style={{ padding: '12px 16px' }}>Reparto</th>
                      <th style={{ padding: '12px 16px' }}>Data Inizio</th>
                      <th style={{ padding: '12px 16px' }}>Data Fine</th>
                    </tr>
                  </thead>
                  <tbody>
                    {searchResults.slice(0, visibleResultsCount).map((res, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <td style={{ padding: '12px 16px', fontWeight: 600 }}>{res.user.full_name || res.user.username}</td>
                        <td style={{ padding: '12px 16px', color: 'var(--text-secondary)' }}>
                          {res.user.department === 'ufficio_tecnico' ? 'Ufficio Tecnico' : res.user.department ? res.user.department.charAt(0).toUpperCase() + res.user.department.slice(1) : '-'}
                        </td>
                        <td style={{ padding: '12px 16px' }}>{formatDate(res.startDate)}</td>
                        <td style={{ padding: '12px 16px' }}>{formatDate(res.endDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {searchResults.length > visibleResultsCount && (
                  <div style={{ padding: '16px', textAlign: 'center', borderTop: '1px solid var(--border-subtle)' }}>
                    <button
                      className="btn btn-secondary"
                      onClick={() => setVisibleResultsCount(prev => prev + 10)}
                    >
                      Mostra altri 10 risultati
                    </button>
                  </div>
                )}
              </div>
            )}
            {(!searchResults || searchResults.length === 0) && !isSearching && (
              <div style={{ padding: '16px', marginTop: '12px', background: 'var(--bg-primary)', borderRadius: '8px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                Nessun risultato da mostrare.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Conflitti Collapsible Section */}
      <div className={`workload-heatmap-container ${!isConflictsOpen ? 'is-collapsed' : ''}`}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: isConflictsOpen ? 16 : 0,
            cursor: 'pointer',
            userSelect: 'none'
          }}
          onClick={() => setIsConflictsOpen(!isConflictsOpen)}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="conflict-icon-badge conflict-badge-conflicts">
              <AppIcon name="alert" size={19} />
            </span>
            <div>
              <h3 style={{ margin: 0, fontSize: '0.98rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                Conflitti
              </h3>
              <span className="conflict-section-desc">
                Dettaglio delle sovrapposizioni critiche di pianificazione sulle fasi.
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
            {conflicts.length > 0 && (
              <span
                className="btn btn-primary btn-sm conflict-counter-badge"
                style={{
                  padding: '3px 8px',
                  fontSize: '0.8rem',
                  borderRadius: '12px',
                  color: '#ffffff',
                  fontWeight: 700
                }}
              >
                {conflicts.length}
              </span>
            )}
            <div
              className="conflict-toggle-chevron"
              onClick={() => setIsConflictsOpen(!isConflictsOpen)}
              title={isConflictsOpen ? "Comprimi" : "Espandi"}
            >
              <AppIcon name={isConflictsOpen ? "chevronUp" : "chevronDown"} size={18} />
            </div>
          </div>
        </div>

        {isConflictsOpen && (
          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 16 }}>
            {conflicts.length > 0 && (
              <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className={`btn btn-sm ${conflictFilter === 'all' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setConflictFilter('all')}
                  style={{ borderRadius: '16px', padding: '4px 12px' }}
                >
                  Tutti ({conflicts.length})
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${conflictFilter === 'overload' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setConflictFilter('overload')}
                  style={{ borderRadius: '16px', padding: '4px 12px' }}
                >
                  Sovraccarichi ({overloadCount})
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${conflictFilter === 'vacation' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setConflictFilter('vacation')}
                  style={{ borderRadius: '16px', padding: '4px 12px' }}
                >
                  Conflitti Ferie ({vacationCount})
                </button>
              </div>
            )}

            {filteredConflicts.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon"><AppIcon name="check" size={24} /></div>
                <h3>Nessun Conflitto Trovato</h3>
                <p>Tutti gli addetti hanno una schedulazione pulita a partire da oggi.</p>
              </div>
            ) : (
              <div className="conflicts-grid" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {filteredConflicts.map((c, idx) => {
                  const isVacation = c.type === 'vacation';
                  const dateLabel = c.start_date === c.end_date
                    ? formatDate(c.start_date || c.date)
                    : `${formatDateShort(c.start_date)} → ${formatDateShort(c.end_date)} (${c.workdays_count || 1} gg)`;

                  return (
                    <div key={idx} className="conflict-card card">
                      <div className="conflict-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <h3 style={{ margin: 0, color: 'var(--accent-400)', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '16px' }}>
                            <AppIcon name="user" />
                            {c.worker}
                          </h3>
                          {isVacation ? (
                            <span className="badge" style={{ background: '#ede9fe', color: '#6d28d9', fontSize: '0.78rem', padding: '3px 8px', borderRadius: '6px', fontWeight: 600 }}>
                              <AppIcon name="vacations" size={13} style={{ marginRight: 4 }} />
                              Conflitto Ferie
                            </span>
                          ) : (
                            <span className="badge" style={{ background: '#fef3c7', color: '#b45309', fontSize: '0.78rem', padding: '3px 8px', borderRadius: '6px', fontWeight: 600 }}>
                              <AppIcon name="alert" size={13} style={{ marginRight: 4 }} />
                              Sovraccarico ({c.total_hours}h/gg)
                            </span>
                          )}
                        </div>
                        <span className="badge badge-high" style={{ fontSize: '0.85rem' }}>
                          <AppIcon name="calendar" size={14} />
                          {dateLabel}
                        </span>
                      </div>

                      {isVacation ? (
                        <p className="conflict-desc" style={{ color: 'var(--text-secondary)', marginBottom: '16px', fontSize: '0.9rem' }}>
                          L'addetto è in ferie ({c.vacation_reason || 'Ferie'}) per <strong>{c.workdays_count || 1}</strong> {(c.workdays_count || 1) === 1 ? 'giorno lavorativo' : 'giorni lavorativi'} durante lo svolgimento della fase:
                        </p>
                      ) : (
                        <p className="conflict-desc" style={{ color: 'var(--text-secondary)', marginBottom: '16px', fontSize: '0.9rem' }}>
                          Ore giornaliere stimate: fino a <strong>{c.total_hours}h</strong> (limite 8h superato) per <strong>{c.workdays_count || 1}</strong> {(c.workdays_count || 1) === 1 ? 'giorno lavorativo' : 'giorni lavorativi'}, distribuite su <strong>{c.tasks?.length || 0}</strong> fasi:
                        </p>
                      )}

                      <div className="conflict-tasks-list" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        {(c.tasks || []).map(t => (
                          <div
                            key={t.task_id}
                            className="conflict-task-item"
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              background: 'var(--bg-tertiary)',
                              padding: '12px',
                              borderRadius: '8px',
                              borderLeft: isVacation ? '4px solid #8b5cf6' : '4px solid #f59e0b'
                            }}
                          >
                            <div className="task-info" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <span className="task-name" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', fontWeight: 500 }}>
                                <span style={{ color: 'var(--secondary)', display: 'flex', alignItems: 'center' }}><AppIcon name="list" size={15} /></span>
                                {t.task_name} <span style={{ color: 'var(--accent-400)', fontSize: '0.85rem', marginLeft: '0px' }}>({t.daily_hours}h/gg)</span>
                              </span>
                              <span className="task-project" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', color: '#9ca3af' }}>
                                <AppIcon name="projects" size={14} />
                                Progetto: {t.project_code && t.project_code !== "—" ? `${t.project_code}${t.project_name && t.project_name !== t.project_code && t.project_name !== "—" ? ` - ${t.project_name}` : ''}` : t.project_name}
                              </span>
                            </div>
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={() => navigate(`/projects/${t.project_id}`)}
                            >
                              Vai alla Commessa
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Panoramica Ferie Collapsible Section */}
      <div className={`workload-heatmap-container ${!isVacationsOpen ? 'is-collapsed' : ''}`}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: isVacationsOpen ? 16 : 0,
            cursor: 'pointer',
            userSelect: 'none'
          }}
          onClick={() => setIsVacationsOpen(!isVacationsOpen)}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="conflict-icon-badge conflict-badge-vacations">
              <AppIcon name="vacations" size={19} />
            </span>
            <div>
              <h3 style={{ margin: 0, fontSize: '0.98rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                Panoramica Ferie
              </h3>
              <span className="conflict-section-desc">
                Gestione centralizzata delle ferie inserite.
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
            {(user?.role === 'admin' || user?.role === 'editor') && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAddingClosure(true);
                    if (!isVacationsOpen) setIsVacationsOpen(true);
                  }}
                >
                  + Chiusura Aziendale
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAddingVacation(true);
                    if (!isVacationsOpen) setIsVacationsOpen(true);
                  }}
                >
                  + Aggiungi Ferie
                </button>
              </div>
            )}
            <div
              className="conflict-toggle-chevron"
              onClick={() => setIsVacationsOpen(!isVacationsOpen)}
              title={isVacationsOpen ? "Comprimi" : "Espandi"}
            >
              <AppIcon name={isVacationsOpen ? "chevronUp" : "chevronDown"} size={18} />
            </div>
          </div>
        </div>

        {isVacationsOpen && (
          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 16 }}>
            {vacations.length === 0 ? (
              <div className="empty-state">
                <p>Nessuna ferie inserita.</p>
              </div>
            ) : (
              <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table className="table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '700px' }}>
                    <thead style={{ background: 'var(--bg-tertiary)' }}>
                      <tr>
                        <th style={{ padding: '12px', cursor: 'pointer', userSelect: 'none' }} onClick={() => handleVacationSort('username')}>
                          Addetto {vacationSortConfig.key === 'username' && (vacationSortConfig.direction === 'asc' ? '↑' : '↓')}
                        </th>
                        <th style={{ padding: '12px', cursor: 'pointer', userSelect: 'none' }} onClick={() => handleVacationSort('start_date')}>
                          Dal {vacationSortConfig.key === 'start_date' && (vacationSortConfig.direction === 'asc' ? '↑' : '↓')}
                        </th>
                        <th style={{ padding: '12px', cursor: 'pointer', userSelect: 'none' }} onClick={() => handleVacationSort('end_date')}>
                          Al {vacationSortConfig.key === 'end_date' && (vacationSortConfig.direction === 'asc' ? '↑' : '↓')}
                        </th>
                        <th style={{ padding: '12px', cursor: 'pointer', userSelect: 'none' }} onClick={() => handleVacationSort('reason')}>
                          Motivo {vacationSortConfig.key === 'reason' && (vacationSortConfig.direction === 'asc' ? '↑' : '↓')}
                        </th>
                        {(user?.role === 'admin' || user?.role === 'editor') && <th style={{ padding: '12px', textAlign: 'right' }}>Azioni</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedVacations.slice(0, visibleVacationsCount).map(v => (
                        <tr key={v.id} style={{ borderTop: '1px solid var(--border-default)' }}>
                          <td style={{ padding: '12px', fontWeight: 600 }}>{v.full_name || v.username}</td>
                          <td style={{ padding: '12px' }}>{formatDate(v.start_date)}</td>
                          <td style={{ padding: '12px' }}>{formatDate(v.end_date)}</td>
                          <td style={{ padding: '12px', color: 'var(--text-secondary)' }}>{v.reason || '—'}</td>
                          {(user?.role === 'admin' || user?.role === 'editor') && (
                            <td style={{ padding: '12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                              <button className="btn btn-secondary btn-sm" style={{ marginRight: '8px' }} onClick={() => setEditingVacation(v)}><AppIcon name='edit' /> Modifica</button>
                              <button className="btn btn-secondary btn-sm" style={{ color: 'var(--error-500)', borderColor: 'var(--error-500)' }} onClick={() => setDeletingVacation(v)}><AppIcon name='trash' /> Elimina</button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                
                {sortedVacations.length > visibleVacationsCount && (
                  <div style={{ padding: '16px', textAlign: 'center', borderTop: '1px solid var(--border-default)' }}>
                    <button
                      className="btn btn-secondary"
                      onClick={() => setVisibleVacationsCount(prev => prev + 10)}
                    >
                      Mostra altri 10 risultati
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Edit Modal */}
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

      {/* Delete Modal */}
      {deletingVacation && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <div className="modal-header">
              <h2 style={{ color: 'var(--error-500)' }}>Elimina Ferie</h2>
              <button className="btn-ghost btn-icon" onClick={() => setDeletingVacation(null)}>
                <AppIcon name="close" />
              </button>
            </div>
            <div className="modal-content">
              <p>Sei sicuro di voler eliminare le ferie di <strong>{deletingVacation.full_name || deletingVacation.username}</strong> dal {formatDate(deletingVacation.start_date)} al {formatDate(deletingVacation.end_date)}?</p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setDeletingVacation(null)}>
                  Annulla
                </button>
                <button type="button" className="btn btn-primary" style={{ background: 'red', borderColor: 'red' }} onClick={handleDeleteVacation}>
                  Conferma Eliminazione
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modale Aggiungi Ferie */}
      {addingVacation && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 500 }}>
            <div className="modal-header">
              <h2>Inserisci Ferie</h2>
              <button className="btn-ghost btn-icon" onClick={() => setAddingVacation(false)}>
                <AppIcon name="close" />
              </button>
            </div>
            <div className="modal-content">
              <form onSubmit={handleAddVacation} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div className="form-group">
                  <label>Addetto *</label>
                  <select
                    className="input"
                    value={newVacation.user_id}
                    onChange={(e) => setNewVacation({ ...newVacation, user_id: e.target.value })}
                    required
                  >
                    <option value="">-- Seleziona Addetto --</option>
                    {usersList.map(u => (
                      <option key={u.id} value={u.id}>{u.full_name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Data di Inizio *</label>
                  <input
                    type="date"
                    className="input"
                    value={newVacation.start_date}
                    onChange={(e) => setNewVacation({ ...newVacation, start_date: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Data di Fine *</label>
                  <input
                    type="date"
                    className="input"
                    value={newVacation.end_date}
                    onChange={(e) => setNewVacation({ ...newVacation, end_date: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Descrizione (Opzionale)</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="Es. Ferie estive, Permesso..."
                    value={newVacation.reason}
                    onChange={(e) => setNewVacation({ ...newVacation, reason: e.target.value })}
                  />
                </div>
                <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '16px' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setAddingVacation(false)}>
                    Annulla
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={submittingVacation}>
                    {submittingVacation ? 'Salvataggio...' : 'Conferma'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Modale Chiusura Aziendale */}
      {addingClosure && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 500 }}>
            <div className="modal-header">
              <h2>Inserisci Chiusura Aziendale</h2>
              <button className="btn-ghost btn-icon" onClick={() => setAddingClosure(false)}>
                <AppIcon name="close" />
              </button>
            </div>
            <div className="modal-content">
              <p style={{ marginBottom: '16px', color: 'var(--text-secondary)' }}>
                Questa azione aggiungerà i giorni di ferie selezionati a <strong>tutti gli addetti</strong>.
              </p>
              <form onSubmit={handleAddClosure} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div className="form-group">
                  <label>Data di Inizio *</label>
                  <input
                    type="date"
                    className="input"
                    value={newClosure.start_date}
                    onChange={(e) => setNewClosure({ ...newClosure, start_date: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Data di Fine *</label>
                  <input
                    type="date"
                    className="input"
                    value={newClosure.end_date}
                    onChange={(e) => setNewClosure({ ...newClosure, end_date: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Descrizione</label>
                  <input
                    type="text"
                    className="input"
                    value={newClosure.reason}
                    onChange={(e) => setNewClosure({ ...newClosure, reason: e.target.value })}
                  />
                </div>
                <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '16px' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setAddingClosure(false)}>
                    Annulla
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={submittingVacation}>
                    {submittingVacation ? 'Salvataggio...' : 'Conferma'}
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
