import { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import AppIcon from '../components/ui/AppIcon';
import AssigneeInput from '../components/ui/AssigneeInput';
import { CheckSquare, CloudUpload } from 'lucide-react';
import './TodoPage.css';

const BACKEND_URL = import.meta.env.VITE_API_URL
  ? import.meta.env.VITE_API_URL.replace(/\/api\/?$/, '')
  : `http://${window.location.hostname}:8000`;

function formatDate(dateStr) {
  if (!dateStr) return null;
  const d = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr + 'T00:00:00');
  return d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');
}

function getDueDaysLeft(dateStr) {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr + 'T00:00:00');
  due.setHours(0, 0, 0, 0);
  return Math.ceil((due - today) / 86400000);
}

export default function TodoPage() {
  const { user } = useAuth();
  const toast = useToast();

  const [todos, setTodos] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('open');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);

  const [showModal, setShowModal] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Cestino
  const [showTrashModal, setShowTrashModal] = useState(false);
  const [trashTodos, setTrashTodos] = useState([]);
  const [trashLoading, setTrashLoading] = useState(false);

  const fileInputRef = useRef(null);
  const modalFileRef = useRef(null);
  const dropZoneRef = useRef(null);

  // Pending attachments in modal (uploaded after creation)
  const [pendingFiles, setPendingFiles] = useState([]);

  const emptyForm = {
    title: '',
    content: '',
    notify_date: '',
    due_date: '',
    assignees: [],
    notify_email: true,
  };
  const [form, setForm] = useState(emptyForm);

  const location = useLocation();
  const navigate = useNavigate();

  const canAccessTrash = user?.role === 'admin' || user?.role === 'editor';

  useEffect(() => {
    loadTodos();
    loadUsers();
    if (canAccessTrash) {
      loadTrash();
    }
  }, [canAccessTrash]);

  async function loadTrash() {
    if (!canAccessTrash) return;
    setTrashLoading(true);
    try {
      const { data } = await api.get('/todos/trash');
      setTrashTodos(Array.isArray(data) ? data : []);
    } catch {
      /* ignore */
    } finally {
      setTrashLoading(false);
    }
  }

  async function handleRestoreTodo(todo) {
    try {
      await api.post(`/todos/trash/${todo.id}/restore`);
      toast.success('TODO ripristinato con successo');
      await loadTodos();
      await loadTrash();
    } catch {
      toast.error('Errore durante il ripristino del TODO');
    }
  }

  async function handleHardDeleteTodo(todo) {
    if (!window.confirm(`Eliminare definitivamente "${todo.title}"?\nL'operazione è irreversibile.`)) return;
    try {
      await api.delete(`/todos/trash/${todo.id}`);
      toast.success('TODO eliminato definitivamente');
      await loadTrash();
    } catch {
      toast.error('Errore durante l\'eliminazione definitiva');
    }
  }

  async function handleEmptyTrash() {
    if (trashTodos.length === 0) return;
    if (!window.confirm(`Svuotare il cestino dei TODO?\nTutti i ${trashTodos.length} TODO presenti verranno eliminati in modo irreversibile.`)) return;
    try {
      await api.delete('/todos/trash/empty');
      toast.success('Cestino svuotato');
      await loadTrash();
    } catch {
      toast.error('Errore durante lo svuotamento del cestino');
    }
  }


  useEffect(() => {
    if (todos.length > 0) {
      const params = new URLSearchParams(location.search);
      const todoId = params.get('todoId');
      if (todoId) {
        const targetTodo = todos.find(t => String(t.id) === todoId);
        if (targetTodo) {
          setSelected(targetTodo);
          openEdit(targetTodo);
          if (targetTodo.is_completed) {
            setFilter('completed');
          } else {
            setFilter('open');
          }
        }
        params.delete('todoId');
        navigate({ search: params.toString() }, { replace: true });
      }
    }
  }, [location.search, todos, navigate]);

  async function loadTodos() {
    setLoading(true);
    try {
      const { data } = await api.get('/todos');
      setTodos(data);
      if (selected) {
        const refreshed = data.find(t => t.id === selected.id);
        setSelected(refreshed || null);
      }
    } catch {
      toast.error('Errore nel caricamento dei TODO');
    } finally {
      setLoading(false);
    }
  }

  async function loadUsers() {
    try {
      const { data } = await api.get('/users');
      setAllUsers(data);
    } catch { /* ignore */ }
  }

  // Sorted users: current user first, then alphabetical by full_name/username
  const sortedUsers = [...allUsers].sort((a, b) => {
    if (a.id === user?.id) return -1;
    if (b.id === user?.id) return 1;
    const nameA = (a.full_name || a.username).toLowerCase();
    const nameB = (b.full_name || b.username).toLowerCase();
    return nameA.localeCompare(nameB);
  });

  // ---- Filtering ----
  const filtered = todos.filter(t => {
    if (filter === 'mine' && t.creator_id !== user?.id) return false;
    if (filter === 'assigned' && !t.assignees.includes(user?.id)) return false;
    if (filter === 'open' && t.is_completed) return false;
    if (filter === 'completed' && !t.is_completed) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!t.title.toLowerCase().includes(q) && !(t.content || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // ---- Create / Edit ----
  function openCreate() {
    loadUsers();
    setEditMode(false);
    setPendingFiles([]);
    setForm({ ...emptyForm, assignees: [user?.id] });
    setShowModal(true);
  }

  function openEdit(todo) {
    loadUsers();
    setEditMode(true);
    setPendingFiles([]);
    setForm({
      title: todo.title || '',
      content: todo.content || '',
      notify_date: todo.notify_date || '',
      due_date: todo.due_date || '',
      assignees: todo.assignees || [],
      notify_email: todo.notify_email !== undefined ? todo.notify_email : true,
    });
    setSelected(todo);
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setPendingFiles([]);
  }

  async function saveTodo() {
    if (!form.title.trim()) {
      toast.error('Il titolo è obbligatorio');
      return;
    }
    if (!form.assignees || form.assignees.length === 0) {
      toast.error('Il TODO deve avere almeno un addetto assegnato');
      return;
    }
    setSaving(true);
    try {
      let savedTodo;
      const payload = {
        ...form,
        notify_date: form.notify_date || null,
        due_date: form.due_date || null,
        notify_email: !!(form.notify_date || form.due_date),
      };

      if (editMode && selected) {
        const { data } = await api.patch(`/todos/${selected.id}`, payload);
        savedTodo = data;
        toast.success('TODO aggiornato');
        setSelected(data);
      } else {
        const { data } = await api.post('/todos', payload);
        savedTodo = data;
        toast.success('TODO creato');
      }

      // Upload pending files after creation/update
      if (pendingFiles.length > 0 && savedTodo?.id) {
        for (const file of pendingFiles) {
          const fd = new FormData();
          fd.append('file', file);
          try {
            await api.post(`/todos/${savedTodo.id}/attachments`, fd, {
              headers: { 'Content-Type': 'multipart/form-data' },
            });
          } catch {
            toast.error(`Errore caricamento allegato: ${file.name}`);
          }
        }
      }

      closeModal();
      await loadTodos();
    } catch (e) {
      const detail = e?.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : 'Errore nel salvataggio');
    } finally {
      setSaving(false);
    }
  }

  const canEdit = (todo) => user?.id === todo.creator_id || user?.role === 'admin';

  async function toggleComplete(todo, e) {
    e?.stopPropagation();
    if (!canEdit(todo)) {
      toast.error('Solo il creatore può modificare lo stato del TODO');
      return;
    }
    try {
      const { data } = await api.patch(`/todos/${todo.id}`, { is_completed: !todo.is_completed });
      setTodos(prev => prev.map(t => t.id === todo.id ? data : t));
      if (selected?.id === todo.id) setSelected(data);
      toast.success(data.is_completed ? 'TODO completato' : 'TODO riaperto');
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Errore aggiornamento stato');
    }
  }

  async function deleteTodo(todo, e) {
    e?.stopPropagation();
    if (!confirm(`Spostare "${todo.title}" nel cestino?\nVerrà conservato per 90 giorni prima dell'eliminazione definitiva.`)) return;
    try {
      await api.delete(`/todos/${todo.id}`);
      toast.success('TODO spostato nel cestino');
      if (selected?.id === todo.id) setSelected(null);
      setTodos(prev => prev.filter(t => t.id !== todo.id));
      if (canAccessTrash) {
        loadTrash();
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Errore eliminazione');
    }
  }


  async function uploadAttachment(file, todoId) {
    const fd = new FormData();
    fd.append('file', file);
    try {
      await api.post(`/todos/${todoId}/attachments`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('Allegato caricato');
      await loadTodos();
    } catch {
      toast.error('Errore caricamento allegato');
    }
  }

  async function removeAttachment(filename, e) {
    e?.stopPropagation();
    try {
      await api.delete(`/todos/${selected.id}/attachments/${encodeURIComponent(filename)}`);
      toast.success('Allegato rimosso');
      await loadTodos();
    } catch {
      toast.error('Errore rimozione allegato');
    }
  }

  // Pending files management in modal
  function addPendingFile(file) {
    if (!file) return;
    setPendingFiles(prev => {
      if (prev.some(f => f.name === file.name && f.size === file.size)) {
        return prev;
      }
      return [...prev, file];
    });
  }

  function removePendingFile(idx) {
    setPendingFiles(prev => prev.filter((_, i) => i !== idx));
  }

  function toggleAssignee(uid) {
    setForm(prev => {
      const already = prev.assignees.includes(uid);
      return {
        ...prev,
        assignees: already
          ? prev.assignees.filter(id => id !== uid)
          : [...prev.assignees, uid],
      };
    });
  }

  // Drag & drop in modal
  function handleModalDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    files.forEach(addPendingFile);
  }

  // Drag & drop on detail panel
  function handleDetailDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!selected) return;
    const files = Array.from(e.dataTransfer.files || []);
    const seen = new Set();
    const uniqueFiles = files.filter(f => {
      const key = `${f.name}_${f.size}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    uniqueFiles.forEach(f => uploadAttachment(f, selected.id));
  }

  const canDelete = (todo) => user?.id === todo.creator_id || user?.role === 'admin';

  const openCount = todos.filter(t => !t.is_completed).length;
  const completedCount = todos.filter(t => t.is_completed).length;

  return (
    <div className="todo-page-wrapper animate-fadeIn">
      <div className="todo-body">
        {/* Sidebar Filters */}
        <aside className="todo-sidebar">
          <button className="btn btn-primary sidebar-create-btn" onClick={openCreate}>
            <AppIcon name="plus" />
            Nuovo TODO
          </button>
          <span className="todo-sidebar-section-title">Vista</span>
          {[
            { key: 'all', icon: 'list', label: 'Tutti', count: todos.length },
            { key: 'open', icon: 'clock', label: 'Aperti', count: openCount },
            { key: 'completed', icon: 'check', label: 'Completati', count: completedCount },
          ].map(f => (
            <button
              key={f.key}
              className={`todo-filter-btn ${filter === f.key ? 'active' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              <span className="filter-label"><AppIcon name={f.icon} size={16} />{f.label}</span>
              <span style={{ marginLeft: 'auto', fontSize: '0.72rem', opacity: 0.7 }}>{f.count}</span>
            </button>
          ))}

          <span className="todo-sidebar-section-title" style={{ marginTop: 16 }}>Ruolo</span>
          {[
            { key: 'mine', icon: 'user', label: 'Creati da me' },
            { key: 'assigned', icon: 'users', label: 'Assegnati a me' },
          ].map(f => (
            <button
              key={f.key}
              className={`todo-filter-btn ${filter === f.key ? 'active' : ''}`}
              onClick={() => setFilter(prev => prev === f.key ? 'all' : f.key)}
            >
              <span className="filter-label"><AppIcon name={f.icon} size={16} />{f.label}</span>
            </button>
          ))}

          {canAccessTrash && (
            <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
              <button
                className="todo-filter-btn"
                onClick={() => { setShowTrashModal(true); loadTrash(); }}
                title="Cestino TODO (conservati per 90 giorni)"
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
                {trashTodos.length > 0 && (
                  <span
                    style={{
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      padding: '2px 7px',
                      borderRadius: 999,
                      background: 'rgba(239, 68, 68, 0.12)',
                      color: 'var(--danger, #ef4444)'
                    }}
                  >
                    {trashTodos.length}
                  </span>
                )}
              </button>
            </div>
          )}
        </aside>


        {/* Main */}
        <div className="todo-main">
          <div className="todo-main-toolbar">
            <input
              className="todo-search"
              type="text"
              placeholder="Cerca TODO..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              {filtered.length} risultat{filtered.length === 1 ? 'o' : 'i'}
            </span>
          </div>

          <div className="todo-list">
            {loading && (
              <div className="todo-empty">
                <div className="spinner" />
                <p>Caricamento...</p>
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="todo-empty">
                <div className="todo-empty-icon"><AppIcon name="todo" size={28} /></div>
                <p>Nessun TODO trovato</p>
                <button className="btn btn-primary btn-sm" onClick={openCreate}>
                  Crea il primo TODO
                </button>
              </div>
            )}
            {!loading && filtered.map(todo => {
              const daysLeft = getDueDaysLeft(todo.due_date);
              const isOverdue = daysLeft !== null && daysLeft < 0 && !todo.is_completed;
              const isWarning = daysLeft !== null && daysLeft >= 0 && daysLeft <= 1 && !todo.is_completed;

              return (
                <div
                  key={todo.id}
                  className={`todo-card ${todo.is_completed ? 'completed' : ''} ${selected?.id === todo.id ? 'selected' : ''}`}
                  onClick={() => setSelected(prev => prev?.id === todo.id ? null : todo)}
                >
                  <button
                    className={`todo-card-checkbox ${todo.is_completed ? 'checked' : ''}`}
                    onClick={e => toggleComplete(todo, e)}
                    title={todo.is_completed ? 'Segna come aperto' : 'Segna come completato'}
                  >
                    {todo.is_completed && '✓'}
                  </button>

                  <div className="todo-card-body" style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                    <div className="todo-card-title" style={{ margin: 0, flex: 1 }}>{todo.title}</div>
                    <div className="todo-card-meta" style={{ marginTop: 0, flexShrink: 0 }}>
                      {todo.due_date && (
                        <span className={`todo-meta-badge due-badge ${isOverdue || isWarning ? 'due-warning' : ''}`}>
                          {isOverdue || isWarning
                            ? <AppIcon name="alert" size={14} />
                            : <AppIcon name="calendar" size={14} />}
                          {formatDate(todo.due_date)}
                          {daysLeft !== null && !todo.is_completed && (
                            daysLeft === 0 ? ' · Oggi!' :
                              daysLeft === 1 ? ' · Domani' :
                                daysLeft < 0 ? ` · ${Math.abs(daysLeft)}g scaduto` :
                                  ` · ${daysLeft}g`
                          )}
                        </span>
                      )}
                      {todo.notify_date && (
                        <span className="todo-meta-badge notify-badge">
                          <AppIcon name="bell" size={14} />
                          {formatDate(todo.notify_date)}
                        </span>
                      )}
                      {todo.notify_email && (
                        <span className="todo-meta-badge email-badge"><AppIcon name="mail" size={14} /> Mail</span>
                      )}
                      {todo.assignees_detail?.length > 0 && (
                        <span className="todo-meta-badge assignee-badge">
                          <AppIcon name="users" size={14} />
                          {todo.assignees_detail.length}
                        </span>
                      )}
                      {todo.attachments?.length > 0 && (
                        <span className="todo-meta-badge assignee-badge">
                          <AppIcon name="paperclip" size={14} />
                          {todo.attachments.length}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="todo-card-actions">
                    {canEdit(todo) && (
                      <button
                        className="todo-card-btn"
                        onClick={e => { e.stopPropagation(); openEdit(todo); }}
                        title="Modifica"
                      ><AppIcon name="edit" size={15} /></button>
                    )}
                    {canDelete(todo) && (
                      <button
                        className="todo-card-btn delete"
                        onClick={e => deleteTodo(todo, e)}
                        title="Elimina"
                      ><AppIcon name="trash" size={15} /></button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Detail Panel */}
        {selected && (
          <div
            className="todo-detail-panel"
            onDragOver={e => e.preventDefault()}
            onDrop={handleDetailDrop}
          >
            <div className="todo-detail-header">
              <h3 className="todo-detail-title">{selected.title}</h3>
              <button
                className={`todo-status-toggle ${selected.is_completed ? 'completed' : 'open'}`}
                onClick={e => toggleComplete(selected, e)}
              >
                <span className={`status-dot ${selected.is_completed ? 'completed' : 'open'}`} />
                {selected.is_completed ? 'Completato' : 'Aperto'}
              </button>
            </div>
            <div className="todo-detail-body">
              {selected.content && (
                <div>
                  <div className="todo-detail-section-label"><AppIcon name="notes" size={13} />Contenuto</div>
                  <div className="todo-detail-content">{selected.content}</div>
                </div>
              )}

              <div>
                <div className="todo-detail-section-label"><AppIcon name="calendar" size={13} />Date</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {selected.notify_date && (
                    <span className="todo-detail-date-row">
                      <AppIcon name="bell" size={13} /> Data notifica: <strong>{formatDate(selected.notify_date)}</strong>
                    </span>
                  )}
                  {selected.due_date && (
                    <span className="todo-detail-date-row">
                      <AppIcon name="calendar" size={13} /> Scadenza: <strong>{formatDate(selected.due_date)}</strong>
                    </span>
                  )}
                  {!selected.notify_date && !selected.due_date && (
                    <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>Nessuna data</span>
                  )}
                </div>
              </div>

              <div>
                <div className="todo-detail-section-label"><AppIcon name="users" size={13} />Assegnati</div>
                <div className="todo-detail-assignee-chips">
                  {(selected.assignees_detail || []).map(a => (
                    <span key={a.id} className="todo-detail-assignee-chip">
                      <span style={{
                        width: 20, height: 20, borderRadius: '50%',
                        background: 'var(--accent-500, #185FA5)', color: 'white',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '0.65rem', fontWeight: 700, flexShrink: 0
                      }}>
                        {a.username?.[0]?.toUpperCase()}
                      </span>
                      {a.full_name || a.username}
                      {a.id === selected.creator_id && <span className="todo-creator-label">Creatore</span>}
                    </span>
                  ))}
                </div>
              </div>

              {selected.notify_email && (
                <div>
                  <div className="todo-detail-section-label"><AppIcon name="mail" size={13} />Notifiche email</div>
                  <div className="todo-detail-section-value" style={{ fontSize: '0.82rem', color: '#10b981' }}>
                    Notifiche email attive — le notifiche di base (notifica e scadenza) verranno inviate anche via email.
                  </div>
                </div>
              )}

              <div>
                <div className="todo-detail-section-label"><AppIcon name="paperclip" size={13} />Allegati</div>
                {(selected.attachments || []).length === 0 && (
                  <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                    <p>Nessun allegato. Trascina qui i file o usa il pulsante</p>
                  </span>
                )}
                <div className="todo-attachment-list">
                  {(selected.attachments || []).map(att => (
                    <div key={att.filename} className="todo-attachment-item">
                      <a
                        className="todo-attachment-name"
                        href={`${BACKEND_URL}${att.url}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={e => e.stopPropagation()}
                      >
                        <AppIcon name="paperclip" size={13} />{att.filename}
                      </a>
                      {canDelete(selected) && (
                        <button
                          className="todo-attachment-del"
                          onClick={e => removeAttachment(att.filename, e)}
                          aria-label="Rimuovi allegato"
                        ><AppIcon name="close" size={13} /></button>
                      )}
                    </div>
                  ))}
                </div>
                {canEdit(selected) && (
                  <>
                    <input
                      type="file"
                      ref={fileInputRef}
                      style={{ display: 'none' }}
                      onChange={e => { if (e.target.files[0]) uploadAttachment(e.target.files[0], selected.id); e.target.value = ''; }}
                    />
                    <button
                      className="todo-upload-btn"
                      style={{ marginTop: 8 }}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      + Aggiungi allegato (o trascina qui)
                    </button>
                  </>
                )}
              </div>

              <div style={{ marginTop: 'auto', paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Creato da <strong>{selected.creator_full_name || selected.creator_username}</strong>
                  {selected.created_at && ` · ${new Date(selected.created_at).toLocaleDateString('it-IT')}`}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Create / Edit Modal */}
      {showModal && (
        <div className="todo-modal-overlay">
          <div
            className={`todo-modal ${dragOver ? 'drag-over' : ''}`}
            onClick={e => e.stopPropagation()}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => {
              e.preventDefault();
              e.stopPropagation();
              setDragOver(false);
              Array.from(e.dataTransfer.files || []).forEach(addPendingFile);
            }}
          >
            <div className="todo-modal-header">
              <div className="todo-modal-header-left">
                <div className="todo-modal-icon-badge">
                  <CheckSquare size={22} />
                </div>
                <div>
                  <h2 className="todo-modal-title">{editMode ? 'Modifica TODO' : 'Nuovo TODO'}</h2>
                  <div className="todo-modal-subtitle">
                    {editMode ? 'Aggiorna i dettagli dell\'attività e gli assegnatari' : 'Compila i dati per creare e assegnare una nuova attività'}
                  </div>
                </div>
              </div>
              <button type="button" className="todo-modal-close" onClick={closeModal} aria-label="Chiudi">
                <AppIcon name="close" size={16} />
              </button>
            </div>

            <form
              className="todo-modal-body"
              onSubmit={e => {
                e.preventDefault();
                saveTodo();
              }}
            >
              {/* Titolo */}
              <div className="todo-field">
                <label className="todo-label">
                  <span>Titolo</span>
                  <span className="todo-required">*</span>
                </label>
                <input
                  type="text"
                  className="todo-input"
                  placeholder="Descrivi brevemente il TODO..."
                  value={form.title}
                  onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
                  autoFocus
                />
              </div>

              {/* Descrizione */}
              <div className="todo-field">
                <label className="todo-label">
                  <span>Descrizione</span>
                  <span className="todo-optional">(opzionale)</span>
                </label>
                <textarea
                  className="todo-textarea"
                  placeholder="Dettagli aggiuntivi, link, istruzioni, contesto utile..."
                  value={form.content}
                  onChange={e => setForm(p => ({ ...p, content: e.target.value }))}
                />
              </div>

              {/* Allegati */}
              <div className="todo-field">
                <label className="todo-label">
                  <span>Allegati</span>
                  <span className="todo-optional">(documenti, immagini o log)</span>
                </label>
                <div
                  ref={dropZoneRef}
                  className={`todo-dropzone ${dragOver ? 'active' : ''}`}
                  onDragEnter={e => { e.preventDefault(); setDragOver(true); }}
                  onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={e => {
                    if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false);
                  }}
                  onDrop={handleModalDrop}
                  onClick={() => modalFileRef.current?.click()}
                >
                  <div className="todo-dropzone-icon">
                    <CloudUpload size={22} />
                  </div>
                  <div className="todo-dropzone-content">
                    <span className="todo-dropzone-title">
                      Trascina qui i file oppure <strong className="todo-dropzone-link">sfoglia dal computer</strong>
                    </span>
                    <span className="todo-dropzone-hint">Supporta qualsiasi formato (immagini, PDF, archivi ZIP, log)</span>
                  </div>
                  <input
                    type="file"
                    ref={modalFileRef}
                    style={{ display: 'none' }}
                    multiple
                    onChange={e => {
                      Array.from(e.target.files || []).forEach(addPendingFile);
                      e.target.value = '';
                    }}
                  />
                </div>
                {pendingFiles.length > 0 && (
                  <div className="todo-pending-files">
                    {pendingFiles.map((f, i) => (
                      <span key={i} className="todo-pending-chip">
                        <AppIcon name="paperclip" size={13} />
                        <span className="todo-pending-chip-name" title={f.name}>{f.name}</span>
                        <span className="todo-pending-chip-size">({Math.round(f.size / 1024)} KB)</span>
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            removePendingFile(i);
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

              {/* Date */}
              <div className="todo-field-row">
                <div className="todo-field">
                  <label className="todo-label">
                    <span>Data e ora notifica</span>
                    <span className="todo-optional">(opzionale)</span>
                  </label>
                  <input
                    className="todo-input"
                    type="datetime-local"
                    value={form.notify_date ? form.notify_date.substring(0, 16) : ''}
                    onChange={e => {
                      let v = e.target.value;
                      if (v && !form.notify_date && v.endsWith('00:00')) {
                        v = v.replace('00:00', '08:00');
                      }
                      setForm(p => ({ ...p, notify_date: v }));
                    }}
                  />
                </div>
                <div className="todo-field">
                  <label className="todo-label">
                    <span>Data e ora scadenza</span>
                    <span className="todo-optional">(opzionale)</span>
                  </label>
                  <input
                    className="todo-input"
                    type="datetime-local"
                    value={form.due_date ? form.due_date.substring(0, 16) : ''}
                    onChange={e => {
                      let v = e.target.value;
                      if (v && !form.due_date && v.endsWith('00:00')) {
                        v = v.replace('00:00', '18:00');
                      }
                      setForm(p => ({ ...p, due_date: v }));
                    }}
                  />
                </div>
              </div>

              {/* Assegnati */}
              <div className="todo-field">
                <label className="todo-label">
                  <span>Assegnati</span>
                  <span className="todo-required">*</span>
                  <span className="todo-optional">({form.assignees.length})</span>
                </label>
                <AssigneeInput
                  selected={form.assignees}
                  onChange={newAssignees => setForm(f => ({ ...f, assignees: newAssignees }))}
                  users={sortedUsers}
                  valueKey="id"
                  placeholder="Nessuno (lascia vuoto) o cerca utente..."
                  direction="up"
                />
              </div>

              <div className="todo-modal-footer">
                <button type="button" className="btn btn-ghost btn-md" onClick={closeModal}>
                  Annulla
                </button>
                <button
                  type="submit"
                  className="btn btn-primary btn-md"
                  disabled={saving}
                  style={{ minWidth: 140 }}
                >
                  {saving ? 'Salvataggio...' : editMode ? 'Salva modifiche' : '+ Crea TODO'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODALE CESTINO TODO */}
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
                    <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>Cestino TODO</h2>
                    <span style={{
                      fontSize: '0.75rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                      background: 'rgba(148, 163, 184, 0.16)', color: 'var(--text-secondary)'
                    }}>
                      {trashTodos.length} {trashTodos.length === 1 ? 'elemento' : 'elementi'}
                    </span>
                  </div>
                  <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: 'var(--text-tertiary)' }}>
                    Gli elementi vengono conservati per 90 giorni prima dell'eliminazione definitiva automatica.
                  </p>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {trashTodos.length > 0 && (
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

            {/* Lista dei TODO nel Cestino */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 0', minHeight: 220 }}>
              {trashLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '60px 0' }}>
                  <div className="spinner" />
                </div>
              ) : trashTodos.length === 0 ? (
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
                    Nessun TODO presente nel cestino.
                  </p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {trashTodos.map((t) => (
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
                        {t.content && (
                          <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {t.content}
                          </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                          <span>Creato da: {t.creator_full_name || t.creator_username || 'Utente'}</span>
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
                          onClick={() => handleRestoreTodo(t)}
                          title="Ripristina TODO"
                          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', padding: '6px 12px' }}
                        >
                          <AppIcon name="undo" size={14} />
                          Ripristina
                        </button>

                        <button
                          className="btn btn-icon btn-sm"
                          onClick={() => handleHardDeleteTodo(t)}
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

