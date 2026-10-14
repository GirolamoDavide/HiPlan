import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import itLocale from '@fullcalendar/core/locales/it';
import api from '../api/client';
import { useToast } from '../context/ToastContext';
import AppIcon from '../components/ui/AppIcon';
import './PersonalCalendarPage.css';

// Visibilità degli eventi, con gli stessi valori del blocco note
const VISIBILITY_OPTIONS = [
  { value: 'private', label: 'Solo io', icon: 'lock', color: '#64748b' },
  { value: 'selected', label: 'Utenti selezionati', icon: 'user', color: '#8b5cf6' },
  { value: 'team', label: 'Tutti', icon: 'users', color: '#10b981' },
];

export default function PersonalCalendarPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const calendarRef = useRef(null);
  const wrapperRef = useRef(null);

  const [events, setEvents] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  // Custom Toolbar State
  const [currentDateTitle, setCurrentDateTitle] = useState('');
  const [currentView, setCurrentView] = useState(() => {
    return localStorage.getItem('hiplan-personal-cal-view') || 'dayGridMonth';
  });

  // Filters State
  const [visibleTypes, setVisibleTypes] = useState(() => {
    const saved = localStorage.getItem('hiplan-personal-cal-filters');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.vacation === undefined) parsed.vacation = true;
        if (parsed.holiday === undefined) parsed.holiday = true;
        if (parsed.ticket === undefined) parsed.ticket = true;
        return parsed;
      } catch (e) { }
    }
    return {
      personal: true,
      phase: true,
      todo: true,
      ticket: true,
      vacation: true,
      holiday: true
    };
  });

  // Modal State
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState('create'); // 'create', 'edit', 'view'
  const [selectedEvent, setSelectedEvent] = useState(null);

  const [form, setForm] = useState({
    title: '',
    description: '',
    start_date: '',
    end_date: '',
    is_all_day: false,
    color: '#3b82f6',
    shared_with: [],
    visibility: 'private',
    reminder_type: 'none',
    reminder_time: ''
  });

  useEffect(() => {
    fetchEvents();
    fetchUsers();

    // Observer for sidebar resize
    if (wrapperRef.current) {
      const resizeObserver = new ResizeObserver(() => {
        if (calendarRef.current) {
          calendarRef.current.getApi().updateSize();
        }
      });
      resizeObserver.observe(wrapperRef.current);
      return () => resizeObserver.disconnect();
    }
  }, []);

  async function fetchUsers() {
    try {
      const { data } = await api.get('/users');
      setUsers(data);
    } catch (e) {
      console.error(e);
    }
  }

  async function fetchEvents() {
    setLoading(true);
    try {
      const { data } = await api.get('/calendar/events');
      // Gli eventi di altri utenti visibili a tutti sono in sola lettura
      setEvents(data.map(ev => (ev.type === 'personal' ? { ...ev, editable: ev.can_edit !== false } : ev)));
    } catch (err) {
      toast.error('Errore nel caricamento del calendario');
    } finally {
      setLoading(false);
    }
  }

  const filteredEvents = useMemo(() => {
    return events.filter(ev => {
      // Map event types to filter keys
      const typeKey = ev.extendedProps?.type || ev.type;
      return visibleTypes[typeKey];
    });
  }, [events, visibleTypes]);

  function handleDateSelect(selectInfo) {
    setModalMode('create');
    setSelectedEvent(null);

    let startStr = selectInfo.startStr;
    if (!startStr.includes('T')) {
      // If selected from month view, it's just a date 'YYYY-MM-DD'. Default to 09:00
      startStr = startStr + 'T09:00';
    }

    // Default to +1 hour
    const dStart = new Date(startStr);
    const dEnd = new Date(dStart.getTime() + 60 * 60 * 1000);

    // Format to YYYY-MM-DDTHH:mm
    const formatLocal = (d) => {
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    setForm({
      title: '',
      description: '',
      start_date: formatLocal(dStart),
      end_date: formatLocal(dEnd),
      is_all_day: false,
      color: '#3b82f6',
      shared_with: [],
      visibility: 'private',
      reminder_type: 'none',
      reminder_time: ''
    });
    setShowModal(true);
    const calendarApi = selectInfo.view.calendar;
    calendarApi.unselect();
  }

  function handleEventClick(clickInfo) {
    const ev = clickInfo.event;
    const type = ev.extendedProps.type;

    if (type === 'personal' && ev.extendedProps.can_edit !== false) {
      setModalMode('edit');
      setSelectedEvent(ev);

      let formEnd = ev.endStr ? ev.endStr.slice(0, 16) : ev.startStr.slice(0, 16);
      if (ev.allDay && ev.endStr) {
        const d = new Date(ev.endStr);
        d.setDate(d.getDate() - 1);
        const pad = n => String(n).padStart(2, '0');
        formEnd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00`;
      }

      setForm({
        title: ev.title,
        description: ev.extendedProps.description || '',
        start_date: ev.startStr.slice(0, 16),
        end_date: formEnd,
        is_all_day: ev.allDay,
        color: ev.backgroundColor,
        shared_with: ev.extendedProps.shared_with || [],
        visibility: ev.extendedProps.visibility || ((ev.extendedProps.shared_with || []).length ? 'selected' : 'private'),
        reminder_type: ev.extendedProps.reminder_type || 'none',
        reminder_time: ev.extendedProps.reminder_time ? ev.extendedProps.reminder_time.slice(0, 16) : ''
      });
      setShowModal(true);
    } else {
      setModalMode('view');
      setSelectedEvent(ev);
      setShowModal(true);
    }
  }

  async function handleEventDrop(dropInfo) {
    const ev = dropInfo.event;
    if (ev.extendedProps.type !== 'personal' || ev.extendedProps.can_edit === false) {
      dropInfo.revert();
      toast.error('Puoi spostare solo i tuoi eventi o quelli condivisi con te');
      return;
    }

    try {
      let finalStart = ev.startStr;
      let finalEnd = ev.endStr || ev.startStr;

      if (ev.allDay && ev.endStr) {
        const d = new Date(ev.endStr);
        d.setDate(d.getDate() - 1);
        const pad = n => String(n).padStart(2, '0');
        finalEnd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00`;
      }

      await api.put(`/calendar/events/${ev.extendedProps.real_id}`, {
        start_date: ev.allDay ? finalStart.split('T')[0] : finalStart,
        end_date: ev.allDay ? finalEnd.split('T')[0] : finalEnd,
        is_all_day: ev.allDay
      });
      toast.success('Evento aggiornato');
    } catch (err) {
      dropInfo.revert();
      toast.error('Errore nell\'aggiornamento dell\'evento');
    }
  }

  async function saveEvent(e) {
    e.preventDefault();
    try {
      let finalStart = form.start_date;
      let finalEnd = form.end_date || form.start_date;

      if (form.is_all_day) {
        finalStart = finalStart.split('T')[0];
        finalEnd = finalEnd.split('T')[0];
      }

      let computedReminderTime = null;
      if (form.reminder_type === 'day_before') {
        const d = new Date(form.start_date);
        d.setDate(d.getDate() - 1);
        computedReminderTime = d.toISOString();
      } else if (form.reminder_type === 'week_before') {
        const d = new Date(form.start_date);
        d.setDate(d.getDate() - 7);
        computedReminderTime = d.toISOString();
      } else if (form.reminder_type === 'custom') {
        computedReminderTime = form.reminder_time ? new Date(form.reminder_time).toISOString() : null;
      }

      const visibilityPayload = {
        visibility: form.visibility,
        shared_with: form.visibility === 'selected' ? form.shared_with : [],
      };

      if (form.visibility === 'selected' && form.shared_with.length === 0) {
        toast.error('Seleziona almeno una persona con cui condividere l\'evento');
        return;
      }

      if (modalMode === 'create') {
        await api.post('/calendar/events', {
          ...form,
          ...visibilityPayload,
          start_date: finalStart,
          end_date: finalEnd,
          reminder_time: computedReminderTime
        });
        toast.success('Evento creato');
      } else if (modalMode === 'edit') {
        await api.put(`/calendar/events/${selectedEvent.extendedProps.real_id}`, {
          ...form,
          ...visibilityPayload,
          start_date: finalStart,
          end_date: finalEnd,
          reminder_time: computedReminderTime
        });
        toast.success('Evento aggiornato');
      }
      setShowModal(false);
      fetchEvents();
    } catch (err) {
      toast.error('Errore durante il salvataggio');
    }
  }

  async function deleteEvent() {
    if (!selectedEvent || selectedEvent.extendedProps.type !== 'personal') return;
    if (!window.confirm('Vuoi davvero eliminare questo evento?')) return;

    try {
      await api.delete(`/calendar/events/${selectedEvent.extendedProps.real_id}`);
      toast.success('Evento eliminato');
      setShowModal(false);
      fetchEvents();
    } catch (err) {
      toast.error('Errore durante l\'eliminazione');
    }
  }

  const changeView = (viewName) => {
    if (calendarRef.current) {
      calendarRef.current.getApi().changeView(viewName);
      setCurrentView(viewName);
      localStorage.setItem('hiplan-personal-cal-view', viewName);
    }
  };

  const navigateCalendar = (action) => {
    if (calendarRef.current) {
      const api = calendarRef.current.getApi();
      if (action === 'prev') api.prev();
      if (action === 'next') api.next();
      if (action === 'today') api.today();
    }
  };

  const toggleFilter = (type) => {
    setVisibleTypes(prev => {
      const next = { ...prev, [type]: !prev[type] };
      localStorage.setItem('hiplan-personal-cal-filters', JSON.stringify(next));
      return next;
    });
  };

  function renderViewModal() {
    if (!selectedEvent) return null;
    const { type, real_id, project_id } = selectedEvent.extendedProps;

    return (
      <div className="calendar-modal-content">
        <div className="calendar-modal-header-badge" style={{ marginBottom: 12 }}>
          <span style={{
            padding: '4px 10px',
            borderRadius: 6,
            background: type === 'personal' ? '#3b82f6' : type === 'phase' ? '#f59e0b' : type === 'todo' ? '#f97316' : type === 'vacation' ? '#ef4444' : type === 'holiday' ? '#10b981' : '#8b5cf6',
            color: '#fff',
            fontSize: '0.75rem',
            fontWeight: 700
          }}>
            {type === 'personal' && 'Evento'}
            {type === 'phase' && 'Fase Commessa'}
            {type === 'todo' && 'Da Fare (TODO)'}
            {type === 'ticket' && 'Ticket Supporto'}
            {type === 'vacation' && 'Ferie'}
            {type === 'holiday' && 'Festività Nazionale'}
          </span>
        </div>

        {type === 'personal' && selectedEvent.extendedProps?.owner_name && (
          <div className="calendar-modal-row">
            <span className="calendar-modal-label">Creato da</span>
            <span className="calendar-modal-val">
              {selectedEvent.extendedProps.owner_name}
              {' · '}
              {VISIBILITY_OPTIONS.find(o => o.value === selectedEvent.extendedProps.visibility)?.label || 'Solo io'}
            </span>
          </div>
        )}

        <div className="calendar-modal-row">
          <span className="calendar-modal-label">Titolo</span>
          <span className="calendar-modal-val">{selectedEvent.title}</span>
        </div>

        <div className="calendar-modal-row">
          <span className="calendar-modal-label">Periodo</span>
          <span className="calendar-modal-val">
            {(() => {
              const startStr = new Date(selectedEvent.start).toLocaleDateString('it-IT');
              let endStr = '';
              if (selectedEvent.end) {
                const endDate = new Date(selectedEvent.end);
                if (selectedEvent.allDay) {
                  endDate.setDate(endDate.getDate() - 1); // FullCalendar sets end exclusive for allDay
                }
                const endFormatted = endDate.toLocaleDateString('it-IT');
                if (endFormatted !== startStr) {
                  endStr = ` - ${endFormatted}`;
                }
              }
              return startStr + endStr;
            })()}
          </span>
        </div>

        {selectedEvent.extendedProps?.shared_with?.length > 0 && (
          <div className="calendar-modal-row" style={{ flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
            <span className="calendar-modal-label">Condiviso con</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {selectedEvent.extendedProps.shared_with.map(u => (
                <span key={u} style={{ background: 'var(--bg-card)', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-default)', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  {u}
                </span>
              ))}
            </div>
          </div>
        )}

        {selectedEvent.extendedProps?.description && (
          <div style={{ marginTop: 6, background: 'var(--bg-primary)', padding: 14, borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
            <span className="calendar-modal-label" style={{ display: 'block', marginBottom: 4 }}>Note e Specifiche</span>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-primary)', margin: 0 }}>
              {selectedEvent.extendedProps.description}
            </p>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
          <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>Chiudi</button>

          {type === 'phase' && (
            <button className="btn btn-primary" onClick={() => navigate(`/projects/${project_id}`)}>Vai alla Commessa</button>
          )}
          {type === 'todo' && (
            <button className="btn btn-primary" onClick={() => navigate('/todo')}>Vai ai TODO</button>
          )}
          {type === 'ticket' && (
            <button className="btn btn-primary" onClick={() => navigate('/tickets')}>Vai ai Ticket</button>
          )}
        </div>
      </div>
    );
  }

  function renderEditCreateModal() {
    const canChangeVisibility = modalMode === 'create' || selectedEvent?.extendedProps?.is_owner !== false;
    return (
      <form onSubmit={saveEvent} className="calendar-modal-content">
        <div className="input-group">
          <label>Titolo Evento *</label>
          <input
            className="input"
            value={form.title}
            onChange={e => setForm({ ...form, title: e.target.value })}
            required
            placeholder="Riunione, Appuntamento, Ferie..."
          />
        </div>

        <div className="input-group">
          <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.is_all_day}
              onChange={e => setForm({ ...form, is_all_day: e.target.checked })}
            />
            Tutto il giorno
          </label>
        </div>

        <div style={{ display: 'flex', gap: 16 }}>
          <div className="input-group" style={{ flex: 1 }}>
            <label>Inizio *</label>
            <input
              type={form.is_all_day ? 'date' : 'datetime-local'}
              className="input"
              value={form.is_all_day ? form.start_date.split('T')[0] : form.start_date}
              onChange={e => setForm({ ...form, start_date: e.target.value })}
              required
            />
          </div>
          <div className="input-group" style={{ flex: 1 }}>
            <label>Fine</label>
            <input
              type={form.is_all_day ? 'date' : 'datetime-local'}
              className="input"
              value={form.end_date ? (form.is_all_day ? form.end_date.split('T')[0] : form.end_date) : ''}
              onChange={e => setForm({ ...form, end_date: e.target.value })}
            />
          </div>
        </div>

        <div className="input-group">
          <label>Etichette</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {[
              { label: 'Riunione', color: '#3b82f6' },
              { label: 'Visita Medica', color: '#10b981' },
              { label: 'Permesso', color: '#8b5cf6' },
              { label: 'Fiera', color: '#ec4899' },
              { label: 'Manutenzione', color: '#f59e0b' },
              { label: 'Trasferta', color: '#ef4444' },
              { label: 'Altro', color: '#64748b' }
            ].map(preset => (
              <button
                key={preset.label}
                type="button"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '4px 10px',
                  borderRadius: '20px',
                  fontSize: '0.8125rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: form.color === preset.color ? `1px solid ${preset.color}` : '1px solid var(--border-default)',
                  background: form.color === preset.color ? `color-mix(in srgb, ${preset.color} 15%, transparent)` : 'var(--bg-primary)',
                  color: form.color === preset.color ? preset.color : 'var(--text-secondary)'
                }}
                onClick={() => setForm(prev => ({ ...prev, title: prev.title === '' || ['Riunione', 'Visita Medica', 'Ferie', 'Permesso', 'Fiera', 'Trasferta', 'Altro'].includes(prev.title) ? preset.label : prev.title, color: preset.color }))}
              >
                <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: preset.color, marginRight: 6 }}></span>
                {preset.label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Colore personalizzato:</span>
            <input
              type="color"
              value={form.color}
              onChange={e => setForm({ ...form, color: e.target.value })}
              style={{ width: 32, height: 32, padding: 0, cursor: 'pointer', borderRadius: 4, border: '1px solid var(--border-default)', background: 'var(--bg-tertiary)' }}
            />
          </div>
        </div>

        <div className="input-group">
          <label>Chi può vedere l'evento</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {VISIBILITY_OPTIONS.map(opt => (
              <button
                key={opt.value}
                type="button"
                className={`filter-chip ${form.visibility === opt.value ? 'active' : ''}`}
                style={{ '--chip-color': opt.color, margin: 0 }}
                disabled={!canChangeVisibility}
                onClick={() => setForm({ ...form, visibility: opt.value })}
              >
                <AppIcon name={opt.icon} size={13} />
                {opt.label}
              </button>
            ))}
          </div>
          {!canChangeVisibility && (
            <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
              Solo chi ha creato l'evento può cambiarne la visibilità.
            </span>
          )}
        </div>

        {form.visibility === 'selected' && (
        <div className="input-group">
          <label>Condividi con *</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxHeight: 110, overflowY: 'auto', paddingBottom: 4 }}>
            {users.map(u => {
              const isSelected = form.shared_with.includes(u.username);
              return (
                <label key={u.id} className={`filter-chip ${isSelected ? 'active' : ''}`} style={{ '--chip-color': '#10b981', margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={e => {
                      const checked = e.target.checked;
                      setForm(prev => ({
                        ...prev,
                        shared_with: checked
                          ? [...prev.shared_with, u.username]
                          : prev.shared_with.filter(un => un !== u.username)
                      }));
                    }}
                  />
                  {u.full_name || u.username}
                </label>
              );
            })}
            {users.length === 0 && <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Nessun utente caricato</span>}
          </div>
        </div>
        )}

        <div className="input-group">
          <label>Promemoria (Notifica Email)</label>
          <div style={{ display: 'flex', gap: 16 }}>
            <select
              className="input"
              value={form.reminder_type}
              onChange={e => setForm({ ...form, reminder_type: e.target.value })}
              style={{ flex: 1 }}
            >
              <option value="none">Nessuno</option>
              <option value="day_before">Il giorno prima</option>
              <option value="week_before">Una settimana prima</option>
              <option value="custom">Personalizzato</option>
            </select>

            {form.reminder_type === 'custom' && (
              <input
                type="datetime-local"
                className="input"
                value={form.reminder_time}
                onChange={e => setForm({ ...form, reminder_time: e.target.value })}
                required={form.reminder_type === 'custom'}
                style={{ flex: 1 }}
              />
            )}
          </div>
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
            Invia un'email di promemoria a te e alle persone con cui hai condiviso l'evento.
          </span>
        </div>

        <div className="input-group">
          <label>Descrizione / Note</label>
          <textarea
            className="input"
            style={{ minHeight: 70, padding: '10px 14px' }}
            value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
          {modalMode === 'edit' ? (
            <button type="button" className="btn btn-danger" onClick={deleteEvent}>Elimina</button>
          ) : <div></div>}

          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>Annulla</button>
            <button type="submit" className="btn btn-primary">Salva</button>
          </div>
        </div>
      </form>
    );
  }

  return (
    <div className="personal-calendar-page">
      {/* Header and Controls */}
      <div className="calendar-header-toolbar">
        <div className="calendar-controls-row">

          <div className="calendar-nav-section">
            <h1 className="calendar-month-title">
              {currentDateTitle}
            </h1>
            <div className="calendar-nav-buttons">
              <button className="calendar-nav-btn" onClick={() => navigateCalendar('prev')}>‹ Prec.</button>
              <button className="calendar-nav-btn today" onClick={() => navigateCalendar('today')}>Oggi</button>
              <button className="calendar-nav-btn" onClick={() => navigateCalendar('next')}>Succ. ›</button>
            </div>
          </div>

          <div className="calendar-actions-section">
            <div className="calendar-filters-section" style={{ display: 'flex', gap: '8px', marginRight: '8px' }}>
              <label className={`filter-chip ${visibleTypes.personal ? 'active' : ''}`} style={{ '--chip-color': '#3b82f6', margin: 0 }}>
                <input type="checkbox" checked={visibleTypes.personal} onChange={() => toggleFilter('personal')} />
                Eventi
              </label>
              <label className={`filter-chip ${visibleTypes.phase ? 'active' : ''}`} style={{ '--chip-color': '#f59e0b', margin: 0 }}>
                <input type="checkbox" checked={visibleTypes.phase} onChange={() => toggleFilter('phase')} />
                Fasi
              </label>
              <label className={`filter-chip ${visibleTypes.todo ? 'active' : ''}`} style={{ '--chip-color': '#f97316', margin: 0 }}>
                <input type="checkbox" checked={visibleTypes.todo} onChange={() => toggleFilter('todo')} />
                Todo
              </label>
              <label className={`filter-chip ${visibleTypes.ticket ? 'active' : ''}`} style={{ '--chip-color': '#6366f1', margin: 0 }}>
                <input type="checkbox" checked={visibleTypes.ticket} onChange={() => toggleFilter('ticket')} />
                Ticket
              </label>
              <label className={`filter-chip ${visibleTypes.vacation ? 'active' : ''}`} style={{ '--chip-color': '#ef4444', margin: 0 }}>
                <input type="checkbox" checked={visibleTypes.vacation} onChange={() => toggleFilter('vacation')} />
                Ferie
              </label>
              <label className={`filter-chip ${visibleTypes.holiday ? 'active' : ''}`} style={{ '--chip-color': '#10b981', margin: 0 }}>
                <input type="checkbox" checked={visibleTypes.holiday} onChange={() => toggleFilter('holiday')} />
                Festività
              </label>
            </div>

            <div className="calendar-view-toggle">
              <button className={`calendar-view-btn ${currentView === 'dayGridMonth' ? 'active' : ''}`} onClick={() => changeView('dayGridMonth')}>
                Mese
              </button>
              <button className={`calendar-view-btn ${currentView === 'timeGridWeek' ? 'active' : ''}`} onClick={() => changeView('timeGridWeek')}>
                Settimana
              </button>
              <button className={`calendar-view-btn ${currentView === 'timeGridDay' ? 'active' : ''}`} onClick={() => changeView('timeGridDay')}>
                Giorno
              </button>
            </div>
          </div>

        </div>
      </div>

      <div className="calendar-wrapper" ref={wrapperRef}>
        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView={currentView}
          locales={[itLocale]}
          locale="it"
          headerToolbar={false} // Disable default toolbar
          datesSet={(arg) => setCurrentDateTitle(arg.view.title)}
          editable={true} // allows drag & drop
          selectable={true}
          selectMirror={true}
          dayMaxEvents={true}
          weekends={true}
          firstDay={1}
          hiddenDays={[]}
          events={filteredEvents}
          eventDisplay="block"
          select={handleDateSelect}
          eventClick={handleEventClick}
          eventDrop={handleEventDrop}
          eventResize={handleEventDrop}
          height="100%"
        />
      </div>

      {showModal && (
        <div className="modal-overlay animate-fadeIn">
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 950, width: '100%', padding: 28, maxHeight: '90vh', overflowY: 'auto' }}>
            <div className="modal-header">
              <h2>
                {modalMode === 'create' && 'Nuovo Evento'}
                {modalMode === 'edit' && 'Modifica Evento'}
                {modalMode === 'view' && 'Dettaglio'}
              </h2>
              <button className="btn-ghost btn-icon" onClick={() => setShowModal(false)}>
                <AppIcon name="close" />
              </button>
            </div>

            {modalMode === 'view' ? renderViewModal() : renderEditCreateModal()}

          </div>
        </div>
      )}
    </div>
  );
}
