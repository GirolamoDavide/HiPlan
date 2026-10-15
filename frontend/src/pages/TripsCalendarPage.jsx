import { useState, useEffect, useRef, useMemo } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import itLocale from '@fullcalendar/core/locales/it';
import api from '../api/client';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import AppIcon from '../components/ui/AppIcon';
import AssigneeInput from '../components/ui/AssigneeInput';
import AccessListsModal from '../components/ui/AccessListsModal';
import SearchableCombobox from '../components/ui/SearchableCombobox';
import { getApiErrorMessage } from '../utils/apiErrors';
import './PersonalCalendarPage.css';

const TRIP_COLORS = ['#0ea5e9', '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

const EMPTY_FORM = {
  title: '',
  destination: '',
  start_date: '',
  end_date: '',
  start_time: '',
  end_time: '',
  travelers: [],
  project_id: '',
  notes: '',
  color: TRIP_COLORS[0],
};

// Date 'YYYY-MM-DD' senza passare dal fuso orario
function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  const pad = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function formatDateIt(dateStr) {
  return dateStr ? dateStr.split('-').reverse().join('/') : '';
}

// Es. "20/10/2026 14:00 – 22/10/2026 11:30" (orari facoltativi)
function formatTripPeriod(trip) {
  const start = [formatDateIt(trip.start_date), trip.start_time].filter(Boolean).join(' ');
  const end = [trip.end_date !== trip.start_date ? formatDateIt(trip.end_date) : '', trip.end_time].filter(Boolean).join(' ');
  return end ? `${start} – ${end}` : start;
}

export default function TripsCalendarPage() {
  const toast = useToast();
  const { user } = useAuth();
  const calendarRef = useRef(null);

  const [access, setAccess] = useState(null);
  const [trips, setTrips] = useState([]);
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [currentTitle, setCurrentTitle] = useState('');
  const [currentView, setCurrentView] = useState('dayGridMonth');

  const [modalMode, setModalMode] = useState(null); // 'create' | 'edit' | 'view' | null
  const [selectedTrip, setSelectedTrip] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showAccess, setShowAccess] = useState(false);

  const canEdit = Boolean(access?.can_edit);
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    api.get('/trips/access')
      .then(({ data }) => setAccess(data))
      .catch(() => setAccess({ can_view: false, can_edit: false }));
    api.get('/users').then(({ data }) => setUsers(Array.isArray(data) ? data : [])).catch(() => {});
    api.get('/projects').then(({ data }) => setProjects(Array.isArray(data) ? data : [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (access?.can_view) loadTrips();
  }, [access?.can_view]);

  async function loadTrips() {
    try {
      const { data } = await api.get('/trips');
      setTrips(Array.isArray(data) ? data : []);
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Errore nel caricamento dei viaggi'));
    }
  }

  // Commesse esistenti cercabili per codice, nome o cliente
  const projectOptions = useMemo(() => projects.map(p => ({
    value: p.id,
    label: [p.code, p.name].filter(Boolean).join(' – ') + (p.client ? ` (${p.client})` : ''),
  })), [projects]);

  const userLabel = useMemo(() => {
    const map = new Map(users.map(u => [u.username, u.full_name || u.username]));
    return username => map.get(username) || username;
  }, [users]);

  const events = useMemo(() => trips.map(t => {
    const hasTimes = Boolean(t.start_time || t.end_time);
    return {
      id: t.id,
      title: [t.start_time, t.destination || t.title, t.travelers.map(userLabel).join(', ')].filter(Boolean).join(' · '),
      // Con un orario il viaggio occupa la sua fascia nella vista Giorno; senza orario è "tutto il giorno"
      start: hasTimes ? `${t.start_date}T${t.start_time || '00:00'}` : t.start_date,
      end: hasTimes ? `${t.end_date}T${t.end_time || '23:59'}` : shiftDate(t.end_date, 1), // fine esclusiva per la giornata intera
      allDay: !hasTimes,
      backgroundColor: t.color,
      borderColor: t.color,
      editable: canEdit,
      extendedProps: { trip: t },
    };
  }), [trips, userLabel, canEdit]);

  function openCreate(startDate, endDate, startTime = '', endTime = '') {
    setSelectedTrip(null);
    setForm({ ...EMPTY_FORM, start_date: startDate, end_date: endDate || startDate, start_time: startTime, end_time: endTime });
    setModalMode('create');
  }

  function openTrip(trip) {
    setSelectedTrip(trip);
    setForm({
      title: trip.title,
      destination: trip.destination || '',
      start_date: trip.start_date,
      end_date: trip.end_date,
      start_time: trip.start_time || '',
      end_time: trip.end_time || '',
      travelers: trip.travelers,
      project_id: trip.project_id || '',
      notes: trip.notes || '',
      color: trip.color || TRIP_COLORS[0],
    });
    setModalMode(canEdit ? 'edit' : 'view');
  }

  function handleSelect(info) {
    info.view.calendar.unselect();
    if (!canEdit) return;
    if (info.allDay) {
      openCreate(info.startStr, shiftDate(info.endStr, -1));
    } else {
      // Selezione di una fascia oraria nella vista Giorno: date e orari già compilati
      openCreate(info.startStr.slice(0, 10), info.endStr.slice(0, 10), info.startStr.slice(11, 16), info.endStr.slice(11, 16));
    }
  }

  async function handleDrop(info) {
    const trip = info.event.extendedProps.trip;
    const { startStr, endStr, allDay } = info.event;
    let dates;
    if (allDay) {
      dates = { start_date: startStr, end_date: endStr ? shiftDate(endStr, -1) : startStr };
    } else {
      // Evento con orario: lo spostamento cambia anche gli orari di partenza e ritorno
      const end = endStr || startStr;
      dates = {
        start_date: startStr.slice(0, 10), start_time: startStr.slice(11, 16),
        end_date: end.slice(0, 10), end_time: end.slice(11, 16),
      };
    }
    try {
      await api.put(`/trips/${trip.id}`, { ...trip, ...dates, project_id: trip.project_id || null });
      loadTrips();
    } catch (err) {
      info.revert();
      toast.error(getApiErrorMessage(err, 'Errore nello spostamento del viaggio'));
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    if (form.start_date === form.end_date && form.start_time && form.end_time && form.end_time < form.start_time) {
      toast.error("L'orario di ritorno non può precedere la partenza");
      return;
    }
    const payload = {
      ...form,
      project_id: form.project_id || null,
      start_time: form.start_time || null,
      end_time: form.end_time || null,
    };
    try {
      if (modalMode === 'create') {
        await api.post('/trips', payload);
        toast.success('Viaggio inserito');
      } else {
        await api.put(`/trips/${selectedTrip.id}`, payload);
        toast.success('Viaggio aggiornato');
      }
      setModalMode(null);
      loadTrips();
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Errore durante il salvataggio del viaggio'));
    }
  }

  async function handleDelete() {
    if (!window.confirm('Eliminare questo viaggio?')) return;
    try {
      await api.delete(`/trips/${selectedTrip.id}`);
      toast.success('Viaggio eliminato');
      setModalMode(null);
      loadTrips();
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Errore durante l\'eliminazione'));
    }
  }

  function changeView(view) {
    calendarRef.current?.getApi().changeView(view);
    setCurrentView(view);
  }

  function navigateCalendar(action) {
    const calApi = calendarRef.current?.getApi();
    if (!calApi) return;
    if (action === 'prev') calApi.prev();
    if (action === 'next') calApi.next();
    if (action === 'today') calApi.today();
  }

  if (access === null) {
    return <div className="personal-calendar-page" />;
  }

  if (!access.can_view) {
    return (
      <div className="personal-calendar-page">
        <div className="empty-state" style={{ marginTop: 60 }}>
          <div className="empty-state-icon"><AppIcon name="lock" size={26} /></div>
          <h3>Non hai accesso al calendario viaggi</h3>
          <p>Chiedi a un amministratore di aggiungerti tra le persone che possono vederlo.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="personal-calendar-page">
      <div className="calendar-header-toolbar">
        <div className="calendar-controls-row">
          <div className="calendar-nav-section">
            <h1 className="calendar-month-title">{currentTitle}</h1>
            <div className="calendar-nav-buttons">
              <button className="calendar-nav-btn" onClick={() => navigateCalendar('prev')}>‹ Prec.</button>
              <button className="calendar-nav-btn today" onClick={() => navigateCalendar('today')}>Oggi</button>
              <button className="calendar-nav-btn" onClick={() => navigateCalendar('next')}>Succ. ›</button>
            </div>
          </div>

          <div className="calendar-actions-section">
            {isAdmin && (
              <button className="btn btn-secondary btn-sm" onClick={() => setShowAccess(true)}>
                <AppIcon name="users" size={14} /> Permessi
              </button>
            )}
            {canEdit && (
              <button className="btn btn-primary btn-sm" onClick={() => {
                const today = shiftDate(new Date().toLocaleDateString('sv-SE'), 0);
                openCreate(today, today);
              }}>
                <AppIcon name="send" size={14} /> Nuovo viaggio
              </button>
            )}
            <div className="calendar-view-toggle">
              <button className={`calendar-view-btn ${currentView === 'dayGridMonth' ? 'active' : ''}`} onClick={() => changeView('dayGridMonth')}>
                Mese
              </button>
              <button className={`calendar-view-btn ${currentView === 'dayGridWeek' ? 'active' : ''}`} onClick={() => changeView('dayGridWeek')}>
                Settimana
              </button>
              <button className={`calendar-view-btn ${currentView === 'timeGridDay' ? 'active' : ''}`} onClick={() => changeView('timeGridDay')}>
                Giorno
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="calendar-wrapper">
        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView={currentView}
          locales={[itLocale]}
          locale="it"
          headerToolbar={false}
          datesSet={arg => setCurrentTitle(arg.view.title)}
          selectable={canEdit}
          select={handleSelect}
          events={events}
          eventClick={info => openTrip(info.event.extendedProps.trip)}
          eventDrop={handleDrop}
          eventResize={handleDrop}
          dayMaxEvents={true}
          firstDay={1}
          eventDisplay="block"
          displayEventTime={false} // l'orario di partenza è già nel titolo
          scrollTime="07:00:00"
          allDayText="Tutto il giorno"
          height="100%"
        />
      </div>

      {modalMode && (
        <div className="modal-overlay animate-fadeIn">
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 640, width: '100%', padding: 28, maxHeight: '90vh', overflowY: 'auto' }}>
            <div className="modal-header">
              <h2>
                {modalMode === 'create' && 'Nuovo viaggio'}
                {modalMode === 'edit' && 'Modifica viaggio'}
                {modalMode === 'view' && 'Dettaglio viaggio'}
              </h2>
              <button className="btn-ghost btn-icon" onClick={() => setModalMode(null)} aria-label="Chiudi"><AppIcon name="close" /></button>
            </div>

            {modalMode === 'view' ? (
              <div className="calendar-modal-content">
                <div className="calendar-modal-row"><span className="calendar-modal-label">Viaggio</span><span className="calendar-modal-val">{selectedTrip.title}</span></div>
                {selectedTrip.destination && (
                  <div className="calendar-modal-row"><span className="calendar-modal-label">Destinazione</span><span className="calendar-modal-val">{selectedTrip.destination}</span></div>
                )}
                <div className="calendar-modal-row">
                  <span className="calendar-modal-label">Periodo</span>
                  <span className="calendar-modal-val">{formatTripPeriod(selectedTrip)}</span>
                </div>
                <div className="calendar-modal-row"><span className="calendar-modal-label">Partecipanti</span><span className="calendar-modal-val">{selectedTrip.travelers.map(userLabel).join(', ') || '—'}</span></div>
                {selectedTrip.project_code && (
                  <div className="calendar-modal-row"><span className="calendar-modal-label">Commessa</span><span className="calendar-modal-val">{selectedTrip.project_code}</span></div>
                )}
                {selectedTrip.notes && (
                  <div className="calendar-modal-row"><span className="calendar-modal-label">Note</span><span className="calendar-modal-val">{selectedTrip.notes}</span></div>
                )}
                {selectedTrip.created_by_name && (
                  <div className="calendar-modal-row"><span className="calendar-modal-label">Inserito da</span><span className="calendar-modal-val">{selectedTrip.created_by_name}</span></div>
                )}
              </div>
            ) : (
              <form onSubmit={handleSave} className="calendar-modal-content">
                <div className="input-group">
                  <label htmlFor="trip-title">Titolo *</label>
                  <input id="trip-title" className="input" value={form.title} required placeholder="Es. Collaudo impianto, Fiera, Visita cliente"
                    onChange={e => setForm({ ...form, title: e.target.value })} />
                </div>
                <div className="input-group">
                  <label htmlFor="trip-destination">Destinazione</label>
                  <input id="trip-destination" className="input" value={form.destination} placeholder="Città, cliente o stabilimento"
                    onChange={e => setForm({ ...form, destination: e.target.value })} />
                </div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <div className="input-group" style={{ flex: '1 1 240px' }}>
                    <label htmlFor="trip-start">Partenza *</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input id="trip-start" type="date" className="input" style={{ flex: 1 }} value={form.start_date} required
                        onChange={e => setForm({ ...form, start_date: e.target.value, end_date: form.end_date < e.target.value ? e.target.value : form.end_date })} />
                      <input type="time" className="input" style={{ width: 110 }} value={form.start_time} aria-label="Orario di partenza"
                        onChange={e => setForm({ ...form, start_time: e.target.value })} />
                    </div>
                  </div>
                  <div className="input-group" style={{ flex: '1 1 240px' }}>
                    <label htmlFor="trip-end">Ritorno *</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input id="trip-end" type="date" className="input" style={{ flex: 1 }} value={form.end_date} min={form.start_date} required
                        onChange={e => setForm({ ...form, end_date: e.target.value })} />
                      <input type="time" className="input" style={{ width: 110 }} value={form.end_time} aria-label="Orario di ritorno"
                        onChange={e => setForm({ ...form, end_time: e.target.value })} />
                    </div>
                  </div>
                </div>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: -8 }}>
                  Gli orari sono facoltativi: servono a capire se si parte o si rientra al mattino o al pomeriggio.
                </span>
                <div className="input-group">
                  <label>Partecipanti</label>
                  <AssigneeInput selected={form.travelers} onChange={travelers => setForm({ ...form, travelers })} users={users} placeholder="Aggiungi partecipanti..." />
                </div>
                <div className="input-group">
                  <label>Commessa collegata</label>
                  <SearchableCombobox
                    value={form.project_id}
                    onChange={(val, opt) => {
                      // Solo commesse esistenti: si sceglie dai suggerimenti, svuotando il campo si toglie il collegamento
                      if (opt) setForm(f => ({ ...f, project_id: opt.value }));
                      else if (!String(val || '').trim()) setForm(f => ({ ...f, project_id: '' }));
                    }}
                    options={projectOptions}
                    placeholder="Scrivi codice, nome o cliente della commessa…"
                  />
                </div>
                <div className="input-group">
                  <label>Colore</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {TRIP_COLORS.map(c => (
                      <button key={c} type="button" aria-label={`Colore ${c}`} onClick={() => setForm({ ...form, color: c })}
                        style={{ width: 26, height: 26, borderRadius: '50%', background: c, cursor: 'pointer', border: form.color === c ? '3px solid var(--text-primary)' : '2px solid var(--border-default)' }} />
                    ))}
                  </div>
                </div>
                <div className="input-group">
                  <label htmlFor="trip-notes">Note</label>
                  <textarea id="trip-notes" className="input" style={{ minHeight: 70, padding: '10px 14px' }} value={form.notes}
                    onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Mezzo, alloggio, orari..." />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
                  {modalMode === 'edit' ? <button type="button" className="btn btn-danger" onClick={handleDelete}>Elimina</button> : <div />}
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button type="button" className="btn btn-secondary" onClick={() => setModalMode(null)}>Annulla</button>
                    <button type="submit" className="btn btn-primary">Salva</button>
                  </div>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {showAccess && (
        <AccessListsModal
          title="Permessi calendario viaggi"
          endpoint="/trips/settings/access"
          sectionName="il calendario viaggi"
          editorsLabel="Possono compilare (inserire, modificare ed eliminare viaggi)"
          users={users}
          onClose={() => setShowAccess(false)}
        />
      )}
    </div>
  );
}
