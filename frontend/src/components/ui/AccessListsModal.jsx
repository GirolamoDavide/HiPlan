import { useState, useEffect } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import AppIcon from './AppIcon';
import AssigneeInput from './AssigneeInput';
import { getApiErrorMessage } from '../../utils/apiErrors';

/* Permessi di una sezione (chi può vedere / chi può compilare), gestiti dagli admin
   come gli osservatori ticket. `endpoint` espone GET/PUT { viewers, editors }. */
export default function AccessListsModal({ title, endpoint, sectionName, editorsLabel, users, onClose }) {
  const toast = useToast();
  const [viewers, setViewers] = useState([]);
  const [editors, setEditors] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get(endpoint)
      .then(({ data }) => {
        setViewers(data.viewers || []);
        setEditors(data.editors || []);
      })
      .catch(() => toast.error(`Impossibile caricare i permessi di ${sectionName}`));
  }, [endpoint, sectionName, toast]);

  async function handleSave() {
    setSaving(true);
    try {
      await api.put(endpoint, { viewers, editors });
      toast.success(`Permessi di ${sectionName} aggiornati`);
      onClose();
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Errore durante il salvataggio'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay animate-fadeIn">
      {/* Alto abbastanza da contenere l'elenco persone aperto senza tagliarlo */}
      <div
        className="modal"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 760, width: '100%', minHeight: 'min(640px, 88vh)', padding: 32, display: 'flex', flexDirection: 'column' }}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="btn-ghost btn-icon" onClick={onClose} aria-label="Chiudi"><AppIcon name="close" /></button>
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0 0 16px' }}>
          Gli amministratori possono sempre vedere e compilare {sectionName}. Chi può compilare può anche vedere.
        </p>
        <div className="input-group">
          <label>Possono vedere</label>
          <AssigneeInput selected={viewers} onChange={setViewers} users={users} placeholder="Aggiungi persone..." />
        </div>
        <div className="input-group">
          <label>{editorsLabel}</label>
          <AssigneeInput selected={editors} onChange={setEditors} users={users} placeholder="Aggiungi persone..." />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 'auto', paddingTop: 20 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Annulla</button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Salvataggio...' : 'Salva permessi'}
          </button>
        </div>
      </div>
    </div>
  );
}
