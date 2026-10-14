import { useState, useEffect, useMemo, useCallback } from 'react';
import api from '../api/client';
import { useToast } from '../context/ToastContext';
import AppIcon from '../components/ui/AppIcon';
import { getApiErrorMessage } from '../utils/apiErrors';
import './AttendancePage.css';

const MONTH_NAMES = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
const WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];

const DEPARTMENT_LABELS = {
  ufficio_tecnico: 'Ufficio Tecnico',
  produzione: 'Produzione',
  acquisti: 'Acquisti',
  commerciale: 'Commerciale',
  amministrazione: 'Amministrazione',
  admin: 'Admin',
};

// Colori delle note, come le evidenziazioni usate nel foglio Excel
const NOTE_COLORS = [
  { value: null, label: 'Nessuno' },
  { value: '#fde047', label: 'Giallo' },
  { value: '#f9a8d4', label: 'Rosa' },
  { value: '#38bdf8', label: 'Azzurro' },
  { value: '#ef4444', label: 'Rosso' },
  { value: '#86efac', label: 'Verde' },
  { value: '#111827', label: 'Nero' },
];

const ITEM_KINDS = [
  { key: 'phase', label: 'Fasi', single: 'Fase' },
  { key: 'vacation', label: 'Ferie', single: 'Ferie' },
  { key: 'leave', label: 'Permessi', single: 'Permesso' },
  { key: 'trip', label: 'Viaggi', single: 'Viaggio' },
];

const STORAGE_KEY = 'hiplan-attendance-kinds';

function monthKey(year, month) {
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

function isDarkColor(hex) {
  if (!hex) return false;
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) < 140;
}

function loadVisibleKinds() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') return { phase: true, vacation: true, leave: true, trip: true, ...saved };
  } catch { }
  return { phase: true, vacation: true, leave: true, trip: true };
}

