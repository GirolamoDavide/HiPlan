import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import AppIcon from '../components/ui/AppIcon';
import SearchableCombobox from '../components/ui/SearchableCombobox';
import { Ticket, ChevronDown, CloudUpload } from 'lucide-react';
import './TicketsPage.css';

const BACKEND_URL = import.meta.env.VITE_API_URL
  ? import.meta.env.VITE_API_URL.replace(/\/api\/?$/, '')
  : `http://${window.location.hostname}:8000`;

/* ─── helpers ─── */
const PRIORITY_LABEL = { low: 'Bassa', medium: 'Media', high: 'Alta' };
const STATUS_CLASS = {
  'Da gestire': 'da-gestire',
  'In attesa del cliente': 'in-attesa',
  'Completato': 'completato'
};

function fmtDate(dt) {
  if (!dt) return '';
  return new Date(dt).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(dt) {
  if (!dt) return '';
  return new Date(dt).toLocaleString('it-IT', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function buildCommessaOptions(projects) {
  return projects
    .filter(p => p.status !== 'archived')
    .map(p => ({
      value: p.id,
      label: p.code ? `${p.code} – ${p.client || p.name}` : (p.client || p.name),
    }));
}

function cleanActionLabel(value) {
  const label = String(value || 'Nota interna');
  const [first, ...rest] = label.split(' ');
  return /[\p{L}\p{N}]/u.test(first) ? label : rest.join(' ');
}

const AVATAR_COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#e11d48', '#0891b2'];

function avatarColor(name) {
  return AVATAR_COLORS[(name || '?').charCodeAt(0) % AVATAR_COLORS.length];
}

function Av({ name, size = 32 }) {
  return (
    <div
      className="ticket-avatar"
      style={{ width: size, height: size, background: avatarColor(name), fontSize: size * 0.38 + 'px' }}
    >
      {(name || '?')[0].toUpperCase()}
    </div>
  );
}

function renderSystemMessage(text) {
  if (text.startsWith('Stato modificato da ')) {
    const match = text.match(/Stato modificato da "(.+)" a "(.+)"/);
    if (match) {
      return (
        <>
          Stato modificato da <span className={`ticket-status-badge ${STATUS_CLASS[match[1]] || ''}`} style={{ display: 'inline-block', margin: '0 4px', fontSize: '0.85em', padding: '2px 6px' }}>{match[1]}</span> a <span className={`ticket-status-badge ${STATUS_CLASS[match[2]] || ''}`} style={{ display: 'inline-block', margin: '0 4px', fontSize: '0.85em', padding: '2px 6px' }}>{match[2]}</span>
        </>
      );
    }
  }
  return text;
}

function renderReplyContent(text) {
  if (!text) return null;
  let content = text;

  const legacyRegex = /_Stato modificato da \*\*(.+?)\*\* a \*\*(.+?)\*\*_/g;
  let hasStatusChange = false;
  let oldStatus = null;
  let newStatus = null;

  let match = legacyRegex.exec(content);
  if (match) {
    hasStatusChange = true;
    oldStatus = match[1];
    newStatus = match[2];
    content = content.replace(legacyRegex, '').trim();
  } else {
    const tokenRegex = /\[STATUS_CHANGE:(.+?)->(.+?)\]/g;
    match = tokenRegex.exec(content);
    if (match) {
      hasStatusChange = true;
      oldStatus = match[1];
      newStatus = match[2];
      content = content.replace(tokenRegex, '').trim();
    }
  }

  return (
    <>
      {content && <div style={{ whiteSpace: 'pre-wrap' }}>{content}</div>}
      {hasStatusChange && (
        <div style={{ marginTop: '8px', fontSize: '0.9em', color: 'var(--text-secondary)' }}>
          Stato modificato da <span className={`ticket-status-badge ${STATUS_CLASS[oldStatus] || ''}`} style={{ display: 'inline-block', margin: '0 4px', fontSize: '0.85em', padding: '2px 6px' }}>{oldStatus}</span> a <span className={`ticket-status-badge ${STATUS_CLASS[newStatus] || ''}`} style={{ display: 'inline-block', margin: '0 4px', fontSize: '0.85em', padding: '2px 6px' }}>{newStatus}</span>
        </div>
      )}
    </>
  );
}

/* ─── Assignee tag input ─── */
function AssigneeInput({ selected, onChange, users }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);

  const filtered = users.filter(u =>
    !selected.includes(u.username) &&
    ((u.full_name || '').toLowerCase().includes(query.toLowerCase()) ||
      u.username.toLowerCase().includes(query.toLowerCase()))
  );

  function add(username) {
    onChange([...selected, username]);
    setQuery('');
    setOpen(false);
    inputRef.current?.focus();
  }

  function remove(username) {
    onChange(selected.filter(u => u !== username));
  }

  return (
    <div className="assignee-tags-box" onClick={() => inputRef.current?.focus()}>
      {selected.map(u => (
        <span key={u} className="assignee-tag">
          {u}
          <button type="button" onClick={() => remove(u)} aria-label={`Rimuovi ${u}`}>
            <AppIcon name="close" size={11} />
          </button>
        </span>
      ))}
      <div className="assignee-input-wrap">
        <input
          ref={inputRef}
          className="assignee-input"
          placeholder={selected.length === 0 ? 'Nessuno (lascia vuoto) o cerca utente...' : 'Aggiungi...'}
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
        {open && filtered.length > 0 && (
          <div className="assignee-dropdown">
            {filtered.map(u => (
              <div key={u.id} className="assignee-dropdown-item" onMouseDown={() => add(u.username)}>
                <div className="assignee-item-avatar">{(u.full_name || u.username)[0].toUpperCase()}</div>
                <div className="assignee-item-info">
                  <div className="assignee-item-name">{u.full_name || u.username}</div>
                  <div className="assignee-item-username">@{u.username}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* --- Observers Modal --- */
function TicketObserversModal({ onClose, users }) {
  const toast = useToast();
  const [observers, setObservers] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/settings/ticket_observers')
      .then(res => setObservers(Array.isArray(res.data) ? res.data : []))
      .catch(() => toast.error('Impossibile caricare gli osservatori'));
  }, [toast]);

  async function handleSave() {
    setSaving(true);
    try {
      await api.post('/settings/ticket_observers', { usernames: observers });
      toast.success('Osservatori aggiornati con successo');
      onClose();
    } catch {
      toast.error('Errore durante il salvataggio');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="tickets-modal-overlay">
      <div className="tickets-modal" style={{ maxWidth: 500 }}>
        <div className="tickets-modal-header">
          <h2 className="tickets-modal-title">Osservatori Globali Ticket</h2>
          <button type="button" className="tickets-modal-close" onClick={onClose} aria-label="Chiudi"><AppIcon name="close" /></button>
        </div>
        <div className="tickets-modal-body">
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 4 }}>
            Gli utenti inseriti qui potranno visualizzare <strong>tutti</strong> i ticket presenti nel sistema,
            anche se non sono responsabili o assegnatari. Gli amministratori hanno già questo permesso.
          </p>
          <div className="tkt-field">
            <label>Osservatori Selezionati</label>
            <AssigneeInput selected={observers} onChange={setObservers} users={users} />
          </div>
          <div className="tkt-modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Annulla</button>
            <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Salvataggio...' : 'Salva modifiche'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── New Ticket Modal ─── */
function NewTicketModal({ onClose, onCreated, projects, users, currentUser }) {
  const [form, setForm] = useState({
    title: '',
    description: '',
    project_id: '',
    custom_project_code: '',
    responsible_id: currentUser?.id || '',
    priority: 'medium',
    assigned_to: [],
    status: 'Da gestire'
  });
  const [saving, setSaving] = useState(false);
  const [files, setFiles] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const toast = useToast();
  const fileRef = useRef(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.title.trim()) { toast.error('Il titolo è obbligatorio'); return; }
    setSaving(true);
    try {
      const { data } = await api.post('/tickets', {
        title: form.title.trim(),
        description: form.description,
        project_id: form.project_id ? form.project_id : null,
        custom_project_code: form.project_id ? null : (form.custom_project_code ? form.custom_project_code.trim() : null),
        responsible_id: form.responsible_id || null,
        priority: form.priority,
        assigned_to: form.assigned_to,
      });
      for (const file of files) {
        const fd = new FormData();
        fd.append('file', file);
        await api.post(`/tickets/${data.id}/attachments`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      }
      toast.success('Ticket creato!');
      onCreated(data.id);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Errore nella creazione del ticket');
    } finally {
      setSaving(false);
    }
  }

  function handleDrag(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }

  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const dropped = Array.from(e.dataTransfer.files);
      setFiles(prev => {
        const seen = new Set(prev.map(f => `${f.name}_${f.size}`));
        const toAdd = dropped.filter(f => !seen.has(`${f.name}_${f.size}`));
        return [...prev, ...toAdd];
      });
    }
  }

  return (
    <div className="tickets-modal-overlay">
      <div className="tickets-modal">
        <div className="tickets-modal-header">
          <div className="tickets-modal-header-left">
            <div className="tickets-modal-icon-badge">
              <Ticket size={22} />
            </div>
            <div>
              <h2 className="tickets-modal-title">Nuovo Ticket</h2>
              <div className="tickets-modal-subtitle">Compila i dati per aprire e assegnare una nuova richiesta</div>
            </div>
          </div>
          <button type="button" className="tickets-modal-close" onClick={onClose} aria-label="Chiudi">
            <AppIcon name="close" size={16} />
          </button>
        </div>
        <form className="tickets-modal-body" onSubmit={handleSubmit}>
          <div className="tkt-field">
            <label className="tkt-label">
              <span>Titolo</span>
              <span className="tkt-required">*</span>
            </label>
            <input
              type="text"
              className="tkt-input"
              placeholder="Descrivi brevemente il problema o l'evento..."
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              autoFocus
            />
          </div>

          <div className="tkt-field">
            <label className="tkt-label">
              <span>Descrizione</span>
              <span className="tkt-optional">(opzionale)</span>
            </label>
            <textarea
              className="tkt-textarea"
              placeholder="Dettagli aggiuntivi, passi per riprodurre il problema, contesto utile..."
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            />
          </div>

          <div className="tkt-field-row">
            <div className="tkt-field">
              <label className="tkt-label">
                <span>Commessa</span>
                <span className="tkt-optional">(opzionale)</span>
              </label>
              <SearchableCombobox
                value={form.project_id || form.custom_project_code || ''}
                onChange={(val, opt) => {
                  if (opt) setForm(f => ({ ...f, project_id: opt.value, custom_project_code: '' }));
                  else setForm(f => ({ ...f, project_id: '', custom_project_code: val }));
                }}
                options={buildCommessaOptions(projects)}
                placeholder="Scrivi per cercare una commessa…"
                allowCustom
              />
            </div>
            <div className="tkt-field">
              <label className="tkt-label">Priorità</label>
              <div className="tkt-select-wrap">
                <select
                  className="tkt-select"
                  value={form.priority}
                  onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                >
                  <option value="low">🟢 Bassa</option>
                  <option value="medium">🟡 Media</option>
                  <option value="high">🔴 Alta</option>
                </select>
                <ChevronDown size={14} className="tkt-select-arrow" />
              </div>
            </div>
          </div>

          <div className="tkt-field-row">
            <div className="tkt-field">
              <label className="tkt-label">Responsabile</label>
              <div className="tkt-select-wrap">
                <select
                  className="tkt-select"
                  value={form.responsible_id}
                  onChange={e => setForm(f => ({ ...f, responsible_id: e.target.value }))}
                >
                  <option value="">— Nessuno —</option>
                  {users.map(u => (
                    <option key={u.id} value={u.id}>{u.full_name || u.username}</option>
                  ))}
                </select>
                <ChevronDown size={14} className="tkt-select-arrow" />
              </div>
            </div>
            <div className="tkt-field">
              <label className="tkt-label">Addetti</label>
              <AssigneeInput
                selected={form.assigned_to}
                onChange={v => setForm(f => ({ ...f, assigned_to: v }))}
                users={users}
                placeholder="Nessuno o cerca utente..."
              />
            </div>
          </div>

          <div className="tkt-field">
            <label className="tkt-label">
              <span>Allegati</span>
              <span className="tkt-optional">(documenti, immagini o log)</span>
            </label>
            <div
              className={`ticket-dropzone ${dragActive ? 'active' : ''}`}
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
              onClick={() => fileRef.current?.click()}
            >
              <div className="ticket-dropzone-icon">
                <CloudUpload size={22} />
              </div>
              <div className="ticket-dropzone-content">
                <span className="ticket-dropzone-title">
                  Trascina qui i file oppure <strong className="ticket-dropzone-link">sfoglia dal computer</strong>
                </span>
                <span className="ticket-dropzone-hint">Supporta qualsiasi formato (immagini, PDF, archivi ZIP, log)</span>
              </div>
              <input
                ref={fileRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={e => {
                  const selected = Array.from(e.target.files || []);
                  setFiles(prev => {
                    const seen = new Set(prev.map(f => `${f.name}_${f.size}`));
                    const toAdd = selected.filter(f => !seen.has(`${f.name}_${f.size}`));
                    return [...prev, ...toAdd];
                  });
                  e.target.value = '';
                }}
              />
            </div>
            {files.length > 0 && (
              <div className="ticket-pending-files">
                {files.map((f, i) => (
                  <span key={i} className="ticket-pending-chip">
                    <AppIcon name="paperclip" size={13} />
                    <span className="ticket-pending-chip-name" title={f.name}>{f.name}</span>
                    <span className="ticket-pending-chip-size">({Math.round(f.size / 1024)} KB)</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFiles(p => p.filter((_, j) => j !== i));
                      }}
                      aria-label="Rimuovi file"
                    >
                      <AppIcon name="close" size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="tkt-modal-footer">
            <button type="button" className="btn btn-ghost btn-md" onClick={onClose}>
              Annulla
            </button>
            <button type="submit" className="btn btn-primary btn-md" disabled={saving} style={{ minWidth: 140 }}>
              {saving ? 'Creazione in corso...' : '+ Crea Ticket'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─── Ticket Calendar Modal ─── */
function TicketCalendarModal({ ticket, onClose, users, currentUser }) {
  const [form, setForm] = useState(() => {
    const defaultShared = new Set();
    defaultShared.add(currentUser.username);
    if (ticket.responsible_id) {
      const resp = users.find(u => String(u.id) === String(ticket.responsible_id));
      if (resp) defaultShared.add(resp.username);
    }
    if (Array.isArray(ticket.assigned_to)) {
      ticket.assigned_to.forEach(u => defaultShared.add(u));
    }

    return {
      date: new Date().toISOString().slice(0, 10),
      time: '09:00',
      shared_with: Array.from(defaultShared)
    };
  });
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const start = new Date(`${form.date}T${form.time}:00`);
      const end = new Date(start.getTime() + 60 * 60 * 1000); // 1 ora di durata default
      await api.post('/calendar/events', {
        title: `Ticket: ${ticket.title}`,
        description: ticket.description || '',
        start_date: start.toISOString(),
        end_date: end.toISOString(),
        is_all_day: false,
        color: '#6366f1', // Indigo
        shared_with: form.shared_with,
        reminder_type: 'none'
      });
      toast.success('Promemoria aggiunto al calendario');
      onClose();
    } catch (err) {
      toast.error('Errore durante la creazione del promemoria');
    } finally {
      setSaving(false);
    }
  }

  function toggleSharedWith(username) {
    setForm(prev => {
      const isSelected = prev.shared_with.includes(username);
      if (isSelected) return { ...prev, shared_with: prev.shared_with.filter(u => u !== username) };
      return { ...prev, shared_with: [...prev.shared_with, username] };
    });
  }

  return (
    <div className="tickets-modal-overlay">
      <div className="tickets-modal" style={{ maxWidth: 600 }}>
        <div className="tickets-modal-header">
          <h2 className="tickets-modal-title">Aggiungi al calendario</h2>
          <button type="button" className="tickets-modal-close" onClick={onClose} aria-label="Chiudi"><AppIcon name="close" /></button>
        </div>
        <form onSubmit={handleSubmit} className="tickets-modal-body">
          <div className="tkt-field-row">
            <div className="tkt-field">
              <label>Data</label>
              <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} required />
            </div>
            <div className="tkt-field">
              <label>Ora</label>
              <input type="time" value={form.time} onChange={e => setForm({ ...form, time: e.target.value })} required />
            </div>
          </div>
          <div className="tkt-field">
            <label>Condividi con (Opzionale)</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
              {users.map(u => {
                const isActive = form.shared_with.includes(u.username);
                return (
                  <label key={u.id} className={`filter-chip ${isActive ? 'active' : ''}`} style={{ '--chip-color': '#1281ffff', margin: 0 }}>
                    <input
                      type="checkbox"
                      checked={isActive}
                      onChange={() => toggleSharedWith(u.username)}
                    />
                    {u.full_name || u.username}
                  </label>
                );
              })}
            </div>
          </div>
          <div className="tkt-modal-footer">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>Annulla</button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
              {saving ? 'Salvataggio...' : 'Aggiungi'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─── Edit Ticket Modal ─── */
function EditTicketModal({ ticket, onClose, onUpdated, projects, users, currentUser }) {
  const [form, setForm] = useState({
    title: ticket.title,
    description: ticket.description || '',
    project_id: ticket.project_id || '',
    custom_project_code: ticket.custom_project_code || '',
    responsible_id: ticket.responsible_id || '',
    priority: ticket.priority,
    assigned_to: ticket.assigned_to || [],
    status: ticket.status,
  });
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.patch(`/tickets/${ticket.id}`, {
        ...form,
        project_id: form.project_id ? form.project_id : null,
        custom_project_code: form.project_id ? null : (form.custom_project_code ? form.custom_project_code.trim() : null),
        responsible_id: form.responsible_id || null
      });
      toast.success('Ticket aggiornato!');
      onUpdated();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Errore aggiornamento');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="tickets-modal-overlay">
      <div className="tickets-modal">
        <div className="tickets-modal-header">
          <div className="tickets-modal-header-left">
            <div className="tickets-modal-icon-badge">
              <Ticket size={22} />
            </div>
            <div>
              <h2 className="tickets-modal-title">Modifica Ticket</h2>
              <div className="tickets-modal-subtitle">Aggiorna le informazioni, lo stato o gli assegnatari del ticket</div>
            </div>
          </div>
          <button type="button" className="tickets-modal-close" onClick={onClose} aria-label="Chiudi">
            <AppIcon name="close" size={16} />
          </button>
        </div>
        <form className="tickets-modal-body" onSubmit={handleSubmit}>
          <div className="tkt-field">
            <label className="tkt-label">
              <span>Titolo</span>
              <span className="tkt-required">*</span>
            </label>
            <input
              type="text"
              className="tkt-input"
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              autoFocus
            />
          </div>
          <div className="tkt-field">
            <label className="tkt-label">
              <span>Descrizione</span>
              <span className="tkt-optional">(opzionale)</span>
            </label>
            <textarea
              className="tkt-textarea"
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            />
          </div>
          <div className="tkt-field-row">
            <div className="tkt-field">
              <label className="tkt-label">
                <span>Commessa</span>
                <span className="tkt-optional">(opzionale)</span>
              </label>
              <SearchableCombobox
                value={form.project_id || form.custom_project_code || ''}
                onChange={(val, opt) => {
                  if (opt) setForm(f => ({ ...f, project_id: opt.value, custom_project_code: '' }));
                  else setForm(f => ({ ...f, project_id: '', custom_project_code: val }));
                }}
                options={buildCommessaOptions(projects)}
                placeholder="Scrivi per cercare una commessa…"
                allowCustom
              />
            </div>
            <div className="tkt-field">
              <label className="tkt-label">Priorità</label>
              <div className="tkt-select-wrap">
                <select
                  className="tkt-select"
                  value={form.priority}
                  onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                >
                  <option value="low">🟢 Bassa</option>
                  <option value="medium">🟡 Media</option>
                  <option value="high">🔴 Alta</option>
                </select>
                <ChevronDown size={14} className="tkt-select-arrow" />
              </div>
            </div>
          </div>
          <div className="tkt-field-row">
            <div className="tkt-field">
              <label className="tkt-label">Responsabile</label>
              <div className="tkt-select-wrap">
                <select
                  className="tkt-select"
                  value={form.responsible_id}
                  onChange={e => setForm(f => ({ ...f, responsible_id: e.target.value }))}
                >
                  <option value="">— Nessuno —</option>
                  {users.map(u => (
                    <option key={u.id} value={u.id}>{u.full_name || u.username}</option>
                  ))}
                </select>
                <ChevronDown size={14} className="tkt-select-arrow" />
              </div>
            </div>
            <div className="tkt-field">
              <label className="tkt-label">Stato</label>
              <div className="tkt-select-wrap">
                <select
                  className="tkt-select"
                  value={form.status}
                  onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                  disabled={ticket.status === 'Completato' && currentUser?.role !== 'admin'}
                >
                  <option value="Da gestire">Da gestire</option>
                  <option value="In attesa del cliente">In attesa del cliente</option>
                  <option value="Completato">Completato</option>
                </select>
                <ChevronDown size={14} className="tkt-select-arrow" />
              </div>
            </div>
          </div>
          <div className="tkt-field">
            <label className="tkt-label">Addetti di riferimento</label>
            <AssigneeInput
              selected={form.assigned_to}
              onChange={v => setForm(f => ({ ...f, assigned_to: v }))}
              users={users}
              placeholder="Cerca operatore..."
            />
          </div>
          <div className="tkt-modal-footer">
            <button type="button" className="btn btn-ghost btn-md" onClick={onClose}>
              Annulla
            </button>
            <button type="submit" className="btn btn-primary btn-md" disabled={saving} style={{ minWidth: 130 }}>
              {!saving && <AppIcon name="save" size={15} />}
              {saving ? 'Salvataggio…' : 'Salva Modifiche'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─── Ticket Detail Panel ─── */
function TicketDetail({ ticket, currentUser, onRefresh, users, projects, phases }) {
  const [replyText, setReplyText] = useState('');
  const [replyActionType, setReplyActionType] = useState(phases?.[0] || '📝 Nota Interna');
  const [replyFiles, setReplyFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [uploadingTicket, setUploadingTicket] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportFormat, setExportFormat] = useState('pdf');
  const [editingReplyId, setEditingReplyId] = useState(null);
  const [editReplyContent, setEditReplyContent] = useState('');
  const [editReplyActionType, setEditReplyActionType] = useState('');
  const [editReplyStatus, setEditReplyStatus] = useState('');
  const toast = useToast();
  const navigate = useNavigate();
  const replyFileRef = useRef(null);
  const ticketFileRef = useRef(null);
  const exportMenuRef = useRef(null);

  const canEdit = currentUser?.role === 'admin' || ticket.author_id === currentUser?.id;
  const isClosed = ticket.status === 'Completato';

  async function sendReply() {
    if (!replyText.trim() && replyFiles.length === 0) return;
    setSending(true);
    try {
      const { data } = await api.post(`/tickets/${ticket.id}/replies`, {
        content: replyText.trim(),
        action_type: replyActionType
      });
      if (replyFiles.length > 0) {
        const lastReply = data.replies[data.replies.length - 1];
        for (const file of replyFiles) {
          const fd = new FormData();
          fd.append('file', file);
          await api.post(`/tickets/${ticket.id}/replies/${lastReply.id}/attachments`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        }
      }
      setReplyText('');
      setReplyActionType(phases?.[0] || '📝 Nota Interna');
      setReplyFiles([]);
      toast.success('Risposta inviata!');
      onRefresh();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Errore nell\'invio della risposta');
    } finally {
      setSending(false);
    }
  }

  async function deleteReply(replyId) {
    if (!window.confirm('Eliminare questa risposta?')) return;
    try {
      await api.delete(`/tickets/${ticket.id}/replies/${replyId}`);
      toast.success('Risposta eliminata');
      onRefresh();
    } catch { toast.error('Errore nell\'eliminazione'); }
  }

  async function saveEditReply() {
    if (!editReplyContent.trim()) return;
    try {
      await api.patch(`/tickets/${ticket.id}/replies/${editingReplyId}`, {
        content: editReplyContent.trim(),
        action_type: editReplyActionType || undefined,
        ticket_status: editReplyStatus || undefined
      });
      toast.success('Messaggio aggiornato');
      setEditingReplyId(null);
      setEditReplyContent('');
      setEditReplyActionType('');
      setEditReplyStatus('');
      onRefresh();
    } catch {
      toast.error('Errore nell\'aggiornamento del messaggio');
    }
  }

  async function changeStatus(newStatus) {
    try {
      await api.patch(`/tickets/${ticket.id}`, { status: newStatus });
      toast.success(`Stato modificato in: ${newStatus}`);
      onRefresh();
    } catch { toast.error('Errore aggiornamento stato'); }
  }

  async function deleteTicket() {
    if (!window.confirm('Spostare questo ticket nel cestino?\nVerrà conservato per 90 giorni prima dell\'eliminazione definitiva.')) return;
    try {
      await api.delete(`/tickets/${ticket.id}`);
      toast.success('Ticket spostato nel cestino');
      onRefresh(true);
    } catch { toast.error('Errore eliminazione'); }
  }


  async function deleteTicketAttachment(index) {
    if (!window.confirm('Eliminare questo allegato?')) return;
    try {
      await api.delete(`/tickets/${ticket.id}/attachments/${index}`);
      toast.success('Allegato eliminato');
      onRefresh();
    } catch { toast.error('Errore durante l\'eliminazione dell\'allegato'); }
  }

  async function deleteReplyAttachment(replyId, index) {
    if (!window.confirm('Eliminare questo allegato?')) return;
    try {
      await api.delete(`/tickets/${ticket.id}/replies/${replyId}/attachments/${index}`);
      toast.success('Allegato eliminato');
      onRefresh();
    } catch { toast.error('Errore durante l\'eliminazione dell\'allegato'); }
  }

  async function handleExportTicket(format) {
    try {
      toast.info(`Generazione ${format.toUpperCase()} in corso...`);
      const res = await api.get(`/tickets/${ticket.id}/export/${format}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `ticket_${ticket.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.${format === 'excel' ? 'xlsx' : 'pdf'}`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setShowExportMenu(false);
    } catch {
      toast.error('Errore durante l\'esportazione del ticket');
    }
  }

  async function uploadTicketFile(files) {
    setUploadingTicket(true);
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.append('file', file);
        await api.post(`/tickets/${ticket.id}/attachments`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      }
      toast.success('Allegato aggiunto!');
      onRefresh();
    } catch { toast.error('Errore upload allegato'); } finally { setUploadingTicket(false); }
  }

  function handleDrag(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }

  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const dropped = Array.from(e.dataTransfer.files);
      setReplyFiles(prev => {
        const seen = new Set(prev.map(f => `${f.name}_${f.size}`));
        const toAdd = dropped.filter(f => !seen.has(`${f.name}_${f.size}`));
        return [...prev, ...toAdd];
      });
    }
  }

  const [showCalendarModal, setShowCalendarModal] = useState(false);
  const ticketAtts = Array.isArray(ticket.attachments) ? ticket.attachments : [];

  return (
    <div className="tickets-detail">
      {showCalendarModal && (
        <TicketCalendarModal
          ticket={ticket}
          currentUser={currentUser}
          onClose={() => setShowCalendarModal(false)}
          users={users}
        />
      )}
      {showEdit && (
        <EditTicketModal
          ticket={ticket}
          currentUser={currentUser}
          onClose={() => setShowEdit(false)}
          onUpdated={onRefresh}
          projects={projects}
          users={users}
        />
      )}

      {/* Header */}
      <div className="ticket-detail-header">
        <div className="ticket-detail-header-top">
          <h2 className="ticket-detail-title">{ticket.title}</h2>
          <div className="ticket-detail-actions">
            {canEdit && (
              <>
                <button className="btn btn-ghost btn-icon" onClick={() => setShowCalendarModal(true)} title="Aggiungi reminder in calendario personale" aria-label="Aggiungi al calendario">
                  <AppIcon name="calendar" size={16} />
                </button>
                <button className="btn btn-ghost btn-icon" onClick={() => setShowEdit(true)} title="Modifica" aria-label="Modifica ticket">
                  <AppIcon name="edit" size={16} />
                </button>
                <div style={{ position: 'relative' }} ref={exportMenuRef}>
                  <button className="btn btn-ghost btn-icon" onClick={() => setShowExportMenu(!showExportMenu)} title="Esporta o analizza" aria-label="Esporta o analizza ticket">
                    <AppIcon name="download" size={16} />
                  </button>
                  {showExportMenu && (
                    <div className="action-popover" style={{
                      position: 'absolute', top: '100%', right: 0, marginTop: 6,
                      background: 'var(--bg-card)', border: '1px solid var(--border-default)',
                      borderRadius: 10, padding: 16, zIndex: 300, minWidth: 260,
                      boxShadow: '0 8px 32px rgba(0,0,0,0.2)', textAlign: 'left', fontWeight: 'normal'
                    }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Formato:
                      </div>
                      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
                        <label style={{
                          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                          padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                          background: exportFormat === 'pdf' ? 'rgba(239, 68, 68, 0.15)' : 'var(--bg-tertiary)',
                          border: exportFormat === 'pdf' ? '2px solid #ef4444' : '1px solid var(--border-default)',
                          color: exportFormat === 'pdf' ? '#ef4444' : 'var(--text-secondary)',
                          transition: 'all 0.2s ease'
                        }}>
                          <input type="radio" name="exportFormat" value="pdf" checked={exportFormat === 'pdf'} onChange={() => setExportFormat('pdf')} style={{ display: 'none' }} />
                          <AppIcon name="download" size={14} /> PDF
                        </label>
                        <label style={{
                          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                          padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                          background: exportFormat === 'excel' ? 'rgba(16, 185, 129, 0.15)' : 'var(--bg-tertiary)',
                          border: exportFormat === 'excel' ? '2px solid #10b981' : '1px solid var(--border-default)',
                          color: exportFormat === 'excel' ? '#10b981' : 'var(--text-secondary)',
                          transition: 'all 0.2s ease'
                        }}>
                          <input type="radio" name="exportFormat" value="excel" checked={exportFormat === 'excel'} onChange={() => setExportFormat('excel')} style={{ display: 'none' }} />
                          <AppIcon name="download" size={14} /> Excel
                        </label>
                      </div>

                      <button
                        className="btn"
                        style={{ width: '100%', marginBottom: 16, background: '#10a37f', color: '#fff', border: 'none', display: 'flex', justifyContent: 'center', gap: 8 }}
                        onClick={() => {
                          const repliesText = (ticket.replies || []).map(r => `- ${r.author_full_name || r.author_username}: ${r.content}`).join('\n');
                          const prompt = `Analizza questo ticket tecnico e forniscimi un riassunto dei punti chiave e delle possibili soluzioni. \n\nTitolo: ${ticket.title}\nDescrizione: ${ticket.description}\nStato: ${ticket.status}\nPriorità: ${ticket.priority}\nCreato da: ${ticket.author_full_name || ticket.author_username}\nResponsabile: ${ticket.responsible_full_name || ticket.responsible_username || 'Nessuno'}\n\nRisposte/Commenti:\n${repliesText}`;
                          window.open(`https://chatgpt.com/?q=${encodeURIComponent(prompt)}`, '_blank');
                          setShowExportMenu(false);
                        }}
                      >
                        <span style={{ fontSize: '1.2em' }}></span>
                        <img src="/chatgpt-logo.png" style={{ width: 16, height: 16, filter: 'brightness(0) invert(1)' }} alt="ChatGPT" />
                        Analizza con ChatGPT
                      </button>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        <button className="btn btn-secondary" onClick={() => setShowExportMenu(false)}>Annulla</button>
                        <button className="btn btn-primary" onClick={() => handleExportTicket(exportFormat)}>
                          Export {exportFormat.toUpperCase()}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={deleteTicket}
                  title="Elimina"
                  aria-label="Elimina ticket"
                  style={{ color: 'var(--danger)' }}
                >
                  <AppIcon name="trash" size={16} />
                </button>
              </>
            )}
          </div>
        </div>

        <div className="ticket-detail-meta">
          {canEdit ? (
            <select
              className={`ticket-status-badge ${STATUS_CLASS[ticket.status] || 'open'}`}
              value={ticket.status}
              onChange={(e) => changeStatus(e.target.value)}
              style={{ cursor: 'pointer', border: 'none', outline: 'none' }}
              disabled={ticket.status === 'Completato' && currentUser?.role !== 'admin'}
            >
              <option value="Da gestire">● Da gestire</option>
              <option value="In attesa del cliente">● In attesa del cliente</option>
              <option value="Completato">● Completato</option>
            </select>
          ) : (
            <span className={`ticket-status-badge ${STATUS_CLASS[ticket.status] || 'open'}`}>
              ● {ticket.status}
            </span>
          )}
          <span className={`ticket-priority-badge ${ticket.priority}`}>
            <span className={`priority-dot ${ticket.priority}`} />
            {PRIORITY_LABEL[ticket.priority]}
          </span>
          {ticket.project_id ? (
            <>
              <span style={{ color: 'var(--border-default)' }}>·</span>
              <button className="ticket-detail-project-link" onClick={() => navigate(`/projects/${ticket.project_id}`)}>
                <AppIcon name="folder" size={14} />
                {ticket.project_code || ticket.project_name}
              </button>
            </>
          ) : ticket.custom_project_code ? (
            <>
              <span style={{ color: 'var(--border-default)' }}>·</span>
              <span className="ticket-detail-meta-item">
                <AppIcon name="folder" size={14} />
                {ticket.custom_project_code}
              </span>
            </>
          ) : null}
          <span style={{ color: 'var(--border-default)' }}>·</span>
          <span className="ticket-detail-meta-item">
            <AppIcon name="user" size={14} />
            Responsabile: {ticket.responsible_full_name || ticket.responsible_username || 'Nessuno'}
          </span>
          <span style={{ color: 'var(--border-default)' }}>·</span>
          <span className="ticket-detail-meta-item">
            <AppIcon name="users" size={14} />
            Addetti: {ticket.assigned_to?.length > 0 ? ticket.assigned_to.join(', ') : 'Nessuno'}
          </span>
          <span style={{ color: 'var(--border-default)' }}>·</span>
          <span className="ticket-detail-meta-item">
            Creazione: {ticket.author_full_name || ticket.author_username} · {fmtDate(ticket.created_at)}
          </span>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="ticket-detail-body">

        {/* Description */}
        <div className="ticket-section">
          <div className="ticket-section-label">Descrizione</div>
          {ticket.description
            ? <div className="ticket-description-text">{ticket.description}</div>
            : <div className="ticket-description-empty">Nessuna descrizione fornita.</div>
          }
        </div>

        {/* Ticket Attachments */}
        {(ticketAtts.length > 0 || canEdit) && (
          <div className="ticket-section" style={{ paddingTop: 12, paddingBottom: 12 }}>
            <div className="ticket-section-label">Allegati ({ticketAtts.length})</div>
            <div className="ticket-attachments-list" style={{ marginBottom: ticketAtts.length > 0 ? 8 : 0 }}>
              {ticketAtts.map((att, i) => (
                <span key={i} className="ticket-attachment-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, paddingRight: currentUser?.role === 'admin' ? 8 : undefined }}>
                  <a href={`${BACKEND_URL}/${att.path}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', color: 'inherit' }}>
                    <AppIcon name="paperclip" size={12} />{att.name}
                  </a>
                  {currentUser?.role === 'admin' && (
                    <button
                      onClick={(e) => { e.preventDefault(); deleteTicketAttachment(i); }}
                      style={{ background: 'transparent', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: 0, fontSize: '1em', display: 'flex', alignItems: 'center' }}
                      title="Elimina allegato"
                      aria-label="Elimina allegato"
                    >
                      <AppIcon name="close" size={13} />
                    </button>
                  )}
                </span>
              ))}
            </div>
            {canEdit && (
              <label className="ticket-upload-label">
                {!uploadingTicket && <AppIcon name="paperclip" size={14} />}
                {uploadingTicket ? 'Caricamento…' : 'Aggiungi allegato'}
                <input ref={ticketFileRef} type="file" multiple style={{ display: 'none' }}
                  onChange={e => { uploadTicketFile(Array.from(e.target.files)); e.target.value = ''; }} />
              </label>
            )}
          </div>
        )}

        {/* Replies */}
        <div className="tickets-replies-section">
          <div className="ticket-section-label" style={{ marginBottom: 12 }}>
            Risposte ({ticket.replies?.length || 0})
          </div>
          {!ticket.replies?.length && (
            <div className="ticket-no-replies">Nessuna risposta ancora</div>
          )}
          {ticket.replies?.map(reply => {
            const ratts = Array.isArray(reply.attachments) ? reply.attachments : [];
            const canDel = currentUser?.role === 'admin';
            return (
              <div key={reply.id} className="ticket-timeline-item">
                <div className="ticket-timeline-marker">
                  <Av name={reply.author_full_name || reply.author_username} size={36} />
                </div>
                <div className="ticket-timeline-content-card">
                  <div className="ticket-timeline-header">
                    <div className="ticket-timeline-author-row">
                      <span className="ticket-timeline-author">{reply.author_full_name || reply.author_username}</span>
                      <span className="ticket-timeline-date">{fmtDateTime(reply.created_at)}</span>
                    </div>
                    <span className="ticket-timeline-badge">
                      {cleanActionLabel(reply.action_type)}
                    </span>
                    {currentUser?.role === 'admin' && (
                      <button className="ticket-timeline-delete" onClick={() => { setEditingReplyId(reply.id); setEditReplyContent(reply.content); setEditReplyActionType(reply.action_type || phases?.[0] || '📝 Nota Interna'); setEditReplyStatus(''); }} aria-label="Modifica risposta" title="Modifica risposta">
                        <AppIcon name="edit" size={14} />
                      </button>
                    )}
                    {canDel && (
                      <button className="ticket-timeline-delete" onClick={() => deleteReply(reply.id)} aria-label="Elimina risposta" title="Elimina risposta">
                        <AppIcon name="trash" size={14} />
                      </button>
                    )}
                  </div>
                  <div className="ticket-timeline-body">
                    {editingReplyId === reply.id ? (
                      <div className="edit-reply-box" style={{ background: 'var(--bg-primary)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-default)' }}>
                        <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                          <select className="input" value={editReplyActionType} onChange={e => setEditReplyActionType(e.target.value)} style={{ padding: '4px 8px' }}>
                            {(phases || []).map(p => <option key={p} value={p}>{cleanActionLabel(p)}</option>)}
                          </select>
                          <select className="input" value={editReplyStatus} onChange={e => setEditReplyStatus(e.target.value)} style={{ padding: '4px 8px' }}>
                            <option value="">-- Non cambiare stato ticket --</option>
                            <option value="Da gestire">Da gestire</option>
                            <option value="In attesa del cliente">In attesa del cliente</option>
                            <option value="Completato">Completato</option>
                          </select>
                        </div>
                        <textarea
                          value={editReplyContent}
                          onChange={e => setEditReplyContent(e.target.value)}
                          className="input"
                          style={{ width: '100%', minHeight: '60px', marginBottom: '8px', fontFamily: 'inherit', resize: 'vertical' }}
                        />
                        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => setEditingReplyId(null)}>Annulla</button>
                          <button className="btn btn-primary btn-sm" onClick={saveEditReply}>Salva</button>
                        </div>
                      </div>
                    ) : (
                      <div className={`ticket-timeline-text ${reply.action_type === '🔄 Cambio Stato' ? 'system-message' : ''}`}>
                        {reply.action_type === '🔄 Cambio Stato' ? renderSystemMessage(reply.content) : renderReplyContent(reply.content)}
                      </div>
                    )}
                    {ratts.length > 0 && (
                      <div className="ticket-attachments-list" style={{ marginTop: 12 }}>
                        {ratts.map((att, i) => (
                          <span key={i} className="ticket-attachment-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, paddingRight: currentUser?.role === 'admin' ? 8 : undefined }}>
                            <a href={`${BACKEND_URL}/${att.path}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', color: 'inherit' }}>
                              <AppIcon name="paperclip" size={12} />{att.name}
                            </a>
                            {currentUser?.role === 'admin' && (
                              <button
                                onClick={(e) => { e.preventDefault(); deleteReplyAttachment(reply.id, i); }}
                                style={{ background: 'transparent', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: 0, fontSize: '1em', display: 'flex', alignItems: 'center' }}
                                title="Elimina allegato"
                                aria-label="Elimina allegato"
                              >
                                <AppIcon name="close" size={13} />
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Reply input */}
      {isClosed ? (
        <div className="ticket-closed-notice">
          <AppIcon name="lock" size={15} />
          Ticket chiuso.{canEdit && ' Puoi riaprirlo per continuare la discussione.'}
        </div>
      ) : (
        <div
          className={`ticket-reply-area ${dragActive ? 'active-dropzone' : ''}`}
          onDragEnter={handleDrag} onDragOver={handleDrag} onDragLeave={handleDrag} onDrop={handleDrop}
        >
          {dragActive && <div className="ticket-drop-overlay">Rilascia per allegare</div>}
          <div className="ticket-reply-top-row">
            <select
              className="ticket-reply-type-select"
              value={replyActionType}
              onChange={e => setReplyActionType(e.target.value)}
            >
              {(phases || []).map(p => (
                <option key={p} value={p}>{cleanActionLabel(p)}</option>
              ))}
            </select>
          </div>
          <div className="ticket-reply-row">
            <Av name={currentUser?.full_name || currentUser?.username} size={36} />
            <textarea
              className="ticket-reply-textarea"
              placeholder="Scrivi i dettagli dell'evento..."
              value={replyText}
              onChange={e => setReplyText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) sendReply(); }}
            />
          </div>
          {replyFiles.length > 0 && (
            <div className="ticket-pending-files" style={{ paddingLeft: 42 }}>
              {replyFiles.map((f, i) => (
                <span key={i} className="ticket-pending-chip">
                  <AppIcon name="paperclip" size={12} />{f.name}
                  <button type="button" onClick={() => setReplyFiles(p => p.filter((_, j) => j !== i))} aria-label="Rimuovi file">
                    <AppIcon name="close" size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="ticket-reply-actions">
            <span className="ticket-reply-hint">Ctrl+Invio per inviare</span>
            <label className="ticket-upload-label" style={{ cursor: 'pointer' }}>
              <AppIcon name="paperclip" size={16} />
              <input ref={replyFileRef} type="file" multiple style={{ display: 'none' }}
                onChange={e => {
                  const selected = Array.from(e.target.files || []);
                  setReplyFiles(prev => {
                    const seen = new Set(prev.map(f => `${f.name}_${f.size}`));
                    const toAdd = selected.filter(f => !seen.has(`${f.name}_${f.size}`));
                    return [...prev, ...toAdd];
                  });
                  e.target.value = '';
                }} />
            </label>
            <button
              className="btn btn-primary btn-sm"
              onClick={sendReply}
              disabled={sending || (!replyText.trim() && replyFiles.length === 0)}
            >
              {!sending && <AppIcon name="mail" size={15} />}
              {sending ? 'Invio…' : 'Invia'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Main Page ─── */
export default function TicketsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const passedProjectId = location.state?.projectId;

  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [showObservers, setShowObservers] = useState(false);
  const [statusFilter, setStatusFilter] = useState('open_all');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [projectFilter, setProjectFilter] = useState(passedProjectId || 'all');
  const [search, setSearch] = useState('');
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [phases, setPhases] = useState([]);

  // Cestino
  const [showTrashModal, setShowTrashModal] = useState(false);
  const [trashTickets, setTrashTickets] = useState([]);
  const [trashLoading, setTrashLoading] = useState(false);

  const canAccessTrash = user?.role === 'admin' || user?.role === 'editor';
  const loadedRef = useRef(false);

  const loadTrash = useCallback(async () => {
    if (!canAccessTrash) return;
    setTrashLoading(true);
    try {
      const { data } = await api.get('/tickets/trash');
      setTrashTickets(Array.isArray(data) ? data : []);
    } catch {
      /* ignore */
    } finally {
      setTrashLoading(false);
    }
  }, [canAccessTrash]);

  useEffect(() => {
    if (loadedRef.current) return; // prevent double-call in StrictMode
    loadedRef.current = true;
    loadAll();
    if (canAccessTrash) {
      loadTrash();
    }
  }, [loadTrash, canAccessTrash]);

  useEffect(() => {
    if (location.state?.projectId) {
      setProjectFilter(location.state.projectId);
    } else {
      setProjectFilter('all');
    }
  }, [location.state?.projectId]);

  useEffect(() => {
    if (tickets.length > 0) {
      const params = new URLSearchParams(location.search);
      const ticketId = params.get('ticketId');
      if (ticketId) {
        setSelectedId(ticketId);
        params.delete('ticketId');
        navigate({ search: params.toString() }, { replace: true });
      }
    }
  }, [location.search, tickets, navigate]);

  async function loadAll() {
    setLoading(true);
    try {
      const [tRes, pRes, phRes] = await Promise.all([
        api.get('/tickets'),
        api.get('/projects'),
        api.get('/settings/ticket_phases')
      ]);
      setTickets(Array.isArray(tRes.data) ? tRes.data : []);
      setProjects(Array.isArray(pRes.data) ? pRes.data : []);
      setPhases(Array.isArray(phRes.data) ? phRes.data : []);
    } catch (err) {
      toast.error('Errore nel caricamento dei ticket. Assicurati che il backend sia aggiornato.');
    } finally {
      setLoading(false);
    }
    // Load users separately — not critical
    try {
      const { data } = await api.get('/users');
      setUsers(Array.isArray(data) ? data : []);
    } catch { /* users not available for this role */ }
  }

  const refreshTickets = useCallback(async (resetSelected = false) => {
    try {
      const { data } = await api.get('/tickets');
      setTickets(Array.isArray(data) ? data : []);
      if (resetSelected) setSelectedId(null);
    } catch { /* ignore */ }
    if (canAccessTrash) {
      loadTrash();
    }
  }, [loadTrash, canAccessTrash]);

  async function handleRestoreTicket(ticket) {
    try {
      await api.post(`/tickets/trash/${ticket.id}/restore`);
      toast.success('Ticket ripristinato con successo');
      await refreshTickets();
      await loadTrash();
    } catch {
      toast.error('Errore durante il ripristino del ticket');
    }
  }

  async function handleHardDeleteTicket(ticket) {
    if (!window.confirm(`Eliminare definitivamente "${ticket.title}"?\nL'operazione è irreversibile.`)) return;
    try {
      await api.delete(`/tickets/trash/${ticket.id}`);
      toast.success('Ticket eliminato definitivamente');
      await loadTrash();
    } catch {
      toast.error('Errore durante l\'eliminazione definitiva');
    }
  }

  async function handleEmptyTrash() {
    if (trashTickets.length === 0) return;
    if (!window.confirm(`Svuotare il cestino dei ticket?\nTutti i ${trashTickets.length} ticket presenti verranno eliminati in modo irreversibile.`)) return;
    try {
      await api.delete('/tickets/trash/empty');
      toast.success('Cestino svuotato');
      await loadTrash();
    } catch {
      toast.error('Errore durante lo svuotamento del cestino');
    }
  }

  const selectedTicket = tickets.find(t => t.id === selectedId) || null;

  const projectFilteredTickets = tickets.filter(t => projectFilter === 'all' || t.project_id === projectFilter);

  const filtered = tickets.filter(t => {
    if (projectFilter !== 'all' && t.project_id !== projectFilter) return false;
    if (statusFilter === 'open_all' && t.status === 'Completato') return false;
    if (statusFilter !== 'open_all' && statusFilter !== 'all' && t.status !== statusFilter) return false;
    if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
    if (search && !t.title.toLowerCase().includes(search.toLowerCase()) && !(t.project_code || '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const baseTickets = projectFilteredTickets.filter(t => {
    if (statusFilter === 'open_all') return t.status !== 'Completato';
    if (statusFilter === 'all') return true;
    return t.status === statusFilter;
  });
  const highCount = baseTickets.filter(t => t.priority === 'high').length;
  const mediumCount = baseTickets.filter(t => t.priority === 'medium').length;
  const lowCount = baseTickets.filter(t => t.priority === 'low').length;

  return (
    <div className="tickets-page-wrapper animate-fadeIn">
      {showNew && (
        <NewTicketModal
          currentUser={user}
          onClose={() => setShowNew(false)}
          onCreated={id => { refreshTickets(); setSelectedId(id); }}
          projects={projects}
          users={users}
        />
      )}
      {showObservers && (
        <TicketObserversModal
          onClose={() => setShowObservers(false)}
          users={users}
        />
      )}

      {/* Body */}
      <div className="tickets-body">
        {/* Sidebar */}
        <aside className="tickets-sidebar">
          <button className="btn btn-primary sidebar-create-btn" onClick={() => setShowNew(true)}>
            <AppIcon name="plus" />
            Nuovo ticket
          </button>

          {user?.role === 'admin' && (
            <button
              className="btn btn-secondary sidebar-create-btn"
              style={{ marginTop: '-4px', fontSize: '0.75rem', padding: '6px' }}
              onClick={() => setShowObservers(true)}
            >
              <AppIcon name="users" size={14} />
              Gestisci Osservatori
            </button>
          )}

          <div className="tickets-sidebar-section-title">Stato</div>
          {[
            { key: 'open_all', icon: 'ticket', label: 'Aperti', count: projectFilteredTickets.filter(t => t.status !== 'Completato').length },
            { key: 'Da gestire', icon: 'clock', label: 'Da gestire', count: projectFilteredTickets.filter(t => t.status === 'Da gestire').length },
            { key: 'In attesa del cliente', icon: 'user', label: 'In attesa cliente', count: projectFilteredTickets.filter(t => t.status === 'In attesa del cliente').length },
            { key: 'Completato', icon: 'check', label: 'Completato', count: projectFilteredTickets.filter(t => t.status === 'Completato').length },
          ].map(f => (
            <button
              key={f.key}
              className={`tickets-filter-btn ${statusFilter === f.key ? 'active' : ''}`}
              onClick={() => setStatusFilter(f.key)}
            >
              <span className="filter-label"><AppIcon name={f.icon} size={16} />{f.label}</span>
              <span className="tickets-filter-count">{f.count}</span>
            </button>
          ))}

          <div className="tickets-sidebar-section-title">Priorità</div>
          {[
            { key: 'all', label: 'Tutte', count: baseTickets.length },
            { key: 'high', label: 'Alta', count: highCount },
            { key: 'medium', label: 'Media', count: mediumCount },
            { key: 'low', label: 'Bassa', count: lowCount },
          ].map(f => (
            <button
              key={f.key}
              className={`tickets-filter-btn ${priorityFilter === f.key ? 'active' : ''}`}
              onClick={() => setPriorityFilter(f.key)}
            >
              <span className="filter-label">
                {f.key === 'all' ? <AppIcon name="list" size={16} /> : <span className={`priority-dot ${f.key}`} />}
                {f.label}
              </span>
              {f.count !== null && <span className="tickets-filter-count">{f.count}</span>}
            </button>
          ))}

          {projectFilter !== 'all' && (
            <>
              <div className="tickets-sidebar-section-title">Filtro Commessa</div>
              <button
                className="tickets-filter-btn active"
                onClick={() => { setProjectFilter('all'); window.history.replaceState({}, ''); }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <AppIcon name="folder" size={14} />
                  {projects.find(p => p.id === projectFilter)?.code || 'Commessa'}
                </span>
                <span className="tickets-filter-count" style={{ cursor: 'pointer' }}><AppIcon name="close" size={12} /></span>
              </button>
            </>
          )}

          {canAccessTrash && (
            <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
              <button
                className="tickets-filter-btn"
                onClick={() => { setShowTrashModal(true); loadTrash(); }}
                title="Cestino Ticket (conservati per 90 giorni)"
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  color: 'var(--text-secondary)'
                }}
              >
                <span className="filter-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <AppIcon name="trash" size={16} /> Cestino
                </span>
                {trashTickets.length > 0 && (
                  <span
                    style={{
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      padding: '1px 6px',
                      borderRadius: 999,
                      background: 'rgba(239, 68, 68, 0.15)',
                      color: 'var(--danger, #ef4444)'
                    }}
                  >
                    {trashTickets.length}
                  </span>
                )}
              </button>
            </div>
          )}
        </aside>

        <div className="tickets-workspace">
          <div className="tickets-main-toolbar">
            <input
              className="tickets-search"
              placeholder="Cerca ticket..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <span className="tickets-results-count">
              {filtered.length} risultat{filtered.length === 1 ? 'o' : 'i'}
            </span>
          </div>

          <div className="tickets-workspace-body">
            {/* Ticket list */}
            <div className="tickets-list-panel">
              <div className="tickets-list">
                {loading ? (
                  <div className="tickets-empty">
                    <div className="tickets-empty-icon"><AppIcon name="clock" size={24} /></div>
                    <div>Caricamento...</div>
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="tickets-empty">
                    <div className="tickets-empty-icon"><AppIcon name="ticket" size={24} /></div>
                    <div>{tickets.length === 0 ? 'Nessun ticket aperto' : 'Nessun risultato'}</div>
                    {tickets.length === 0 && (
                      <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>
                        + Nuovo Ticket
                      </button>
                    )}
                  </div>
                ) : (
                  filtered.map(t => (
                    <div
                      key={t.id}
                      className={`ticket-card ${selectedId === t.id ? 'selected' : ''}`}
                      onClick={() => setSelectedId(t.id)}
                    >
                      <div className="ticket-card-title">{t.title}</div>
                      <div className="ticket-card-badges">
                        <span className={`ticket-status-badge ${STATUS_CLASS[t.status] || 'open'}`}>
                          ● {t.status}
                        </span>
                      </div>
                      {t.project_id ? (
                        <div className="ticket-card-project"><AppIcon name="folder" size={13} />{t.project_code || t.project_name}</div>
                      ) : t.custom_project_code ? (
                        <div className="ticket-card-project"><AppIcon name="folder" size={13} />{t.custom_project_code}</div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Detail */}
            {selectedTicket ? (
              <TicketDetail
                key={selectedTicket.id}
                ticket={selectedTicket}
                currentUser={user}
                onRefresh={(reset) => refreshTickets(reset === true)}
                users={users}
                projects={projects}
                phases={phases}
              />
            ) : (
              <div className="tickets-detail">
                <div className="tickets-detail-placeholder">
                  <div className="tickets-detail-placeholder-icon"><AppIcon name="ticket" size={28} /></div>
                  <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                    Seleziona un ticket dalla lista
                  </div>
                  <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                    oppure crea un nuovo ticket
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>
                    + Nuovo Ticket
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* MODALE CESTINO TICKETS */}
      {showTrashModal && canAccessTrash && (
        <div className="modal-overlay" onClick={() => setShowTrashModal(false)}>
          <div
            className="modal trash-modal animate-scaleIn"
            style={{
              maxWidth: 780,
              width: '94%',
              maxHeight: '85vh',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--bg-card, #ffffff)',
              backgroundColor: 'var(--bg-card, #ffffff)',
              borderRadius: 16,
              padding: '24px',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.35)',
              border: '1px solid var(--border-default)',
              zIndex: 1001,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header del Cestino */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 16, borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 12,
                  background: 'rgba(239, 68, 68, 0.12)', color: 'var(--danger, #ef4444)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
                }}>
                  <AppIcon name="trash" size={24} />
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>Cestino Ticket</h2>
                    <span style={{
                      fontSize: '0.75rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                      background: 'rgba(148, 163, 184, 0.16)', color: 'var(--text-secondary)'
                    }}>
                      {trashTickets.length} {trashTickets.length === 1 ? 'elemento' : 'elementi'}
                    </span>
                  </div>
                  <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: 'var(--text-tertiary)' }}>
                    Gli elementi vengono conservati per 90 giorni prima dell'eliminazione definitiva automatica.
                  </p>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {trashTickets.length > 0 && (
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={handleEmptyTrash}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', padding: '6px 12px' }}
                  >
                    <AppIcon name="trash" size={14} />
                    Svuota Cestino
                  </button>
                )}
                <button
                  type="button"
                  className="btn-ghost btn-icon"
                  onClick={() => setShowTrashModal(false)}
                  aria-label="Chiudi"
                  style={{ width: 34, height: 34, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <AppIcon name="close" size={18} />
                </button>
              </div>
            </div>

            {/* Lista dei Ticket nel Cestino */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 0', minHeight: 220 }}>
              {trashLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '60px 0' }}>
                  <div className="spinner" />
                </div>
              ) : trashTickets.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '50px 20px', color: 'var(--text-tertiary)' }}>
                  <div style={{
                    width: 54, height: 54, borderRadius: '50%',
                    background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center',
                    justifyContent: 'center', margin: '0 auto 16px', color: 'var(--text-muted)'
                  }}>
                    <AppIcon name="trash" size={26} />
                  </div>
                  <h3 style={{ fontSize: '0.98rem', fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 6px' }}>
                    Il cestino è vuoto
                  </h3>
                  <p style={{ fontSize: '0.84rem', margin: 0 }}>
                    Nessun ticket presente nel cestino.
                  </p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {trashTickets.map((t) => (
                    <div
                      key={t.id}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '12px 16px', borderRadius: 10,
                        border: '1px solid var(--border-default)', background: 'var(--bg-card)',
                        gap: 16
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.92rem', marginBottom: 4 }}>
                          {t.title}
                        </div>
                        {t.project_name && (
                          <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: 6 }}>
                            Commessa: {t.project_code || t.project_name}
                          </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                          <span>Creato da: {t.creator_name || 'Utente'}</span>
                          <span>•</span>
                          <span>Eliminato il {t.deleted_at ? new Date(t.deleted_at).toLocaleDateString('it-IT') : 'N/D'}</span>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                        <span
                          style={{
                            fontSize: '0.75rem', fontWeight: 650, padding: '4px 10px', borderRadius: 999,
                            background: t.days_left <= 7 ? 'rgba(239, 68, 68, 0.12)' : (t.days_left <= 30 ? 'rgba(245, 158, 11, 0.12)' : 'var(--bg-tertiary)'),
                            color: t.days_left <= 7 ? 'var(--danger, #ef4444)' : (t.days_left <= 30 ? '#d97706' : 'var(--text-secondary)'),
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {t.days_left <= 0 ? 'Eliminazione oggi' : `Tra ${t.days_left} giorni`}
                        </span>

                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleRestoreTicket(t)}
                          title="Ripristina Ticket"
                          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', padding: '6px 12px' }}
                        >
                          <AppIcon name="undo" size={14} />
                          Ripristina
                        </button>

                        <button
                          className="btn btn-icon btn-sm"
                          onClick={() => handleHardDeleteTicket(t)}
                          title="Elimina definitivamente"
                          style={{ color: 'var(--danger, #ef4444)', borderColor: 'rgba(239, 68, 68, 0.3)' }}
                        >
                          <AppIcon name="trash" size={14} />
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
    </div>
  );
}
