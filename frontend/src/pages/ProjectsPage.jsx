import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import AppIcon from '../components/ui/AppIcon';
import './ProjectsPage.css';
import { STATUS_LABELS_IT, STATUS_OPTIONS } from '../utils/statusLabels';

const PROJECT_COLOR_PALETTE = [
  '#185FA5', // Blu HiWay
  '#0ea5e9', // Sky Blue
  '#6366f1', // Indigo
  '#8b5cf6', // Violet
  '#ec4899', // Pink
  '#f43f5e', // Rose
  '#f97316', // Orange
  '#10b981', // Emerald
  '#14b8a6', // Teal
  '#06b6d4', // Cyan
  '#3b82f6', // Bright Blue
  '#eab308', // Amber
  '#d97706', // Warm Amber
  '#84cc16', // Lime
  '#a855f7', // Purple
];

let lastColorIndex = -1;
function getNextProjectColor() {
  lastColorIndex = (lastColorIndex + 1) % PROJECT_COLOR_PALETTE.length;
  return PROJECT_COLOR_PALETTE[lastColorIndex];
}

export default function ProjectsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const canCreate = user?.role === 'admin' || user?.role === 'editor';
  const [projects, setProjects] = useState([]);
  const [usersList, setUsersList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingProject, setEditingProject] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', code: '', client: '', color: '#185FA5', description: '', start_date: '', end_date: '', responsible_id: '', assigned_workers: [], status: 'planning', is_atex: false, is_alimentare: false });
  const [filter, setFilter] = useState(() => {
    return (user?.role === 'admin' || user?.role === 'editor') ? 'all' : 'my_projects';
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [form, setForm] = useState({ name: '', code: '', client: '', color: '#185FA5', status: 'planning', description: '', start_date: '', end_date: '', responsible_id: '', assigned_workers: [], is_atex: false, is_alimentare: false });
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportFormat, setExportFormat] = useState('pdf');
  const exportMenuRef = useRef(null);
  const [sortConfig, setSortConfig] = useState({ key: 'none', direction: 'asc' });
  const [showSortMenu, setShowSortMenu] = useState(false);
  const sortMenuRef = useRef(null);
  const [viewMode, setViewMode] = useState(() => {
    try {
      return localStorage.getItem('projects_view_mode') || 'grid';
    } catch {
      return 'grid';
    }
  });

  const handleSort = (key) => {
    setSortConfig(prev => {
      if (prev.key === key) {
        return { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { key, direction: 'asc' };
    });
  };

  // Stato Cestino
  const [showTrashModal, setShowTrashModal] = useState(false);
  const [trashProjects, setTrashProjects] = useState([]);
  const [trashLoading, setTrashLoading] = useState(false);

  useEffect(() => {
    if (user?.role === 'admin' || user?.role === 'editor') {
      setFilter('all');
    }
  }, [user?.role]);

  function openCreateModal() {
    setForm({
      name: '',
      code: '',
      client: '',
      color: getNextProjectColor(),
      status: 'planning',
      description: '',
      start_date: '',
      end_date: '',
      responsible_id: '',
      assigned_workers: [],
      is_atex: false,
      is_alimentare: false
    });
    setShowModal(true);
  }

  useEffect(() => {
    function handleClickOutside(e) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target)) {
        setShowExportMenu(false);
      }
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target)) {
        setShowSortMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    loadProjects();
    loadUsers();
    if (canCreate) {
      loadTrash();
    }
  }, [canCreate]);

  async function loadTrash() {
    if (!canCreate) return;
    setTrashLoading(true);
    try {
      const { data } = await api.get('/projects/trash');
      setTrashProjects(Array.isArray(data) ? data : []);
    } catch {
      // ignore
    } finally {
      setTrashLoading(false);
    }
  }

  async function loadUsers() {
    try {
      const { data } = await api.get('/users');
      if (Array.isArray(data)) setUsersList(data);
    } catch { }
  }

  async function loadProjects() {
    setLoading(true);
    try {
      const { data } = await api.get('/projects');
      setProjects(data);
    } catch { toast.error('Errore nel caricamento progetti'); }
    finally { setLoading(false); }
  }

  async function handleCreate(e) {
    e.preventDefault();
    const finalCode = form.code?.trim();
    const finalClient = form.client?.trim();
    const finalName = form.name?.trim() || finalCode;

    if (!finalCode || !finalClient) {
      toast.error('Codice Commessa e Cliente sono campi obbligatori');
      return;
    }
    try {
      await api.post('/projects', {
        ...form,
        code: finalCode,
        client: finalClient,
        name: finalName,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        responsible_id: form.responsible_id || null,
        is_atex: Boolean(form.is_atex),
        is_alimentare: Boolean(form.is_alimentare),
      });
      toast.success('Commessa creata con successo!');
      setShowModal(false);
      loadProjects();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Errore nella creazione');
    }
  }

  async function handleDelete(id, e) {
    e.stopPropagation();
    if (!window.confirm('Vuoi spostare questa commessa nel cestino? Verrà conservata per 90 giorni prima dell\'eliminazione definitiva.')) return;
    try {
      await api.delete(`/projects/${id}`);
      toast.success('Commessa spostata nel cestino');
      loadProjects();
      loadTrash();
    } catch { toast.error('Errore nell\'eliminazione'); }
  }

  async function handleRestoreProject(project) {
    try {
      await api.post(`/projects/trash/${project.id}/restore`);
      toast.success(`Commessa "${project.name}" ripristinata con successo`);
      loadProjects();
      loadTrash();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Errore durante il ripristino');
    }
  }

  async function handleHardDeleteProject(project) {
    if (!window.confirm(`Sei sicuro di voler eliminare DEFINITIVAMENTE la commessa "${project.name}" e tutte le sue fasi collegate?\n\nQuesta operazione è irreversibile.`)) return;
    try {
      await api.delete(`/projects/trash/${project.id}`);
      toast.success(`Commessa "${project.name}" eliminata definitivamente`);
      loadTrash();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Errore durante l\'eliminazione definitiva');
    }
  }

  async function handleEmptyTrash() {
    if (trashProjects.length === 0) return;
    if (!window.confirm(`Sei sicuro di voler svuotare il cestino?\nTutte le ${trashProjects.length} commesse presenti verranno eliminate in modo irreversibile dal database.`)) return;
    try {
      await api.delete('/projects/trash/empty');
      toast.success('Cestino svuotato con successo');
      loadTrash();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Errore durante lo svuotamento del cestino');
    }
  }

  function openEditProject(project, e) {
    e.stopPropagation();
    setEditingProject(project);
    setEditForm({
      name: project.name || '',
      code: project.code || '',
      client: project.client || '',
      color: project.color || '#185FA5',
      description: project.description || '',
      start_date: project.start_date || '',
      end_date: project.end_date || '',
      responsible_id: project.responsible_id || '',
      assigned_workers: Array.isArray(project.assigned_workers) ? [...project.assigned_workers] : [],
      status: project.status || 'planning',
      is_atex: Boolean(project.is_atex),
      is_alimentare: Boolean(project.is_alimentare),
    });
    setShowEditModal(true);
  }

  async function handleEditSubmit(e) {
    e.preventDefault();
    if (!editingProject) return;
    if (!editForm.code?.trim() || !editForm.client?.trim() || !editForm.name?.trim()) {
      toast.error('Codice, Cliente e Titolo Commessa sono campi obbligatori');
      return;
    }
    try {
      const payload = {
        ...editForm,
        code: editForm.code.trim(),
        client: editForm.client.trim(),
        name: editForm.name.trim(),
        is_atex: Boolean(editForm.is_atex),
        is_alimentare: Boolean(editForm.is_alimentare),
      };
      if (payload.start_date === '') payload.start_date = null;
      if (payload.end_date === '') payload.end_date = null;
      if (payload.responsible_id === '') payload.responsible_id = null;

      await api.put(`/projects/${editingProject.id}`, payload);
      toast.success('Commessa modificata con successo!');
      setShowEditModal(false);
      loadProjects();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Errore durante la modifica');
    }
  }


  const statusCounts = useMemo(() => {
    const counts = {
      my_projects: 0,
      all: 0,
      planning: 0,
      active: 0,
      completed: 0,
      archived: 0,
    };
    for (const p of projects) {
      if (p.is_assigned && p.status !== 'archived' && p.status !== 'completed') {
        counts.my_projects++;
      }
      if (p.status !== 'archived') {
        counts.all++;
      }
      if (p.status && counts[p.status] !== undefined) {
        counts[p.status]++;
      }
    }
    return counts;
  }, [projects]);

  const filtered = useMemo(() => {
    let list = projects;
    if (filter === 'my_projects') {
      list = list.filter(p => p.is_assigned && p.status !== 'archived' && p.status !== 'completed');
    } else if (filter === 'all') {
      list = list.filter(p => p.status !== 'archived');
    } else {
      list = list.filter(p => p.status === filter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(p =>
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.code && p.code.toLowerCase().includes(q)) ||
        (p.client && p.client.toLowerCase().includes(q)) ||
        (p.responsible_name && p.responsible_name.toLowerCase().includes(q)) ||
        (p.responsible_username && p.responsible_username.toLowerCase().includes(q))
      );
    }

    if (sortConfig.key !== 'none') {
      list = [...list].sort((a, b) => {
        let valA, valB;
        switch (sortConfig.key) {
          case 'end_date':
            valA = a.end_date ? new Date(a.end_date).getTime() : 0;
            valB = b.end_date ? new Date(b.end_date).getTime() : 0;
            break;
          case 'start_date':
            valA = a.start_date ? new Date(a.start_date).getTime() : 0;
            valB = b.start_date ? new Date(b.start_date).getTime() : 0;
            break;
          case 'code':
            valA = (a.code || '').toLowerCase();
            valB = (b.code || '').toLowerCase();
            break;
          case 'name':
            valA = (a.name || '').toLowerCase();
            valB = (b.name || '').toLowerCase();
            break;
          case 'client':
            valA = (a.client || '').toLowerCase();
            valB = (b.client || '').toLowerCase();
            break;
          case 'progress':
            valA = a.progress || 0;
            valB = b.progress || 0;
            break;
          case 'status':
            valA = (a.status || '').toLowerCase();
            valB = (b.status || '').toLowerCase();
            break;
          default:
            return 0;
        }
        if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
        if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }

    return list;
  }, [projects, filter, searchQuery, sortConfig]);

  async function handleExportFiltered(format) {
    if (filtered.length === 0) return toast.info("Nessuna commessa da esportare");
    const project_ids = filtered.map(p => p.id);

    try {
      const res = await api.post(`/projects/export-list/${format}`, { project_ids }, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `elenco_commesse.${format === 'excel' ? 'xlsx' : 'pdf'}`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setShowExportMenu(false);
    } catch {
      toast.error('Errore durante l\'esportazione');
    }
  }

  function toggleWorkerSelection(username, isEdit = false) {
    if (isEdit) {
      const current = editForm.assigned_workers || [];
      const updated = current.includes(username) ? current.filter(w => w !== username) : [...current, username];
      setEditForm({ ...editForm, assigned_workers: updated });
    } else {
      const current = form.assigned_workers || [];
      const updated = current.includes(username) ? current.filter(w => w !== username) : [...current, username];
      setForm({ ...form, assigned_workers: updated });
    }
  }

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;

  return (
    <div className="projects-page animate-fadeIn">
      <div className="projects-command-stack">
        <span className="page-result-count">{filtered.length} commesse</span>
        <div className="page-action-group">
          {canCreate && (
            <button
              className="btn btn-secondary btn-icon"
              onClick={() => { setShowTrashModal(true); loadTrash(); }}
              title="Cestino commesse (conservate per 90 giorni)"
              aria-label="Cestino commesse"
              style={{ position: 'relative' }}
            >
              <AppIcon name="trash" />
              {trashProjects.length > 0 && (
                <span className="trash-badge-count">{trashProjects.length}</span>
              )}
            </button>
          )}
          <button
            className="btn btn-secondary btn-icon"
            onClick={() => setViewMode(prev => {
              const next = prev === 'grid' ? 'list' : 'grid';
              try { localStorage.setItem('projects_view_mode', next); } catch {}
              return next;
            })}
            title={viewMode === 'grid' ? "Visualizza come elenco" : "Visualizza come griglia"}
            aria-label={viewMode === 'grid' ? "Visualizza come elenco" : "Visualizza come griglia"}
          >
            <AppIcon name={viewMode === 'grid' ? 'list' : 'grid'} />
          </button>
          <div style={{ position: 'relative' }} ref={sortMenuRef}>
            <button
              className="btn btn-secondary btn-icon"
              onClick={() => setShowSortMenu(!showSortMenu)}
              title="Ordina commesse"
              aria-label="Ordina commesse"
            >
              <AppIcon name="filter" />
            </button>
            {showSortMenu && (
              <div className="action-popover" style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 6,
                background: 'var(--bg-card)', border: '1px solid var(--border-default)',
                borderRadius: 10, padding: 16, zIndex: 300, minWidth: 260,
                boxShadow: '0 8px 32px rgba(0,0,0,0.2)', textAlign: 'left'
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Ordina per:
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {[
                    { key: 'end_date', label: 'Data Fine' },
                    { key: 'start_date', label: 'Data Inizio' },
                    { key: 'code', label: 'Codice' },
                    { key: 'name', label: 'Titolo' },
                  ].map(opt => (
                    <div key={opt.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)' }}>
                        <input
                          type="radio"
                          name="sortKey"
                          checked={sortConfig.key === opt.key}
                          onChange={() => setSortConfig({ ...sortConfig, key: opt.key })}
                        />
                        {opt.label}
                      </label>
                      {sortConfig.key === opt.key && (
                        <button
                          type="button"
                          className="btn-ghost btn-sm"
                          onClick={() => setSortConfig({ ...sortConfig, direction: sortConfig.direction === 'asc' ? 'desc' : 'asc' })}
                          style={{ padding: '2px 6px' }}
                        >
                          {sortConfig.direction === 'asc' ? '↑' : '↓'}
                        </button>
                      )}
                    </div>
                  ))}
                  <div style={{ marginTop: 8, borderTop: '1px solid var(--border-default)', paddingTop: 8 }}>
                    <button type="button" className="btn btn-secondary btn-sm" style={{ width: '100%' }} onClick={() => setSortConfig({ key: 'none', direction: 'asc' })}>
                      Reimposta
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div style={{ position: 'relative' }} ref={exportMenuRef}>
            <button
              className="btn btn-secondary btn-icon"
              onClick={() => setShowExportMenu(!showExportMenu)}
              title="Esporta commesse"
              aria-label="Esporta commesse"
            >
              <AppIcon name="download" />
            </button>
            {showExportMenu && (
              <div className="action-popover" style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 6,
                background: 'var(--bg-card)', border: '1px solid var(--border-default)',
                borderRadius: 10, padding: 16, zIndex: 300, minWidth: 260,
                boxShadow: '0 8px 32px rgba(0,0,0,0.2)', textAlign: 'left'
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
                    <input
                      type="radio"
                      name="exportFormat"
                      value="pdf"
                      checked={exportFormat === 'pdf'}
                      onChange={() => setExportFormat('pdf')}
                      style={{ display: 'none' }}
                    />
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
                    <input
                      type="radio"
                      name="exportFormat"
                      value="excel"
                      checked={exportFormat === 'excel'}
                      onChange={() => setExportFormat('excel')}
                      style={{ display: 'none' }}
                    />
                    <AppIcon name="download" size={14} /> Excel
                  </label>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <button className="btn btn-secondary" onClick={() => setShowExportMenu(false)}>Annulla</button>
                  <button className="btn btn-primary" onClick={() => handleExportFiltered(exportFormat)}>Export {exportFormat.toUpperCase()}</button>
                </div>
              </div>
            )}
          </div>
          {canCreate && (
            <button className="btn btn-primary" onClick={openCreateModal}>
              <AppIcon name="plus" />
              Nuova commessa
            </button>
          )}
        </div>

        <div className="projects-filters" style={{ marginBottom: 0 }}>
          {['my_projects', 'all', 'planning', 'active', 'completed', 'archived'].map((f) => (
            <button
              key={f}
              className={`filter-chip ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              <span>{STATUS_LABELS_IT[f] || f}</span>
              <span className="filter-chip-count">{statusCounts[f] || 0}</span>
            </button>
          ))}
        </div>

        {/* BARRA DI RICERCA CON ICONA HIWAY */}
        <div className="hiway-search-bar" style={{ position: 'relative', display: 'flex', alignItems: 'center', minWidth: 220, flex: '1 1 280px', maxWidth: 400 }}>
          <img
            src="/hiway-icon.png"
            alt="HiWay"
            title="Cerca in HiWay GanttFlow"
            style={{ position: 'absolute', left: 12, width: 20, height: 20, objectFit: 'contain', pointerEvents: 'none' }}
          />
          <input
            type="text"
            className="input"
            style={{ width: '100%', paddingLeft: 40, paddingRight: 32, borderRadius: 20, background: 'var(--bg-secondary)', border: '1px solid var(--border-default)' }}
            placeholder="Cerca commessa, cliente o referente..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              style={{ position: 'absolute', right: 10, background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 14 }}
            >
              <AppIcon name="close" size={15} />
            </button>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><AppIcon name={filter === 'my_projects' ? 'user' : 'folder'} size={26} /></div>
          <h3>{filter === 'my_projects' ? 'Nessuna commessa assegnata a te' : 'Nessuna commessa trovata'}</h3>
          <p>{filter === 'my_projects' ? 'Non risulti ancora Referente o Addetto di alcuna commessa o fase.' : (filter !== 'all' ? 'Prova a cambiare filtro' : 'Aggiungi la tua prima commessa per iniziare')}</p>
          {filter === 'my_projects' && (
            <button className="btn btn-secondary" style={{ marginTop: 16 }} onClick={() => setFilter('all')}>
              <AppIcon name="list" />
              Vedi tutte le commesse
            </button>
          )}
        </div>
      ) : viewMode === 'list' ? (
        <div className="projects-list-card">
          <div className="projects-table-responsive">
            <table className="projects-table">
              <thead>
                <tr>
                  <th className="sortable" onClick={() => handleSort('name')} title="Ordina per titolo o codice">
                    Commessa {sortConfig.key === 'name' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}
                  </th>
                  <th className="sortable" onClick={() => handleSort('client')} title="Ordina per cliente">
                    Cliente {sortConfig.key === 'client' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}
                  </th>
                  <th className="sortable" onClick={() => handleSort('status')} title="Ordina per stato">
                    Stato {sortConfig.key === 'status' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}
                  </th>
                  <th>Referente & Addetti</th>
                  <th className="sortable" onClick={() => handleSort('end_date')} title="Ordina per data fine">
                    Data Fine {sortConfig.key === 'end_date' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}
                  </th>
                  <th className="sortable" onClick={() => handleSort('progress')} title="Ordina per avanzamento" style={{ minWidth: 150 }}>
                    Avanzamento {sortConfig.key === 'progress' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}
                  </th>
                  <th style={{ textAlign: 'right' }}>Azioni</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((project) => (
                  <tr
                    key={project.id}
                    className="projects-table-row"
                    onClick={() => navigate(`/projects/${project.id}`)}
                  >
                    <td>
                      <div className="projects-table__title-cell">
                        <div
                          className="projects-table__color-bar"
                          style={{ background: project.color || '#185FA5' }}
                        />
                        <div className="projects-table__info">
                          <div className="projects-table__header-row">
                            <span className="projects-table__code">
                              {project.code || 'UT-COMM'}
                            </span>
                            {project.is_atex && (
                              <span className="badge badge-atex" title="Conforme Direttiva ATEX" style={{ fontSize: '0.68rem', padding: '1px 6px' }}>
                                ATEX
                              </span>
                            )}
                            {project.is_alimentare && (
                              <span className="badge badge-alimentare" title="Conforme Settore Alimentare / Food Grade" style={{ fontSize: '0.68rem', padding: '1px 6px' }}>
                                Alimentare
                              </span>
                            )}
                            {!project.is_atex && !project.is_alimentare && (
                              <span className="badge badge-standard" style={{ fontSize: '0.68rem', padding: '1px 6px' }}>
                                Standard
                              </span>
                            )}
                          </div>
                          <div className="projects-table__name">
                            {project.name || 'Senza Titolo'}
                          </div>
                          {project.description && (
                            <div className="projects-table__desc" title={project.description}>
                              {project.description}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 500, color: 'var(--text-primary)' }}>
                        <AppIcon name="building" size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                        <span>{project.client || 'Non specificato'}</span>
                      </div>
                    </td>
                    <td>
                      <span className={`badge badge-${project.status}`}>
                        {STATUS_LABELS_IT[project.status] || project.status}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: '0.8rem' }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--text-primary)', fontWeight: 500 }}>
                          <AppIcon name="user" size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                          <span>{project.responsible_name || project.responsible_username || (project.owner_id === user?.id ? user?.username : 'Non specificato')}</span>
                        </div>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--text-secondary)', fontSize: '0.76rem' }}>
                          <AppIcon name="users" size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                          <span style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={project.assigned_workers?.join(', ')}>
                            {project.assigned_workers?.length > 0 ? project.assigned_workers.join(', ') : 'Vedi fasi'}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.82rem', color: 'var(--text-primary)' }}>
                        <AppIcon name="calendar" size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                        <span>{project.end_date ? new Date(project.end_date).toISOString().split('T')[0].split('-').reverse().join('/') : 'Non specificato'}</span>
                      </div>
                    </td>
                    <td style={{ minWidth: 140 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div className="progress-bar" style={{ flex: 1, height: 6, background: 'var(--bg-tertiary)', borderRadius: 3, overflow: 'hidden' }}>
                          <div
                            className="progress-bar-fill"
                            style={{ width: `${(project.progress || 0) * 100}%`, background: project.color || '#185FA5', height: '100%', borderRadius: 3 }}
                          />
                        </div>
                        <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--accent-500)', minWidth: 32, textAlign: 'right' }}>
                          {Math.round((project.progress || 0) * 100)}%
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><AppIcon name="list" size={11} /> {project.task_count} fasi</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><AppIcon name="users" size={11} /> {project.member_count} addetti</span>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                      {(user?.role === 'admin' || user?.role === 'editor' || project.owner_id === user?.id || project.responsible_id === user?.id || project.responsible_username === user?.username) && (
                        <div className="projects-table-actions">
                          <button
                            className="btn-ghost btn-sm"
                            onClick={(e) => openEditProject(project, e)}
                            title="Modifica commessa (titolo, cliente, codice, referente, addetti)"
                          >
                            <AppIcon name="edit" size={15} />
                          </button>
                          {(user?.role === 'admin' || user?.role === 'editor') && (
                            <button
                              className="btn-ghost btn-sm project-delete-btn"
                              onClick={(e) => handleDelete(project.id, e)}
                              title="Elimina commessa"
                            >
                              <AppIcon name="trash" size={15} />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="projects-grid">
          {filtered.map((project) => (
            <div
              key={project.id}
              className="project-card card"
              onClick={() => navigate(`/projects/${project.id}`)}
              style={{ borderLeft: `4px solid ${project.color || '#185FA5'}` }}
            >
              <div className="project-card-header" style={{ alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px', flex: 1, minWidth: 0 }}>
                  <span className="project-card-code" style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--accent-500)', letterSpacing: '0.02em' }}>
                    {project.code || 'UT-COMM'}
                  </span>
                  <h3 style={{ margin: '2px 0 0 0', fontSize: '1.05rem', fontWeight: 600, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                    {project.name || 'Senza Titolo'}
                  </h3>
                </div>
                <span className={`badge badge-${project.status}`}>{STATUS_LABELS_IT[project.status] || project.status}</span>
              </div>

              {/* Riga dedicata indicatori tipologia commessa: affiancati a piena larghezza con bordi arrotondati pill e spaziatura compatta */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: -6, marginBottom: -4, marginLeft: -4, flexWrap: 'nowrap' }}>
                {project.is_atex && (
                  <span className="badge badge-atex" title="Conforme Direttiva ATEX">
                    ATEX
                  </span>
                )}
                {project.is_alimentare && (
                  <span className="badge badge-alimentare" title="Conforme Settore Alimentare / Food Grade">
                    Alimentare
                  </span>
                )}
                {!project.is_atex && !project.is_alimentare && (
                  <span className="badge badge-standard">
                    Standard
                  </span>
                )}
              </div>
              <div className="project-card-meta">
                <AppIcon name="building" size={14} />
                <strong>Cliente:</strong> {project.client || 'Non specificato'}
              </div>
              <div className="project-card-meta">
                <AppIcon name="calendar" size={14} />
                <strong>Data Fine:</strong> {project.end_date ? new Date(project.end_date).toISOString().split('T')[0].split('-').reverse().join('/') : 'Non specificato'}
              </div>
              <div className="project-card-meta">
                <AppIcon name="user" size={14} />
                <strong>Referente:</strong> {project.responsible_name || project.responsible_username || (project.owner_id === user?.id ? user?.username : 'Non specificato')}
              </div>
              <div className="project-card-meta">
                <AppIcon name="users" size={14} />
                <strong>Addetti:</strong> {project.assigned_workers?.length > 0 ? project.assigned_workers.join(', ') : 'Vedi fasi'}
              </div>
              {project.description && (
                <p className="project-card-desc">{project.description}</p>
              )}
              <div className="project-card-progress">
                <div className="progress-bar">
                  <div
                    className="progress-bar-fill"
                    style={{ width: `${(project.progress || 0) * 100}%`, background: project.color || '#185FA5' }}
                  />
                </div>
                <span className="progress-label">{Math.round((project.progress || 0) * 100)}%</span>
              </div>
              <div className="project-card-footer">
                <span><AppIcon name="list" size={13} />{project.task_count} fasi</span>
                <span><AppIcon name="users" size={13} />{project.member_count} addetti</span>
                {(user?.role === 'admin' || user?.role === 'editor' || project.owner_id === user?.id || project.responsible_id === user?.id || project.responsible_username === user?.username) && (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      className="btn-ghost btn-sm project-delete"
                      onClick={(e) => openEditProject(project, e)}
                      title="Modifica commessa (titolo, cliente, codice, referente, addetti)"
                      style={{ fontSize: 14 }}
                    >
                      <AppIcon name="edit" size={16} />
                    </button>
                    {(user?.role === 'admin' || user?.role === 'editor') && (
                      <button
                        className="btn-ghost btn-sm project-delete"
                        onClick={(e) => handleDelete(project.id, e)}
                        title="Elimina commessa"
                      >
                        <AppIcon name="trash" size={16} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 1200, width: '95vw', maxHeight: '92vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header" style={{ marginBottom: 16 }}>
              <h2>Nuova Commessa</h2>
              <button className="btn-ghost btn-icon" onClick={() => setShowModal(false)} aria-label="Chiudi">
                <AppIcon name="close" />
              </button>
            </div>
            <form onSubmit={handleCreate}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(460px, 1fr))', gap: 32, alignItems: 'start' }}>
                {/* COLONNA SINISTRA: Dati Commessa e Pianificazione */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ display: 'flex', gap: 12 }}>
                    <div className="input-group" style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="project-code">Codice Commessa *</label>
                      <input
                        id="project-code"
                        className="input"
                        value={form.code}
                        onChange={(e) => setForm({ ...form, code: e.target.value })}
                        required
                        placeholder="es. UT-2026-001"
                      />
                    </div>
                    <div className="input-group" style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="project-client">Cliente *</label>
                      <input
                        id="project-client"
                        className="input"
                        value={form.client}
                        onChange={(e) => setForm({ ...form, client: e.target.value })}
                        required
                        placeholder="es. Ferrari S.p.A."
                      />
                    </div>
                  </div>

                  <div className="input-group">
                    <label htmlFor="project-name">Nome Progetto / Titolo Commessa (opzionale)</label>
                    <input
                      id="project-name"
                      className="input"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder="es. Impianto linea automatica (default: uguale al codice)"
                    />
                  </div>

                  <div style={{ display: 'flex', gap: 12 }}>
                    <div className="input-group" style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="project-start">Data Inizio</label>
                      <input
                        id="project-start"
                        type="date"
                        className="input"
                        value={form.start_date}
                        onChange={(e) => setForm({ ...form, start_date: e.target.value })}
                      />
                    </div>
                    <div className="input-group" style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="project-end">Data Fine Prevista</label>
                      <input
                        id="project-end"
                        type="date"
                        className="input"
                        value={form.end_date}
                        onChange={(e) => setForm({ ...form, end_date: e.target.value })}
                      />
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 12 }}>
                    <div className="input-group" style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="project-color">Colore</label>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          id="project-color"
                          type="color"
                          value={form.color}
                          onChange={(e) => setForm({ ...form, color: e.target.value })}
                          style={{ width: 44, height: 38, padding: 2, borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', cursor: 'pointer', flexShrink: 0 }}
                        />
                        <input
                          className="input"
                          value={form.color}
                          onChange={(e) => setForm({ ...form, color: e.target.value })}
                          placeholder="#185FA5"
                          style={{ flex: 1, minWidth: 0 }}
                        />
                      </div>
                    </div>
                    <div className="input-group" style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="project-status">Stato Iniziale</label>
                      <select
                        id="project-status"
                        className="input"
                        value={form.status}
                        onChange={(e) => setForm({ ...form, status: e.target.value })}
                      >
                        {STATUS_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="input-group">
                    <label htmlFor="project-responsible">Referente di Commessa</label>
                    <select
                      id="project-responsible"
                      className="input"
                      value={form.responsible_id || ''}
                      onChange={(e) => setForm({ ...form, responsible_id: e.target.value })}
                    >
                      <option value="">-- Nessun referente predefinito --</option>
                      {usersList.map(u => (
                        <option key={u.id} value={u.id}>{u.full_name || u.username} ({u.username})</option>
                      ))}
                    </select>
                  </div>

                  <div className="input-group">
                    <label htmlFor="project-desc">Note e Specifiche Tecniche</label>
                    <textarea
                      id="project-desc"
                      className="input"
                      rows={3}
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                      placeholder="Descrizione, note del cliente..."
                      style={{ resize: 'vertical' }}
                    />
                  </div>
                </div>

                {/* COLONNA DESTRA: Tipologia e Team */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {/* Tipologia Commessa */}
                  <div className="input-group">
                    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4 }}>
                      <span style={{ fontWeight: 600 }}>Tipologia Commessa</span>
                      <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                        ATEX e Alimentare selezionabili insieme
                      </span>
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(125px, 1fr))', gap: 8, marginTop: 4 }}>
                      {/* Opzione STANDARD */}
                      <div
                        onClick={() => setForm({ ...form, is_atex: false, is_alimentare: false })}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '10px 12px',
                          borderRadius: 10,
                          cursor: 'pointer',
                          border: (!form.is_atex && !form.is_alimentare) ? '2px solid #3b82f6' : '1px solid var(--border-color)',
                          background: (!form.is_atex && !form.is_alimentare) ? 'rgba(59, 130, 246, 0.12)' : 'var(--bg-tertiary)',
                          color: (!form.is_atex && !form.is_alimentare) ? '#2563eb' : 'var(--text-primary)',
                          transition: 'all 0.15s ease',
                          userSelect: 'none'
                        }}
                      >
                        <input
                          type="radio"
                          checked={!form.is_atex && !form.is_alimentare}
                          onChange={() => setForm({ ...form, is_atex: false, is_alimentare: false })}
                          style={{ accentColor: '#3b82f6', cursor: 'pointer' }}
                        />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>Standard</div>
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Nessun vincolo spec.</div>
                        </div>
                      </div>

                      {/* Opzione ATEX */}
                      <div
                        onClick={() => setForm({ ...form, is_atex: !form.is_atex })}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '10px 12px',
                          borderRadius: 10,
                          cursor: 'pointer',
                          border: form.is_atex ? '2px solid #f59e0b' : '1px solid var(--border-color)',
                          background: form.is_atex ? 'rgba(245, 158, 11, 0.15)' : 'var(--bg-tertiary)',
                          color: form.is_atex ? '#d97706' : 'var(--text-primary)',
                          transition: 'all 0.15s ease',
                          userSelect: 'none'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(form.is_atex)}
                          onChange={(e) => setForm({ ...form, is_atex: e.target.checked })}
                          style={{ accentColor: '#f59e0b', cursor: 'pointer' }}
                        />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>ATEX</div>
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Rischio esplosione</div>
                        </div>
                      </div>

                      {/* Opzione ALIMENTARE */}
                      <div
                        onClick={() => setForm({ ...form, is_alimentare: !form.is_alimentare })}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '10px 12px',
                          borderRadius: 10,
                          cursor: 'pointer',
                          border: form.is_alimentare ? '2px solid #10b981' : '1px solid var(--border-color)',
                          background: form.is_alimentare ? 'rgba(16, 185, 129, 0.15)' : 'var(--bg-tertiary)',
                          color: form.is_alimentare ? '#059669' : 'var(--text-primary)',
                          transition: 'all 0.15s ease',
                          userSelect: 'none'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(form.is_alimentare)}
                          onChange={(e) => setForm({ ...form, is_alimentare: e.target.checked })}
                          style={{ accentColor: '#10b981', cursor: 'pointer' }}
                        />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>Alimentare</div>
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Settore Food Grade</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Addetti della Commessa */}
                  <div className="input-group">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <label style={{ margin: 0 }}>Addetti della Commessa (Multi-selezione)</label>
                      <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                        {form.assigned_workers?.length || 0} selezionati
                      </span>
                    </div>
                    <div style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 8,
                      padding: 12,
                      borderRadius: 10,
                      border: '1px solid var(--border-color)',
                      background: 'var(--bg-tertiary)',
                      maxHeight: 250,
                      overflowY: 'auto'
                    }}>
                      {usersList.map(u => {
                        const selected = (form.assigned_workers || []).includes(u.username);
                        return (
                          <button
                            key={u.id}
                            type="button"
                            onClick={() => toggleWorkerSelection(u.username, false)}
                            style={{
                              padding: '6px 12px',
                              borderRadius: 20,
                              border: selected ? '2px solid #3b82f6' : '1px solid var(--border-color)',
                              background: selected ? 'rgba(59, 130, 246, 0.18)' : 'var(--bg-primary)',
                              color: selected ? '#2563eb' : 'var(--text-secondary)',
                              fontSize: 12.5,
                              cursor: 'pointer',
                              fontWeight: selected ? 600 : 400,
                              transition: 'all 0.15s ease'
                            }}
                          >
                            {selected ? '✓ ' : '+ '}{u.full_name || u.username}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>
                  Annulla
                </button>
                <button type="submit" className="btn btn-primary">Aggiungi Commessa</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showEditModal && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 1200, width: '95vw', maxHeight: '92vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header" style={{ marginBottom: 16 }}>
              <h2>Modifica Dati Commessa</h2>
              <button className="btn-ghost btn-icon" onClick={() => setShowEditModal(false)} aria-label="Chiudi">
                <AppIcon name="close" />
              </button>
            </div>
            <form onSubmit={handleEditSubmit}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(460px, 1fr))', gap: 32, alignItems: 'start' }}>
                {/* COLONNA SINISTRA: Informazioni Principali, Tempistiche e Note */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ display: 'flex', gap: 12 }}>
                    <div className="input-group" style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="card-edit-code">Codice Commessa *</label>
                      <input
                        id="card-edit-code"
                        className="input"
                        value={editForm.code}
                        onChange={(e) => setEditForm({ ...editForm, code: e.target.value })}
                        required
                        placeholder="es. UT-COMM"
                      />
                    </div>
                    <div className="input-group" style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="card-edit-client">Cliente *</label>
                      <input
                        id="card-edit-client"
                        className="input"
                        value={editForm.client}
                        onChange={(e) => setEditForm({ ...editForm, client: e.target.value })}
                        required
                        placeholder="es. HiWay s.r.l."
                      />
                    </div>
                  </div>

                  <div className="input-group">
                    <label htmlFor="card-edit-name">Titolo Commessa *</label>
                    <input
                      id="card-edit-name"
                      className="input"
                      value={editForm.name}
                      onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                      required
                      placeholder="es. Lancio ERP e HiPlan Q3"
                    />
                  </div>

                  <div style={{ display: 'flex', gap: 12 }}>
                    <div className="input-group" style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="card-edit-start">Data di Inizio</label>
                      <input
                        id="card-edit-start"
                        type="date"
                        className="input"
                        value={editForm.start_date}
                        onChange={(e) => setEditForm({ ...editForm, start_date: e.target.value })}
                      />
                    </div>
                    <div className="input-group" style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="card-edit-end">Data di Fine</label>
                      <input
                        id="card-edit-end"
                        type="date"
                        className="input"
                        value={editForm.end_date}
                        onChange={(e) => setEditForm({ ...editForm, end_date: e.target.value })}
                      />
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 12 }}>
                    <div className="input-group" style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="card-edit-color">Colore Identificativo</label>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          id="card-edit-color"
                          type="color"
                          value={editForm.color}
                          onChange={(e) => setEditForm({ ...editForm, color: e.target.value })}
                          style={{ width: 44, height: 38, padding: 2, borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', cursor: 'pointer', flexShrink: 0 }}
                        />
                        <input
                          className="input"
                          value={editForm.color}
                          onChange={(e) => setEditForm({ ...editForm, color: e.target.value })}
                          placeholder="#185FA5"
                          style={{ flex: 1, minWidth: 0 }}
                        />
                      </div>
                    </div>
                    <div className="input-group" style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="card-edit-status">Stato Commessa</label>
                      <select
                        id="card-edit-status"
                        className="input"
                        value={editForm.status}
                        onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                      >
                        {STATUS_OPTIONS.map(opt => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="input-group">
                    <label htmlFor="card-edit-responsible">Referente di Commessa</label>
                    <select
                      id="card-edit-responsible"
                      className="input"
                      value={editForm.responsible_id || ''}
                      onChange={(e) => setEditForm({ ...editForm, responsible_id: e.target.value })}
                    >
                      <option value="">-- Nessun referente predefinito --</option>
                      {usersList.map(u => (
                        <option key={u.id} value={u.id}>{u.full_name || u.username} ({u.username})</option>
                      ))}
                    </select>
                  </div>

                  <div className="input-group">
                    <label htmlFor="card-edit-desc">Descrizione / Note</label>
                    <textarea
                      id="card-edit-desc"
                      className="input"
                      rows={3}
                      value={editForm.description}
                      onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                      placeholder="Dettagli e note della commessa..."
                      style={{ resize: 'vertical' }}
                    />
                  </div>
                </div>

                {/* COLONNA DESTRA: Tipologia Commessa e Addetti Team */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {/* Tipologia Commessa */}
                  <div className="input-group">
                    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4 }}>
                      <span style={{ fontWeight: 600 }}>Tipologia Commessa</span>
                      <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                        ATEX e Alimentare selezionabili insieme
                      </span>
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(125px, 1fr))', gap: 8, marginTop: 4 }}>
                      {/* Opzione STANDARD */}
                      <div
                        onClick={() => setEditForm({ ...editForm, is_atex: false, is_alimentare: false })}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '10px 12px',
                          borderRadius: 10,
                          cursor: 'pointer',
                          border: (!editForm.is_atex && !editForm.is_alimentare) ? '2px solid #3b82f6' : '1px solid var(--border-color)',
                          background: (!editForm.is_atex && !editForm.is_alimentare) ? 'rgba(59, 130, 246, 0.12)' : 'var(--bg-tertiary)',
                          color: (!editForm.is_atex && !editForm.is_alimentare) ? '#2563eb' : 'var(--text-primary)',
                          transition: 'all 0.15s ease',
                          userSelect: 'none'
                        }}
                      >
                        <input
                          type="radio"
                          checked={!editForm.is_atex && !editForm.is_alimentare}
                          onChange={() => setEditForm({ ...editForm, is_atex: false, is_alimentare: false })}
                          style={{ accentColor: '#3b82f6', cursor: 'pointer' }}
                        />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>Standard</div>
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Nessun vincolo spec.</div>
                        </div>
                      </div>

                      {/* Opzione ATEX */}
                      <div
                        onClick={() => setEditForm({ ...editForm, is_atex: !editForm.is_atex })}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '10px 12px',
                          borderRadius: 10,
                          cursor: 'pointer',
                          border: editForm.is_atex ? '2px solid #f59e0b' : '1px solid var(--border-color)',
                          background: editForm.is_atex ? 'rgba(245, 158, 11, 0.15)' : 'var(--bg-tertiary)',
                          color: editForm.is_atex ? '#d97706' : 'var(--text-primary)',
                          transition: 'all 0.15s ease',
                          userSelect: 'none'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(editForm.is_atex)}
                          onChange={(e) => setEditForm({ ...editForm, is_atex: e.target.checked })}
                          style={{ accentColor: '#f59e0b', cursor: 'pointer' }}
                        />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>ATEX</div>
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Rischio esplosione</div>
                        </div>
                      </div>

                      {/* Opzione ALIMENTARE */}
                      <div
                        onClick={() => setEditForm({ ...editForm, is_alimentare: !editForm.is_alimentare })}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '10px 12px',
                          borderRadius: 10,
                          cursor: 'pointer',
                          border: editForm.is_alimentare ? '2px solid #10b981' : '1px solid var(--border-color)',
                          background: editForm.is_alimentare ? 'rgba(16, 185, 129, 0.15)' : 'var(--bg-tertiary)',
                          color: editForm.is_alimentare ? '#059669' : 'var(--text-primary)',
                          transition: 'all 0.15s ease',
                          userSelect: 'none'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(editForm.is_alimentare)}
                          onChange={(e) => setEditForm({ ...editForm, is_alimentare: e.target.checked })}
                          style={{ accentColor: '#10b981', cursor: 'pointer' }}
                        />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>Alimentare</div>
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Settore Food Grade</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Addetti della Commessa */}
                  <div className="input-group">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <label style={{ margin: 0 }}>Addetti della Commessa (Multi-selezione)</label>
                      <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                        {editForm.assigned_workers?.length || 0} selezionati
                      </span>
                    </div>
                    <div style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 8,
                      padding: 12,
                      borderRadius: 10,
                      border: '1px solid var(--border-color)',
                      background: 'var(--bg-tertiary)',
                      maxHeight: 250,
                      overflowY: 'auto'
                    }}>
                      {usersList.map(u => {
                        const selected = (editForm.assigned_workers || []).includes(u.username);
                        return (
                          <button
                            key={u.id}
                            type="button"
                            onClick={() => toggleWorkerSelection(u.username, true)}
                            style={{
                              padding: '6px 12px',
                              borderRadius: 20,
                              border: selected ? '2px solid #3b82f6' : '1px solid var(--border-color)',
                              background: selected ? 'rgba(59, 130, 246, 0.18)' : 'var(--bg-primary)',
                              color: selected ? '#2563eb' : 'var(--text-secondary)',
                              fontSize: 12.5,
                              cursor: 'pointer',
                              fontWeight: selected ? 600 : 400,
                              transition: 'all 0.15s ease'
                            }}
                          >
                            {selected ? '✓ ' : '+ '}{u.full_name || u.username}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setShowEditModal(false)}>
                  Annulla
                </button>
                <button type="submit" className="btn btn-primary">
                  Salva Modifiche
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODALE CESTINO COMMESSE */}
      {showTrashModal && (
        <div className="modal-overlay" onClick={() => setShowTrashModal(false)}>
          <div
            className="modal trash-modal animate-scaleIn"
            style={{
              maxWidth: 820,
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
                    <h2 style={{ fontSize: '1.3rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>Cestino Commesse</h2>
                    <span style={{
                      fontSize: '0.75rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                      background: 'rgba(148, 163, 184, 0.16)', color: 'var(--text-secondary)'
                    }}>
                      {trashProjects.length} {trashProjects.length === 1 ? 'commessa' : 'commesse'}
                    </span>
                  </div>
                  <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: 'var(--text-tertiary)' }}>
                    Gli elementi vengono conservati per 90 giorni prima dell'eliminazione definitiva automatica.
                  </p>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {trashProjects.length > 0 && (
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

            {/* Lista delle commesse nel Cestino */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 0', minHeight: 220 }}>
              {trashLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '60px 0' }}>
                  <div className="spinner" />
                </div>
              ) : trashProjects.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '50px 20px', color: 'var(--text-tertiary)' }}>
                  <div style={{
                    width: 58, height: 58, borderRadius: '50%',
                    background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center',
                    justifyContent: 'center', margin: '0 auto 16px', color: 'var(--text-muted)'
                  }}>
                    <AppIcon name="trash" size={28} />
                  </div>
                  <h3 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 6px' }}>
                    Il cestino è vuoto
                  </h3>
                  <p style={{ fontSize: '0.85rem', margin: 0 }}>
                    Nessuna commessa presente nel cestino.
                  </p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {trashProjects.map((p) => (
                    <div
                      key={p.id}
                      className="trash-project-card"
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '12px 16px', borderRadius: 10,
                        border: '1px solid var(--border-default)', background: 'var(--bg-card)',
                        gap: 16
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            width: 8, height: 40, borderRadius: 4,
                            backgroundColor: p.color || '#185FA5', flexShrink: 0
                          }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-700)', background: 'var(--accent-soft)', padding: '1px 6px', borderRadius: 4 }}>
                              {p.code}
                            </span>
                            <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.92rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {p.name}
                            </span>
                            {p.client && (
                              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                • {p.client}
                              </span>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4, fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                            <span>Fasi: {p.task_count}</span>
                            <span>•</span>
                            <span>Eliminata il {p.deleted_at ? new Date(p.deleted_at).toLocaleDateString('it-IT') : 'N/D'}</span>
                          </div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                        <span
                          style={{
                            fontSize: '0.75rem', fontWeight: 650, padding: '4px 10px', borderRadius: 999,
                            background: p.days_left <= 7 ? 'rgba(239, 68, 68, 0.12)' : (p.days_left <= 30 ? 'rgba(245, 158, 11, 0.12)' : 'var(--bg-tertiary)'),
                            color: p.days_left <= 7 ? 'var(--danger, #ef4444)' : (p.days_left <= 30 ? '#d97706' : 'var(--text-secondary)'),
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {p.days_left <= 0 ? 'Eliminazione oggi' : `Tra ${p.days_left} giorni`}
                        </span>

                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleRestoreProject(p)}
                          title="Ripristina commessa"
                          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', padding: '6px 12px' }}
                        >
                          <AppIcon name="undo" size={14} />
                          Ripristina
                        </button>

                        <button
                          className="btn btn-icon btn-sm"
                          onClick={() => handleHardDeleteProject(p)}
                          title="Elimina definitivamente"
                          style={{ color: 'var(--danger, #ef4444)', padding: 6 }}
                        >
                          <AppIcon name="trash" size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer del Cestino */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowTrashModal(false)}
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