export default function AttendancePage() {
  const toast = useToast();
  const today = new Date();
  const todayStr = today.toLocaleDateString('sv-SE');
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [grid, setGrid] = useState(null);
  const [loading, setLoading] = useState(true);
  const [department, setDepartment] = useState('all');
  const [visibleKinds, setVisibleKinds] = useState(loadVisibleKinds);
  const [editing, setEditing] = useState(null); // { user, day, text, color, items }
  const [saving, setSaving] = useState(false);

  const loadGrid = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/attendance', { params: { month: monthKey(year, month) } });
      setGrid(data);
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Errore nel caricamento della griglia presenze'));
    } finally {
      setLoading(false);
    }
  }, [year, month, toast]);

  useEffect(() => { loadGrid(); }, [loadGrid]);

  function shiftMonth(delta) {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  }

  function toggleKind(key) {
    setVisibleKinds(prev => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { }
      return next;
    });
  }

  const departments = useMemo(() => {
    const set = new Set((grid?.users || []).map(u => u.department).filter(Boolean));
    return [...set];
  }, [grid]);

  // Righe raggruppate per reparto, come i blocchi separati del foglio Excel
  const groups = useMemo(() => {
    const users = (grid?.users || []).filter(u => department === 'all' || u.department === department);
    const byDept = new Map();
    users.forEach(u => {
      const key = u.department || '';
      if (!byDept.has(key)) byDept.set(key, []);
      byDept.get(key).push(u);
    });
    return [...byDept.entries()];
  }, [grid, department]);

  function openCell(user, day) {
    if (!grid?.can_edit) return;
    const cell = grid.cells?.[user.id]?.[day.date] || { items: [], note: null };
    setEditing({ user, day, text: cell.note?.text || '', color: cell.note?.color || null, items: cell.items });
  }

  async function saveNote(clear = false) {
    if (!editing) return;
    setSaving(true);
    try {
      await api.put('/attendance/notes', {
        user_id: editing.user.id,
        date: editing.day.date,
        text: clear ? '' : editing.text,
        color: clear ? null : editing.color,
      });
      setEditing(null);
      loadGrid();
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Errore nel salvataggio della cella'));
    } finally {
      setSaving(false);
    }
  }

  function renderCell(user, day) {
    const cell = grid.cells?.[user.id]?.[day.date];
    const items = (cell?.items || []).filter(i => visibleKinds[i.kind]);
    const note = cell?.note;
    const isWeekend = day.weekday >= 5;
    const hasVacation = items.some(i => i.kind === 'vacation');

    const classes = ['att-cell'];
    if (isWeekend) classes.push('is-weekend');
    if (day.holiday) classes.push('is-holiday');
    if (hasVacation && !note?.color) classes.push('has-vacation');
    if (day.date === todayStr) classes.push('is-today');
    if (grid.can_edit) classes.push('is-editable');

    const style = note?.color
      ? { background: note.color, color: isDarkColor(note.color) ? '#fff' : '#111827' }
      : undefined;

    const tooltip = [
      `${user.full_name} – ${day.date.split('-').reverse().join('/')}${day.holiday ? ` (${day.holiday})` : ''}`,
      note?.text ? `Nota: ${note.text}` : null,
      ...items.map(i => `${ITEM_KINDS.find(k => k.key === i.kind)?.single || i.kind}: ${i.label}${i.detail && i.detail !== i.label ? ` – ${i.detail}` : ''}`),
    ].filter(Boolean).join('\n');

    const shownItems = items.slice(0, note?.text ? 1 : 2);
    const hiddenCount = items.length - shownItems.length;

    return (
      <td key={day.date} className={classes.join(' ')} style={style} title={tooltip} onClick={() => openCell(user, day)}>
        {note?.text && <div className="att-note-text">{note.text}</div>}
        {shownItems.map((item, idx) => (
          <div key={idx} className={`att-item att-item--${item.kind}`} style={item.color && !note?.color ? { '--item-color': item.color } : undefined}>
            {item.label}
          </div>
        ))}
        {hiddenCount > 0 && <div className="att-more">+{hiddenCount}</div>}
      </td>
    );
  }

  return (
    <div className="attendance-page">
      <div className="att-toolbar">
        <div className="att-toolbar-left">
          <h1 className="att-title">{MONTH_NAMES[month]} {year}</h1>
          <div className="calendar-nav-buttons">
            <button className="calendar-nav-btn" onClick={() => shiftMonth(-1)}>‹ Prec.</button>
            <button className="calendar-nav-btn today" onClick={() => { setYear(today.getFullYear()); setMonth(today.getMonth()); }}>Oggi</button>
            <button className="calendar-nav-btn" onClick={() => shiftMonth(1)}>Succ. ›</button>
          </div>
        </div>
        <div className="att-toolbar-right">
          <div className="att-kinds">
            {ITEM_KINDS.map(k => (
              <label key={k.key} className={`att-kind-chip att-kind-chip--${k.key} ${visibleKinds[k.key] ? 'active' : ''}`}>
                <input type="checkbox" checked={visibleKinds[k.key]} onChange={() => toggleKind(k.key)} />
                {k.label}
              </label>
            ))}
          </div>
          <select className="input att-dept-select" value={department} onChange={e => setDepartment(e.target.value)} aria-label="Filtra per reparto">
            <option value="all">Tutti i reparti</option>
            {departments.map(d => <option key={d} value={d}>{DEPARTMENT_LABELS[d] || d}</option>)}
          </select>
        </div>
      </div>

      {grid?.can_edit === false && (
        <p className="att-hint">Visualizzazione in sola lettura: solo admin ed editor possono scrivere note nelle celle.</p>
      )}

      <div className="att-table-wrap">
        {loading && !grid ? (
          <div className="att-loading">Caricamento...</div>
        ) : grid && (
          <table className="att-table">
            <thead>
              <tr>
                <th className="att-name-col">Dipendente</th>
                {grid.days.map(day => (
                  <th
                    key={day.date}
                    className={`att-day-head${day.weekday >= 5 ? ' is-weekend' : ''}${day.holiday ? ' is-holiday' : ''}${day.date === todayStr ? ' is-today' : ''}`}
                    title={day.holiday || undefined}
                  >
                    <span className="att-day-weekday">{WEEKDAYS[day.weekday]}</span>
                    <span className="att-day-num">{Number(day.date.slice(8, 10))}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map(([dept, users]) => (
                <DepartmentRows key={dept || 'none'} dept={dept} users={users} days={grid.days} renderCell={renderCell} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <div className="modal-overlay animate-fadeIn">
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460, width: '100%', padding: 24 }}>
            <div className="modal-header">
              <h2>{editing.user.full_name} · {editing.day.date.split('-').reverse().join('/')}</h2>
              <button className="btn-ghost btn-icon" onClick={() => setEditing(null)} aria-label="Chiudi"><AppIcon name="close" /></button>
            </div>

            {editing.items.length > 0 && (
              <div className="att-edit-auto">
                <span className="att-edit-label">Dal gestionale</span>
                {editing.items.map((item, idx) => (
                  <div key={idx} className={`att-item att-item--${item.kind}`}>
                    {item.label}{item.detail && item.detail !== item.label ? ` – ${item.detail}` : ''}
                  </div>
                ))}
              </div>
            )}

            <div className="input-group">
              <label htmlFor="att-note-text">Nota</label>
              <input
                id="att-note-text"
                className="input"
                autoFocus
                value={editing.text}
                maxLength={500}
                placeholder="Es. M, 13:30–14:00, TECHO IN REMOTO"
                onChange={e => setEditing({ ...editing, text: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') saveNote(); }}
              />
            </div>

            <div className="input-group">
              <label>Colore cella</label>
              <div className="att-color-row">
                {NOTE_COLORS.map(c => (
                  <button
                    key={c.label}
                    type="button"
                    className={`att-color-swatch${editing.color === c.value ? ' selected' : ''}${c.value ? '' : ' is-none'}`}
                    style={c.value ? { background: c.value } : undefined}
                    title={c.label}
                    aria-label={c.label}
                    onClick={() => setEditing({ ...editing, color: c.value })}
                  />
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
              <button type="button" className="btn btn-secondary" onClick={() => saveNote(true)} disabled={saving}>Svuota cella</button>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>Annulla</button>
                <button type="button" className="btn btn-primary" onClick={() => saveNote()} disabled={saving}>Salva</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DepartmentRows({ dept, users, days, renderCell }) {
  return (
    <>
      <tr className="att-dept-row">
        <td className="att-name-col">{DEPARTMENT_LABELS[dept] || dept || 'Senza reparto'}</td>
        <td colSpan={days.length} />
      </tr>
      {users.map(user => (
        <tr key={user.id}>
          <th className="att-name-col att-name-cell" scope="row">{user.full_name}</th>
          {days.map(day => renderCell(user, day))}
        </tr>
      ))}
    </>
  );
}
