import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import {
  Sparkles,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  ArrowRight,
  UserCheck,
  Calendar,
  Layers,
  History,
  Undo2,
  Clock,
  ShieldCheck,
  XCircle,
  Info,
  Eye,
  LayoutGrid,
  SlidersHorizontal
} from 'lucide-react';
import ReplanningGanttPreview from './ReplanningGanttPreview';

const formatDateTime = (dateStr) => {
  if (!dateStr) return '-';
  try {
    const hasTimezone = /Z|[+-]\d{2}(?::?\d{2})?$/.test(dateStr);
    const normalizedStr = hasTimezone ? dateStr : `${dateStr}Z`;
    return new Date(normalizedStr).toLocaleString('it-IT');
  } catch {
    return dateStr;
  }
};

export default function SmartReplanningSection({
  projectId,
  user,
  onReloadTasks,
  tasks = [],
  links = [],
  projectStartDate,
  projectEndDate
}) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [replanData, setReplanData] = useState(null);
  const [applyingId, setApplyingId] = useState(null);
  const [revertingId, setRevertingId] = useState(null);
  const [confirmModalSuggestion, setConfirmModalSuggestion] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [previewSuggestionId, setPreviewSuggestionId] = useState(null);
  const [aiPreference, setAiPreference] = useState(() => {
    try {
      return localStorage.getItem('hiplan-replanning-user-preference') || 'none';
    } catch {
      return 'none';
    }
  });

  const canManage = user?.role === 'admin' || user?.role === 'editor';
  const prevFingerprintRef = useRef(null);
  const isInternalActionRef = useRef(false);
  const debounceTimerRef = useRef(null);

  // Calcolo di una firma univoca (fingerprint) per rilevare aggiunte, eliminazioni o modifiche di date/ore/addetti/stato sulle fasi e dipendenze del Gantt
  const ganttFingerprint = useMemo(() => {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return '__EMPTY__';
    }

    const tasksStr = tasks
      .map((t) => {
        let workersStr = '';
        if (Array.isArray(t.workers)) {
          workersStr = t.workers
            .map((w) => (typeof w === 'object' && w !== null ? (w.id || w.name || w.username || '') : String(w)))
            .sort()
            .join(',');
        } else if (t.workers) {
          workersStr = String(t.workers);
        }

        return [
          t.id,
          t.text || '',
          t.start_date || '',
          t.end_date || '',
          t.duration || 0,
          t.progress || 0,
          t.completed || 0,
          t.planned_hours || 0,
          workersStr
        ].join(':');
      })
      .sort()
      .join('|');

    const linksStr = Array.isArray(links)
      ? links
          .map((l) => `${l.id}:${l.source}:${l.target}:${l.type || 0}`)
          .sort()
          .join('|')
      : '';

    return `${tasksStr}#${linksStr}`;
  }, [tasks, links]);

  const fetchSuggestions = useCallback(async (prefOverride) => {
    if (!projectId || !canManage) return;
    setLoading(true);
    const prefToUse = prefOverride !== undefined ? prefOverride : aiPreference;
    try {
      const res = await api.get(
        `/replanning/project/${projectId}/suggestions?preference=${encodeURIComponent(prefToUse)}&_t=${Date.now()}`
      );
      setReplanData(res.data);
    } catch (err) {
      console.error('Errore caricamento suggerimenti di replanning:', err);
      // Non blocchiamo la UI se l'utente non ha permessi o errore temporaneo
    } finally {
      setLoading(false);
    }
  }, [projectId, canManage, aiPreference]);

  const handlePreferenceChange = (newPref) => {
    setAiPreference(newPref);
    try {
      localStorage.setItem('hiplan-replanning-user-preference', newPref);
    } catch { }
    fetchSuggestions(newPref);
    if (newPref === 'change_worker') {
      toast.info('Preferenza AI impostata: Preferisco cambiare addetto');
    } else if (newPref === 'keep_worker') {
      toast.info("Preferenza AI impostata: Preferisco lasciare l'addetto corrente e cambiare giorni");
    } else {
      toast.info('Preferenza AI impostata: Nessuna preferenza (analisi bilanciata)');
    }
  };

  // Caricamento iniziale al montaggio
  useEffect(() => {
    if (canManage) {
      fetchSuggestions();
    }
  }, [fetchSuggestions, canManage]);

  // Aggiornamento automatico in tempo reale quando una fase qualsiasi della commessa corrente viene aggiunta o modificata nel Gantt
  useEffect(() => {
    if (!canManage || !projectId) return;

    // Al primo render, memorizza la firma iniziale senza effettuare fetch duplicato
    if (prevFingerprintRef.current === null) {
      prevFingerprintRef.current = ganttFingerprint;
      return;
    }

    // Se la firma non è cambiata, nessuna modifica
    if (prevFingerprintRef.current === ganttFingerprint) {
      return;
    }

    // Se l'aggiornamento è scaturito dall'applicazione/annullamento interno di un suggerimento, non duplicare la richiesta
    if (isInternalActionRef.current) {
      isInternalActionRef.current = false;
      prevFingerprintRef.current = ganttFingerprint;
      return;
    }

    // Registra la nuova firma e ricalcola automaticamente i suggerimenti di replanning (con debounce 450ms)
    prevFingerprintRef.current = ganttFingerprint;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      fetchSuggestions();
    }, 450);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [ganttFingerprint, canManage, projectId, fetchSuggestions]);

  const handleApply = async (suggestionOrBatch) => {
    if (!canManage) {
      toast.error('Solo gli utenti Editor o Admin possono applicare modifiche.');
      return;
    }
    if (!suggestionOrBatch) return;

    const isBatch = Boolean(suggestionOrBatch.isBatch && Array.isArray(suggestionOrBatch.suggestions));
    const listToApply = isBatch ? suggestionOrBatch.suggestions : [suggestionOrBatch];
    const validList = listToApply.filter((s) => s?.proposed_changes);

    if (validList.length === 0) return;

    setApplyingId(isBatch ? 'batch' : suggestionOrBatch.id);
    try {
      const proposals = validList.map((sugg) => {
        const relatedCorrections = (sugg.cascade_impact?.other_projects || [])
          .filter((op) => op.proposed_correction)
          .map((op) => op.proposed_correction);

        return {
          ...sugg.proposed_changes,
          reason: sugg.action_label || sugg.title,
          cascade_successors: sugg.cascade_impact?.same_project_tasks || [],
          related_project_corrections: relatedCorrections
        };
      });

      isInternalActionRef.current = true;

      let successMsg = '';
      if (isBatch && proposals.length > 1) {
        const res = await api.post(`/replanning/project/${projectId}/apply-batch`, { proposals });
        successMsg = res.data.message || `${proposals.length} ottimizzazioni applicate con successo!`;
      } else {
        const payload = { proposal_payload: proposals[0] };
        const res = await api.post(`/replanning/project/${projectId}/apply`, payload);
        successMsg = res.data.message || 'Ottimizzazione applicata con successo!';
      }

      toast.success(successMsg);
      setConfirmModalSuggestion(null);

      // Ricarica sia i suggerimenti che il Gantt della pagina padre
      await fetchSuggestions();
      if (onReloadTasks) {
        onReloadTasks();
      }
    } catch (err) {
      isInternalActionRef.current = false;
      console.error('Errore durante applicazione suggerimento:', err);
      const detail = err.response?.data?.detail || err.message || 'Errore durante l\'applicazione.';
      toast.error(detail);
    } finally {
      setApplyingId(null);
      // Timeout di sicurezza per resettare il flag interno
      setTimeout(() => {
        isInternalActionRef.current = false;
      }, 2500);
    }
  };

  const handleRevert = async (logId) => {
    if (!canManage) {
      toast.error('Solo gli utenti Editor o Admin possono annullare modifiche.');
      return;
    }
    setRevertingId(logId);
    try {
      isInternalActionRef.current = true;
      const res = await api.post(`/replanning/project/${projectId}/revert/${logId}`);
      toast.success(res.data.message || 'Modifica annullata con successo!');
      await fetchSuggestions();
      if (onReloadTasks) {
        onReloadTasks();
      }
    } catch (err) {
      isInternalActionRef.current = false;
      console.error('Errore annullamento replanning:', err);
      const detail = err.response?.data?.detail || err.message || 'Errore durante l\'annullamento.';
      toast.error(detail);
    } finally {
      setRevertingId(null);
      // Timeout di sicurezza per resettare il flag interno
      setTimeout(() => {
        isInternalActionRef.current = false;
      }, 2500);
    }
  };

  if (!canManage) {
    return null;
  }

  const suggestions = replanData?.suggestions || [];
  const history = replanData?.history || [];

  const primaryHistory = useMemo(() => {
    if (!Array.isArray(history)) return [];
    const filtered = history.filter((log) => !log.parent_log_id);
    return filtered.length > 0 ? filtered : history;
  }, [history]);

  return (
    <div style={{ marginTop: 24 }}>
      {/* Box Principale Card */}
      <div
        style={{
          background: 'var(--bg-secondary, #ffffff)',
          borderRadius: '16px',
          border: '1px solid rgba(59, 130, 246, 0.25)',
          boxShadow: '0 4px 20px rgba(59, 130, 246, 0.05)',
          overflow: 'hidden'
        }}
      >
        {/* Header con gradiente elegante */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            padding: '20px 24px',
            background: 'linear-gradient(135deg, rgba(37, 99, 235, 0.08), rgba(99, 102, 241, 0.04))',
            borderBottom: '1px solid var(--border-subtle, #e2e8f0)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: '12px',
                background: 'linear-gradient(135deg, #2563eb, #4f46e5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                boxShadow: '0 4px 12px rgba(37, 99, 235, 0.25)',
                flexShrink: 0
              }}
            >
              <Sparkles size={22} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text-primary, #1e293b)' }}>
                Ottimizzatore e Rebalance Carichi
              </h3>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-secondary, #64748b)' }}>
                Analisi globale multi-commessa: rileva ferie, sovrapposizioni e ritardi proponendo soluzioni che proteggono la scadenza finale.
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            {/* Badges conflitti e raccomandazioni a sinistra */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {suggestions.length > 0 && (
                <span
                  style={{
                    background: 'rgba(239, 68, 68, 0.12)',
                    color: '#dc2626',
                    border: '1px solid rgba(239, 68, 68, 0.25)',
                    padding: '4px 12px',
                    borderRadius: '20px',
                    fontSize: 12,
                    fontWeight: 600
                  }}
                >
                  {suggestions.length} {suggestions.length === 1 ? 'conflitto' : 'conflitti'}
                </span>
              )}

              {replanData?.actionable_suggestions_count > 0 && (
                <span
                  style={{
                    background: 'rgba(16, 185, 129, 0.12)',
                    color: '#059669',
                    border: '1px solid rgba(16, 185, 129, 0.25)',
                    padding: '4px 12px',
                    borderRadius: '20px',
                    fontSize: 12,
                    fontWeight: 600
                  }}
                >
                  {replanData.actionable_suggestions_count} azioni raccomandate
                </span>
              )}
            </div>

            {/* Preferenza Riprogrammatore AI + Pulsanti Azione */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto', flexWrap: 'wrap' }}>
              {/* Selettore Preferenza AI */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: aiPreference !== 'none' ? 'rgba(37, 99, 235, 0.08)' : '#ffffff',
                  border: aiPreference !== 'none' ? '1px solid #93c5fd' : '1px solid #cbd5e1',
                  borderRadius: '10px',
                  padding: '4px 10px',
                  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)',
                  transition: 'all 0.2s ease'
                }}
                title="Indica all'ottimizzatore AI come preferisci risolvere i conflitti (ferie, sovraccarichi e ritardi)"
              >
                <SlidersHorizontal size={14} color={aiPreference !== 'none' ? '#2563eb' : '#64748b'} />
                <span style={{ fontSize: 12, fontWeight: 600, color: '#475569', whiteSpace: 'nowrap' }}>
                  Preferenza AI:
                </span>
                <select
                  value={aiPreference}
                  onChange={(e) => handlePreferenceChange(e.target.value)}
                  disabled={loading}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    fontSize: 12,
                    fontWeight: 600,
                    color: aiPreference !== 'none' ? '#1d4ed8' : '#1e293b',
                    cursor: 'pointer',
                    outline: 'none',
                    padding: '2px 4px'
                  }}
                >
                  <option value="none">Nessuna preferenza</option>
                  <option value="change_worker">Preferisco cambiare addetto</option>
                  <option value="keep_worker">Preferisco lasciare l'addetto corrente e cambiare giorni</option>
                </select>
              </div>

              {replanData?.actionable_suggestions_count > 0 && (
                <button
                  className="btn btn-secondary"
                  onClick={() => setPreviewSuggestionId('all')}
                  style={{
                    padding: '8px 14px',
                    fontSize: 13,
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    color: '#1d4ed8',
                    borderColor: '#3b82f6',
                    background: 'rgba(59, 130, 246, 0.08)'
                  }}
                  title="Visualizza anteprima simulata del Gantt con tutte le modifiche applicate"
                >
                  <Eye size={15} />
                  Anteprima Gantt Riprogrammato
                </button>
              )}

              <button
                className="btn btn-secondary"
                onClick={() => fetchSuggestions()}
                disabled={loading}
                title="Ricalcola analisi orari e carichi"
                style={{ padding: '8px 12px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                Aggiorna
              </button>
            </div>
          </div>
        </div>

        {/* Corpo Sezione */}
        <div style={{ padding: '24px', opacity: (loading && replanData) ? 0.65 : 1, transition: 'opacity 0.2s ease', position: 'relative' }}>
          {loading && !replanData ? (
            <div style={{ textAlign: 'center', padding: '36px 0', color: 'var(--text-secondary, #64748b)' }}>
              <RefreshCw size={28} className="animate-spin" style={{ margin: '0 auto 12px', color: '#2563eb' }} />
              <div style={{ fontSize: 15, fontWeight: 500 }}>Analisi carichi e conflitti in corso...</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>Controllo sovrapposizioni su tutte le commesse attive</div>
            </div>
          ) : suggestions.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '32px 20px',
                background: 'rgba(16, 185, 129, 0.04)',
                borderRadius: '12px',
                border: '1px dashed rgba(16, 185, 129, 0.3)'
              }}
            >
              <ShieldCheck size={36} style={{ color: '#10b981', margin: '0 auto 10px' }} />
              <h4 style={{ margin: 0, fontSize: 16, color: '#059669', fontWeight: 600 }}>
                Pianificazione Ottimale: Nessun Conflitto Rilevato!
              </h4>
              <p style={{ margin: '8px auto 0', maxWidth: 620, fontSize: 13, color: 'var(--text-secondary, #64748b)' }}>
                Tutti gli addetti assegnati sono regolarmente disponibili (nessun conflitto con ferie o sovraccarichi orari oltre le 8h) e le fasi rispettano la data di consegna finale ({replanData?.project_end_date ? new Date(replanData.project_end_date).toLocaleDateString('it-IT') : 'N.D.'}).
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {suggestions.map((item) => {
                const isManual = item.strategy === 'manual_action_required';
                const isReassign = item.strategy === 'reassign_worker';
                const isShift = item.strategy === 'internal_shift';

                return (
                  <div
                    key={item.id}
                    style={{
                      borderRadius: '12px',
                      border: isManual ? '1px solid rgba(239, 68, 68, 0.4)' : '1px solid rgba(37, 99, 235, 0.2)',
                      background: isManual ? 'rgba(254, 242, 242, 0.5)' : 'var(--bg-primary, #ffffff)',
                      padding: '20px',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.02)'
                    }}
                  >
                    {/* Header Singolo Suggerimento */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              letterSpacing: '0.5px',
                              padding: '2px 8px',
                              borderRadius: '6px',
                              background: isManual ? '#fee2e2' : (item.is_alternative || item.badge === 'Opzione Alternativa') ? '#ede9fe' : isReassign ? '#e0f2fe' : '#fef3c7',
                              color: isManual ? '#b91c1c' : (item.is_alternative || item.badge === 'Opzione Alternativa') ? '#6d28d9' : isReassign ? '#0369a1' : '#b45309'
                            }}
                          >
                            {item.badge || item.strategy_label}
                          </span>
                          <h4 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary, #1e293b)' }}>
                            {item.title}
                          </h4>
                        </div>
                        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary, #475569)', lineHeight: 1.5 }}>
                          {item.description}
                        </p>
                      </div>

                      {/* Bottoni di Azione (Sempre in alto a destra) */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 12 }}>
                        {item.proposed_changes && (
                          <button
                            className="btn btn-secondary"
                            onClick={() => setPreviewSuggestionId(item.id)}
                            style={{
                              padding: '8px 12px',
                              fontSize: 13,
                              fontWeight: 500,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              color: '#334155',
                              whiteSpace: 'nowrap'
                            }}
                            title="Simula l'effetto di questa singola riprogrammazione nel Gantt"
                          >
                            <Eye size={14} />
                            Simula nel Gantt
                          </button>
                        )}

                        {item.proposed_changes && canManage && (
                          <button
                            className="btn btn-primary"
                            onClick={() => setConfirmModalSuggestion(item)}
                            disabled={applyingId === item.id}
                            style={{
                              padding: '8px 16px',
                              fontSize: 13,
                              fontWeight: 600,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              background: '#2563eb',
                              boxShadow: '0 2px 8px rgba(37, 99, 235, 0.2)',
                              whiteSpace: 'nowrap'
                            }}
                          >
                            <CheckCircle size={15} />
                            Applica Modifica
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Dettaglio Proposta di Risoluzione (Diff Visivo) */}
                    {item.proposed_changes ? (
                      <div
                        style={{
                          marginTop: 16,
                          padding: '14px 18px',
                          borderRadius: '10px',
                          background: 'rgba(248, 250, 252, 0.8)',
                          border: '1px solid var(--border-subtle, #e2e8f0)'
                        }}
                      >
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#334155', textTransform: 'uppercase', marginBottom: 10 }}>
                          Soluzione Raccomandata dall'Ottimizzatore:
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                          {/* Stato Attuale */}
                          <div style={{ fontSize: 13 }}>
                            <div style={{ color: 'var(--text-tertiary, #94a3b8)', fontSize: 11 }}>STATO ATTUALE</div>
                            <div style={{ fontWeight: 600, color: '#64748b' }}>
                              Addetti: <strong>{item.current_state?.workers?.join(', ') || 'Nessuno'}</strong>
                            </div>
                            <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>
                              Date: {item.current_state?.start_date ? new Date(item.current_state.start_date).toLocaleDateString('it-IT') : '-'} → {item.current_state?.end_date ? new Date(item.current_state.end_date).toLocaleDateString('it-IT') : '-'}
                            </div>
                          </div>

                          <ArrowRight size={18} style={{ color: '#2563eb', flexShrink: 0 }} />

                          {/* Stato Proposto */}
                          <div style={{ fontSize: 13 }}>
                            <div style={{ color: '#2563eb', fontSize: 11, fontWeight: 700 }}>NUOVO STATO PROPOSTO</div>
                            <div style={{ fontWeight: 700, color: '#0f172a' }}>
                              Addetti: <span style={{ color: '#2563eb' }}>{item.proposed_changes.workers?.join(', ') || 'Invariati'}</span>
                            </div>
                            <div style={{ color: '#0f172a', fontSize: 12, marginTop: 2 }}>
                              Date: <strong>{item.proposed_changes.start_date ? new Date(item.proposed_changes.start_date).toLocaleDateString('it-IT') : '-'} → {item.proposed_changes.end_date ? new Date(item.proposed_changes.end_date).toLocaleDateString('it-IT') : '-'}</strong>
                              {item.proposed_changes.shift_working_days > 0 && (
                                <span style={{ marginLeft: 6, color: '#d97706', fontWeight: 600, fontSize: 11 }}>
                                  (+{item.proposed_changes.shift_working_days} gg lav.)
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div
                        style={{
                          marginTop: 16,
                          padding: '12px 16px',
                          borderRadius: '8px',
                          background: '#fff1f2',
                          border: '1px solid #fecdd3',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10
                        }}
                      >
                        <AlertTriangle size={18} style={{ color: '#e11d48', flexShrink: 0 }} />
                        <span style={{ fontSize: 13, color: '#9f1239', fontWeight: 500 }}>
                          {item.action_label}: la commessa non ha sufficiente margine interno. Il responsabile deve intervenire manualmente sulla scadenza della commessa o autorizzare subforniture/straordinari.
                        </span>
                      </div>
                    )}

                    {/* Box Propagazione a Cascata */}
                    {item.cascade_impact && (
                      <div
                        style={{
                          marginTop: 14,
                          padding: '12px 16px',
                          borderRadius: '8px',
                          background: 'rgba(241, 245, 249, 0.6)',
                          fontSize: 12,
                          color: '#475569'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, color: '#1e293b', marginBottom: 6 }}>
                          <Layers size={14} color="#2563eb" />
                          Verifica Propagazione a Cascata:
                        </div>

                        {/* Fasi a valle della stessa commessa */}
                        <div style={{ marginBottom: 6 }}>
                          • <strong>Fasi successive in questa commessa:</strong>{' '}
                          {item.cascade_impact.same_project_tasks && item.cascade_impact.same_project_tasks.length > 0 ? (
                            <div style={{ marginTop: 4, marginLeft: 12 }}>
                              <span style={{ color: '#b45309', fontWeight: 600 }}>
                                {item.cascade_impact.same_project_tasks.length} {item.cascade_impact.same_project_tasks.length === 1 ? 'fase collegata slitterà' : 'fasi collegate slitteranno'} per mantenere i vincoli di precedenza:
                              </span>
                              <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                                {item.cascade_impact.same_project_tasks.map((st, sIdx) => (
                                  <div key={sIdx} style={{ color: '#475569', fontSize: 11 }}>
                                    ↳ <strong>{st.task_name}</strong>: nuove date proposte{' '}
                                    <span style={{ color: '#2563eb', fontWeight: 600 }}>
                                      {st.proposed_start ? new Date(st.proposed_start).toLocaleDateString('it-IT') : '-'} → {st.proposed_end ? new Date(st.proposed_end).toLocaleDateString('it-IT') : '-'}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <span style={{ color: '#059669', fontWeight: 600 }}>
                              Nessun impatto sulle altre fasi della commessa.
                            </span>
                          )}
                        </div>

                        {/* Altre commesse e correzioni a catena */}
                        {item.cascade_impact.other_projects && item.cascade_impact.other_projects.length > 0 && (
                          <div style={{ marginBottom: 6 }}>
                            <div style={{ fontWeight: 600, color: '#334155', marginBottom: 2 }}>
                              • <strong>Impatto su altre commesse attive e correzioni a catena:</strong>
                            </div>
                            <div style={{ paddingLeft: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                              {item.cascade_impact.other_projects.map((op, opIdx) => (
                                <div key={opIdx} style={{ fontSize: 11 }}>
                                  <span style={{ color: op.status === 'relieved' || op.status === 'safe' ? '#059669' : '#b45309' }}>
                                    {op.message}
                                  </span>
                                  {op.proposed_correction && (
                                    <div
                                      style={{
                                        marginTop: 3,
                                        padding: '4px 8px',
                                        borderRadius: '4px',
                                        backgroundColor: '#f5f3ff',
                                        border: '1px solid #ddd6fe',
                                        color: '#5b21b6',
                                        fontWeight: 500
                                      }}
                                    >
                                      <strong>↪ Correzione a catena:</strong> {op.proposed_correction.summary}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Scadenza finale commessa */}
                        <div>
                          • <strong>Data di fine commessa:</strong>{' '}
                          <strong style={{ color: item.cascade_impact.project_deadline_status === 'safe' ? '#059669' : '#dc2626' }}>
                            {item.cascade_impact.deadline_message}
                          </strong>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Sezione Cronologia Modifiche Applicate (Revert) */}
          {history.length > 0 && (
            <div style={{ marginTop: 28, borderTop: '1px solid var(--border-subtle, #e2e8f0)', paddingTop: 18 }}>
              <button
                onClick={() => setShowHistory(!showHistory)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#2563eb',
                  fontSize: 13,
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  cursor: 'pointer',
                  padding: 0
                }}
              >
                <History size={15} />
                {showHistory
                  ? 'Nascondi Cronologia Ottimizzazioni'
                  : `Mostra Cronologia Ottimizzazioni Applicate (${primaryHistory.length})`}
              </button>

              {showHistory && (
                <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {primaryHistory.map((log) => (
                    <div
                      key={log.id}
                      style={{
                        padding: '12px 16px',
                        borderRadius: '8px',
                        background: log.reverted ? '#f8fafc' : 'rgba(240, 253, 244, 0.7)',
                        border: log.reverted ? '1px solid #e2e8f0' : '1px solid rgba(16, 185, 129, 0.3)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: 12
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, color: log.reverted ? '#94a3b8' : '#0f172a' }}>
                          {log.reason} {log.reverted && <span style={{ color: '#dc2626' }}>(ANNULLATO)</span>}
                        </div>
                        {log.cascade_logs && log.cascade_logs.length > 0 && (
                          <div style={{ color: '#b45309', fontSize: 11, marginTop: 3 }}>
                            ↳ Include {log.cascade_logs.length} {log.cascade_logs.length === 1 ? 'slittamento a cascata collegato' : 'slittamenti a cascata collegati'}:{' '}
                            <strong>{[...new Set(log.cascade_logs.map((c) => c.task_name))].join(', ')}</strong>
                          </div>
                        )}
                        <div style={{ color: '#64748b', fontSize: 11, marginTop: 3 }}>
                          Applicato il {formatDateTime(log.created_at)}
                          {log.reverted_by_name && ` • Annullato da ${log.reverted_by_name}${log.reverted_at ? ` il ${formatDateTime(log.reverted_at)}` : ''}`}
                        </div>
                      </div>

                      {!log.reverted && canManage && (
                        <button
                          className="btn btn-secondary"
                          onClick={() => handleRevert(log.id)}
                          disabled={revertingId === log.id}
                          style={{
                            fontSize: 12,
                            padding: '4px 10px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            color: '#b91c1c'
                          }}
                          title={log.cascade_count > 0 ? "Annulla questa operazione e ripristina automaticamente anche tutte le modifiche a cascata collegate" : "Annulla questa operazione"}
                        >
                          <Undo2 size={13} />
                          {revertingId === log.id
                            ? 'Annullamento...'
                            : log.cascade_count > 0
                              ? `Annulla con Cascate (${log.cascade_count + 1})`
                              : 'Annulla (Revert)'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Modal di Conferma Approvazione */}
      {confirmModalSuggestion && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.6)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: 16
          }}
          onClick={() => setConfirmModalSuggestion(null)}
        >
          <div
            style={{
              background: 'var(--bg-primary, #ffffff)',
              borderRadius: '16px',
              maxWidth: confirmModalSuggestion?.isBatch ? 620 : 520,
              width: '100%',
              boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
              border: '1px solid var(--border-subtle, #e2e8f0)',
              overflow: 'hidden'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border-subtle, #e2e8f0)' }}>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#1e293b' }}>
                {confirmModalSuggestion.isBatch ? 'Conferma Applicazione Modifiche Consigliate' : 'Conferma Applicazione Modifiche'}
              </h3>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
                {confirmModalSuggestion.isBatch
                  ? `Questa azione applicherà contemporaneamente le ${confirmModalSuggestion.suggestions.length} azioni consigliate per riequilibrare la commessa.`
                  : 'Questa azione aggiornerà le date o gli addetti delle lavorazioni indicate.'}
              </p>
            </div>

            <div style={{ padding: '20px 24px', fontSize: 13, color: '#334155', maxHeight: '60vh', overflowY: 'auto' }}>
              {confirmModalSuggestion.isBatch ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {confirmModalSuggestion.suggestions.map((sugg, idx) => (
                    <div key={sugg.id || idx} style={{ background: '#f8fafc', padding: '14px', borderRadius: '10px', border: '1px solid #e2e8f0' }}>
                      <div style={{ fontWeight: 600, color: '#2563eb', marginBottom: 6 }}>
                        {idx + 1}. {sugg.action_label || sugg.title}
                      </div>
                      <div>• Fase: <strong>{sugg.task_name}</strong></div>
                      {sugg.proposed_changes?.workers && (
                        <div>• Addetti: <strong>{sugg.proposed_changes.workers.join(', ')}</strong></div>
                      )}
                      <div>
                        • Nuove Date: <strong>{sugg.proposed_changes?.start_date ? new Date(sugg.proposed_changes.start_date).toLocaleDateString('it-IT') : '-'} → {sugg.proposed_changes?.end_date ? new Date(sugg.proposed_changes.end_date).toLocaleDateString('it-IT') : '-'}</strong>
                      </div>
                      {sugg.cascade_impact?.same_project_tasks?.length > 0 && (
                        <div style={{ marginTop: 6, color: '#b45309', fontSize: 12 }}>
                          • Fasi a valle che slitteranno ({sugg.cascade_impact.same_project_tasks.length}):
                          <div style={{ marginTop: 2, marginLeft: 10, display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {sugg.cascade_impact.same_project_tasks.map((st, i) => (
                              <div key={i} style={{ fontSize: 11, color: '#475569' }}>
                                ↳ <strong>{st.task_name}</strong>: {st.proposed_start ? new Date(st.proposed_start).toLocaleDateString('it-IT') : '-'} → {st.proposed_end ? new Date(st.proposed_end).toLocaleDateString('it-IT') : '-'}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {sugg.cascade_impact?.other_projects?.some((op) => op.proposed_correction) && (
                        <div style={{ marginTop: 6, color: '#6d28d9', fontSize: 12 }}>
                          • Correzioni su altre commesse:
                          <div style={{ marginTop: 2, marginLeft: 10, display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {sugg.cascade_impact.other_projects
                              .filter((op) => op.proposed_correction)
                              .map((op, i) => (
                                <div key={i} style={{ fontSize: 11, color: '#4c1d95' }}>
                                  ↳ <strong>{op.proposed_correction.task_name}</strong> ({op.project_code || op.proposed_correction?.project_code ? `[${op.project_code || op.proposed_correction?.project_code}] ` : ''}{op.project_name}):{' '}
                                  {op.proposed_correction.proposed_start ? new Date(op.proposed_correction.proposed_start).toLocaleDateString('it-IT') : '-'} → {op.proposed_correction.proposed_end ? new Date(op.proposed_correction.proposed_end).toLocaleDateString('it-IT') : '-'}{' '}
                                  (+{op.proposed_correction.shift_working_days} gg)
                                </div>
                              ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ background: '#f8fafc', padding: '12px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>{confirmModalSuggestion.action_label}</div>
                  <div>• Fase: <strong>{confirmModalSuggestion.task_name}</strong></div>
                  {confirmModalSuggestion.proposed_changes?.workers && (
                    <div>• Addetti: <strong>{confirmModalSuggestion.proposed_changes.workers.join(', ')}</strong></div>
                  )}
                  <div>
                    • Nuove Date: <strong>{confirmModalSuggestion.proposed_changes?.start_date ? new Date(confirmModalSuggestion.proposed_changes.start_date).toLocaleDateString('it-IT') : '-'} → {confirmModalSuggestion.proposed_changes?.end_date ? new Date(confirmModalSuggestion.proposed_changes.end_date).toLocaleDateString('it-IT') : '-'}</strong>
                  </div>
                  {confirmModalSuggestion.cascade_impact?.same_project_tasks?.length > 0 && (
                    <div style={{ marginTop: 8, color: '#b45309' }}>
                      • Fasi a valle che slitteranno ({confirmModalSuggestion.cascade_impact.same_project_tasks.length}):
                      <div style={{ marginTop: 4, marginLeft: 10, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {confirmModalSuggestion.cascade_impact.same_project_tasks.map((st, i) => (
                          <div key={i} style={{ fontSize: 11, color: '#475569' }}>
                            ↳ <strong>{st.task_name}</strong>: {st.proposed_start ? new Date(st.proposed_start).toLocaleDateString('it-IT') : '-'} → {st.proposed_end ? new Date(st.proposed_end).toLocaleDateString('it-IT') : '-'}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {confirmModalSuggestion.cascade_impact?.other_projects?.some((op) => op.proposed_correction) && (
                    <div style={{ marginTop: 8, color: '#6d28d9' }}>
                      • Correzioni a catena su altre commesse:
                      <div style={{ marginTop: 4, marginLeft: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {confirmModalSuggestion.cascade_impact.other_projects
                          .filter((op) => op.proposed_correction)
                          .map((op, i) => (
                            <div key={i} style={{ fontSize: 11, color: '#4c1d95' }}>
                              ↳ <strong>{op.proposed_correction.task_name}</strong> ({op.project_code || op.proposed_correction?.project_code ? `[${op.project_code || op.proposed_correction?.project_code}] ` : ''}{op.project_name}):{' '}
                              {op.proposed_correction.proposed_start ? new Date(op.proposed_correction.proposed_start).toLocaleDateString('it-IT') : '-'} → {op.proposed_correction.proposed_end ? new Date(op.proposed_correction.proposed_end).toLocaleDateString('it-IT') : '-'}{' '}
                              (+{op.proposed_correction.shift_working_days} gg)
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <p style={{ fontSize: 12, color: '#64748b', marginTop: 12, marginBottom: 0 }}>
                Nota: L'operazione verrà registrata nella cronologia e potrà essere annullata in qualsiasi momento.
              </p>
            </div>

            <div
              style={{
                padding: '16px 24px',
                background: '#f8fafc',
                borderTop: '1px solid var(--border-subtle, #e2e8f0)',
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 12
              }}
            >
              <button
                className="btn btn-secondary"
                onClick={() => setConfirmModalSuggestion(null)}
                disabled={applyingId !== null}
              >
                Annulla
              </button>
              <button
                className="btn btn-primary"
                onClick={() => handleApply(confirmModalSuggestion)}
                disabled={applyingId !== null}
                style={{ background: '#2563eb' }}
              >
                {applyingId
                  ? 'Applicazione in corso...'
                  : confirmModalSuggestion.isBatch
                    ? `Conferma e Applica (${confirmModalSuggestion.suggestions.length})`
                    : 'Conferma e Applica'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal / Panel di Anteprima Simulazione Gantt */}
      {previewSuggestionId !== null && (
        <ReplanningGanttPreview
          tasks={tasks}
          links={links}
          suggestions={suggestions}
          projectName={replanData?.project_name}
          projectCode={replanData?.project_code}
          relatedProjects={replanData?.related_projects || {}}
          projectStartDate={projectStartDate || replanData?.project_start_date}
          projectEndDate={projectEndDate || replanData?.project_end_date}
          onApplySuggestion={(sugg) => {
            setPreviewSuggestionId(null);
            setConfirmModalSuggestion(sugg);
          }}
          onClose={() => setPreviewSuggestionId(null)}
          canManage={canManage}
          initialSuggestionId={previewSuggestionId}
        />
      )}
    </div>
  );
}
