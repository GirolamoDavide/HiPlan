import React, { useState, useRef } from 'react';
import AppIcon from './AppIcon';
import './AssigneeInput.css';

function getDeptBadge(dept, fullName = '') {
  if (!dept) return null;
  const map = {
    ufficio_tecnico: 'UT',
    produzione: 'Prod',
    acquisti: 'Acq',
    commerciale: 'Comm',
    admin: 'Admin'
  };
  const badge = map[dept] || dept;
  // If the fullName already has (UT), (Prod), (Acq), don't duplicate
  if (fullName && fullName.toLowerCase().includes(`(${badge.toLowerCase()})`)) {
    return null;
  }
  return badge;
}

export default function AssigneeInput({
  selected = [],
  onChange,
  users = [],
  placeholder = 'Aggiungi...',
  valueKey = 'username',
  direction = 'down'
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);

  const safeSelected = Array.isArray(selected) ? selected : [];
  const safeUsers = Array.isArray(users) ? users : [];

  const q = query.trim().toLowerCase();
  const filtered = safeUsers.filter(u => {
    if (u.is_active === false) return false;
    if (safeSelected.includes(u[valueKey])) return false;
    if (!q) return true;
    const nameMatch = (u.full_name || '').toLowerCase().includes(q);
    const usernameMatch = (u.username || '').toLowerCase().includes(q);
    const deptMatch = (u.department || '').toLowerCase().includes(q);
    return nameMatch || usernameMatch || deptMatch;
  });

  function add(val) {
    onChange([...safeSelected, val]);
    setQuery('');
    setOpen(false);
    inputRef.current?.focus();
  }

  function remove(val) {
    onChange(safeSelected.filter(v => v !== val));
  }

  return (
    <div className="assignee-tags-box" onClick={() => inputRef.current?.focus()}>
      {safeSelected.map(val => {
        const u = safeUsers.find(user => user[valueKey] === val);
        const displayLabel = u ? (u.full_name || u.username) : val;
        return (
          <span key={val} className="assignee-tag">
            {displayLabel}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                remove(val);
              }}
              aria-label={`Rimuovi ${displayLabel}`}
            >
              <AppIcon name="close" size={11} />
            </button>
          </span>
        );
      })}
      <div className="assignee-input-wrap">
        <input
          ref={inputRef}
          className="assignee-input"
          placeholder={safeSelected.length === 0 ? 'Nessuno (lascia vuoto) o cerca utente...' : placeholder}
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
        />
      </div>
      {open && filtered.length > 0 && (
        <div
          className={`assignee-dropdown ${direction === 'up' ? 'assignee-dropdown-up' : ''}`}
          onMouseDown={e => e.preventDefault()}
        >
          <div className="assignee-dropdown-header">
            <span>Addetti HiPlan ({filtered.length})</span>
          </div>
          <div className="assignee-dropdown-list">
            {filtered.map(u => {
              const avatarChar = (u.full_name || u.username || '?')[0].toUpperCase();
              const deptBadge = getDeptBadge(u.department, u.full_name);
              return (
                <div
                  key={u.id || u.username}
                  className="assignee-dropdown-item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(u[valueKey]);
                  }}
                >
                  <div className="assignee-item-avatar">{avatarChar}</div>
                  <div className="assignee-item-info">
                    <div className="assignee-item-row">
                      <span className="assignee-item-name">{u.full_name || u.username}</span>
                      {deptBadge && (
                        <span className="assignee-dept-pill">{deptBadge}</span>
                      )}
                    </div>
                    <span className="assignee-item-username">@{u.username}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

