import React, { useState, useEffect, useMemo, useRef } from 'react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import AppIcon from '../components/ui/AppIcon';

const TRIGGER_LABELS = {
  phase_completed: { label: 'Fase completata (100%)', iconName: 'checkCircle', color: '#10b981', desc: 'Quando una fase raggiunge il 100% o viene completata' },
  phase_started: { label: 'Fase avviata (inizio lavori)', iconName: 'play', color: '#3b82f6', desc: 'Appena viene registrato il primo avanzamento o consuntivo ore' },
  phase_progress_reached: { label: 'Avanzamento a soglia %', iconName: 'trendingUp', color: '#8b5cf6', desc: 'Quando l\'avanzamento raggiunge o supera una soglia definita (es. 50%, 75%)' },
  phase_delayed: { label: 'Fase scaduta non completata', iconName: 'alertTriangle', color: '#dc2626', desc: 'Se la data di fine fase è superata e la fase non è ancora conclusa' },
  budget_hours_exceeded: { label: 'Consuntivo ore supera soglia %', iconName: 'clock', color: '#f59e0b', desc: 'Se le ore consuntivate superano una percentuale di budget' },
  phase_deadline_approaching: { label: 'Scadenza fase imminente', iconName: 'clock', color: '#ef4444', desc: 'Scansione periodica a pochi giorni dal termine con completamento parziale' },
};

const ACTION_LABELS = {
  create_todo: { label: 'Crea TODO automatico', iconName: 'todo', color: '#3b82f6', desc: 'Genera un nuovo task nella scheda TODO con reparto e scadenza' },
  send_notification: { label: 'Invia Notifica PM/Addetti', iconName: 'bell', color: '#8b5cf6', desc: 'Invia una notifica in-app con messaggio di allerta' },
  create_todo_and_notify: { label: 'Crea TODO + Invia Notifica PM', iconName: 'zap', color: '#10b981', desc: 'Crea il task per il reparto e contemporaneamente avvisa il Project Manager' },
  create_calendar_event: { label: 'Crea Evento a Calendario', iconName: 'calendar', color: '#0284c7', desc: 'Inserisce automaticamente un evento o promemoria nel calendario aziendale' },
};

export const CALENDAR_COLORS = [
  { value: '#10b981', label: 'Verde Smeraldo', desc: 'Collaudi & Consegne' },
  { value: '#0284c7', label: 'Azzurro HiPlan', desc: 'Avvio Lavori & Standard' },
  { value: '#8b5cf6', label: 'Viola Indaco', desc: 'Meeting & SAL' },
  { value: '#f59e0b', label: 'Ambra', desc: 'Attenzione & Budget' },
  { value: '#ef4444', label: 'Rosso Corallo', desc: 'Urgente & Ritardi' },
  { value: '#06b6d4', label: 'Ciano', desc: 'Milestone Tecniche' },
  { value: '#ec4899', label: 'Rosa Magenta', desc: 'Revisione / Commerciale' },
  { value: '#64748b', label: 'Ardesia', desc: 'Promemoria Generico' },
];

export const TRIGGER_DEFAULT_COLORS = {
  phase_completed: '#10b981',             // Verde Smeraldo (Collaudi/Consegne)
  phase_started: '#0284c7',               // Azzurro HiPlan (Avvio lavori)
  phase_progress_reached: '#8b5cf6',      // Viola Indaco (Meeting/SAL)
  budget_hours_exceeded: '#f59e0b',       // Ambra (Attenzione budget)
  phase_delayed: '#ef4444',               // Rosso Corallo (Urgente/Ritardi)
  phase_deadline_approaching: '#f59e0b',  // Ambra (Scadenza imminente)
};

export const DEPARTMENT_LABELS = {
  ufficio_tecnico: 'Ufficio Tecnico',
  produzione: 'Produzione',
  acquisti: 'Acquisti',
  commerciale: 'Commerciale',
  amministrazione: 'Amministrazione',
  specific_workers: 'Addetti Specifici',
};

export const DEPARTMENT_ICON_NAMES = {
  ufficio_tecnico: 'tool',
  produzione: 'columns',
  acquisti: 'package',
  commerciale: 'briefcase',
  amministrazione: 'creditCard',
  specific_workers: 'user',
};

export function getSmartContentDefaults(triggerType = 'phase_completed', department = '', actionType = 'create_todo') {
  if (triggerType === 'phase_completed') {
    if (department === 'ufficio_tecnico') {
      return {
        rule_name: 'UT completato ➔ Ordine Materiali per Acquisti',
        rule_description: 'Quando l\'Ufficio Tecnico rilascia i disegni, crea automaticamente il task per ordinare i materiali.',
        todo_title: 'Ordinare materiali per commessa {project_code}',
        todo_content: 'La fase di progettazione {task_name} è completata al 100%. I disegni sono rilasciati. Procedere con la distinta base e l\'acquisto componenti per la commessa {project_name}.',
        assignee_department: 'acquisti',
        due_days: 3,
        event_title: 'Revisione Tecnica e Rilascio: {task_name} ({project_code})',
        event_description: 'Sessione di verifica e rilascio disegni tecnici per {task_name} commessa {project_code}. Verificare conformità tecnica con PM e Produzione.',
        event_date_type: 'task_end_date',
        event_days_offset: 0,
        notify_title: '✅ Disegni UT completati: {task_name} ({project_code})',
        notify_message: 'La progettazione per la fase {task_name} è conclusa al 100%. Disegni pronti per Acquisti e Produzione.',
      };
    }
    if (department === 'produzione') {
      return {
        rule_name: 'Produzione completata ➔ Collaudo Finale e Imballo',
        rule_description: 'Al termine della produzione, avvia il collaudo funzionale e la preparazione dei documenti di spedizione.',
        todo_title: 'Collaudo finale e preparazione imballo: {project_code}',
        todo_content: 'La lavorazione di produzione per la fase {task_name} è terminata. Eseguire collaudo funzionale e preparare i documenti di spedizione per {project_name}.',
        assignee_department: 'ufficio_tecnico',
        due_days: 2,
        event_title: 'Collaudo Finale e Consegna: {task_name} ({project_code})',
        event_description: 'Collaudo finale e verifica conformità della lavorazione {task_name} per la commessa {project_code} prima del rilascio al cliente.',
        event_date_type: 'task_end_date',
        event_days_offset: 0,
        notify_title: '🎉 Produzione conclusa: {task_name} ({project_code})',
        notify_message: 'La fase di produzione {task_name} è terminata al 100%. Procedere con il collaudo e la consegna.',
      };
    }
    if (department === 'acquisti') {
      return {
        rule_name: 'Acquisti completati ➔ Check Arrivo Materiali a Magazzino',
        rule_description: 'Quando gli acquisti sono completati, notifica la produzione per verificare la presenza dei componenti.',
        todo_title: 'Verifica arrivo materiali a magazzino: {project_code}',
        todo_content: 'Approvvigionamento completato per la fase {task_name}. Verificare la presenza di tutti i componenti a magazzino per la commessa {project_name}.',
        assignee_department: 'produzione',
        due_days: 2,
        event_title: 'Arrivo Materiali e Spunta: {task_name} ({project_code})',
        event_description: 'Verifica consegna componenti fornitori e spunta bolle per la commessa {project_code}.',
        event_date_type: 'task_end_date',
        event_days_offset: 0,
        notify_title: '📦 Forniture completate: {task_name} ({project_code})',
        notify_message: 'Tutti gli ordini per la fase {task_name} risultano evasi. Componenti pronti per la produzione.',
      };
    }
    if (department === 'commerciale') {
      return {
        rule_name: 'Fase Commerciale chiusa ➔ Emissione SAL / Fattura',
        rule_description: 'Al completamento dell\'accordo commerciale, incarica l\'amministrazione di emettere il SAL o la fattura.',
        todo_title: 'Emissione SAL / Fatturazione cliente: {project_code}',
        todo_content: 'La fase commerciale {task_name} è completata. Procedere con l\'emissione della fattura o del SAL previsto per la commessa {project_name}.',
        assignee_department: 'amministrazione',
        due_days: 3,
        event_title: 'Chiusura Commerciale e Consegna Documenti: {project_code}',
        event_description: 'Incontro finale e verbalizzazione accordo con il cliente per la commessa {project_code}.',
        event_date_type: 'task_end_date',
        event_days_offset: 0,
        notify_title: '💼 Tranche commerciale completata: {project_code}',
        notify_message: 'Milestone commerciale {task_name} conclusa con successo per la commessa {project_name}. Procedere con la fatturazione.',
      };
    }
    // Default per tutti i reparti
    return {
      rule_name: 'Fase completata (100%) ➔ Attività Successiva',
      rule_description: 'Al raggiungimento del 100% della fase, avvia la lavorazione successiva o il collaudo.',
      todo_title: 'Attività successiva post-completamento: {task_name} ({project_code})',
      todo_content: 'La fase {task_name} è completata al 100%. Procedere con le attività operative successive per la commessa {project_name}.',
      assignee_department: 'produzione',
      due_days: 3,
      event_title: 'Collaudo e Consegna: {task_name} ({project_code})',
      event_description: 'Riunione e collaudo finale per la fase {task_name} della commessa {project_code}. Verificare conformità e documenti di consegna.',
      event_date_type: 'task_end_date',
      event_days_offset: 0,
      notify_title: '✅ Fase completata al 100%: {task_name}',
      notify_message: 'La fase {task_name} ({project_code}) è stata contrassegnata come completata. PM responsabile: {pm_name}.',
    };
  }

  if (triggerType === 'phase_started') {
    if (department === 'produzione') {
      return {
        rule_name: 'Inizio Produzione ➔ Check Kit e Attrezzaggio',
        rule_description: 'All\'avvio della produzione, controlla la disponibilità di kit, utensili e materiali a bordo macchina.',
        todo_title: 'Verifica kit materiali a bordo macchina: {task_name} ({project_code})',
        todo_content: 'La produzione per la fase {task_name} è stata avviata. Verificare il piazzamento, utensili e presenza dei kit magazzino per {project_name}.',
        assignee_department: 'produzione',
        due_days: 1,
        event_title: 'Kick-off Avvio Produzione: {task_name} ({project_code})',
        event_description: 'Briefing operativo di montaggio/lavorazione per {task_name} della commessa {project_code}. Verificare attrezzaggi e cronoprogramma.',
        event_date_type: 'task_start_date',
        event_days_offset: 0,
        notify_title: '🚀 Produzione avviata: {task_name} ({project_code})',
        notify_message: 'La fase {task_name} per la commessa {project_code} è ufficialmente avviata. Monitorare avanzamento e ore.',
      };
    }
    if (department === 'ufficio_tecnico') {
      return {
        rule_name: 'Inizio Progettazione UT ➔ Allineamento Specifiche',
        rule_description: 'All\'inizio della progettazione, pianifica il kick-off tecnico con il Project Manager.',
        todo_title: 'Apertura commessa e impostazione cartelle CAD: {project_code}',
        todo_content: 'Inizio progettazione per {task_name}. Verificare specifiche cliente e caricare lo schema di base per {project_name}.',
        assignee_department: 'ufficio_tecnico',
        due_days: 2,
        event_title: 'Kick-off Progettazione: {task_name} ({project_code})',
        event_description: 'Allineamento iniziale tra PM e progettisti per la fase {task_name} della commessa {project_code}. Esame vincoli e capitolato.',
        event_date_type: 'task_start_date',
        event_days_offset: 0,
        notify_title: '🚀 Progettazione avviata: {task_name} ({project_code})',
        notify_message: 'L\'ufficio tecnico ha avviato la fase {task_name} per la commessa {project_code}.',
      };
    }
    return {
      rule_name: 'Avvio Lavori ➔ Briefing e verifica risorse',
      rule_description: 'All\'avvio della fase, organizza l\'incontro operativo di inizio lavorazione.',
      todo_title: 'Allestimento e avvio attività: {task_name} ({project_code})',
      todo_content: 'La fase {task_name} è stata avviata. Verificare disponibilità delle risorse operative e documentazione per {project_name}.',
      assignee_department: 'pm',
      due_days: 2,
      event_title: 'Kick-off e Avvio Lavori: {task_name} ({project_code})',
      event_description: 'Briefing operativo di inizio attività per la fase {task_name} con il team incaricato della commessa {project_code}.',
      event_date_type: 'task_start_date',
      event_days_offset: 0,
      notify_title: '🚀 Fase avviata: {task_name} ({project_code})',
      notify_message: 'È stato registrato l\'avvio delle lavorazioni per la fase {task_name} della commessa {project_code}.',
    };
  }

  if (triggerType === 'phase_progress_reached') {
    return {
      rule_name: 'Avanzamento a soglia % ➔ Meeting SAL Intermedio',
      rule_description: 'Quando la fase raggiunge la percentuale prevista, programma il punto SAL o la verifica con il PM.',
      todo_title: 'Controllo SAL e verifica avanzamento: {task_name} ({project_code})',
      todo_content: 'L\'avanzamento della fase {task_name} ha raggiunto la soglia prevista ({progress}%). Verificare lo stato effettivo delle lavorazioni e aggiornare la pianificazione per {project_name}.',
      assignee_department: 'pm',
      due_days: 2,
      event_title: 'Meeting SAL Intermedio ({progress}%): {task_name} ({project_code})',
      event_description: 'Stato avanzamento lavori e allineamento per la fase {task_name} della commessa {project_code} ({progress}% completato). Verifica rispetto delle milestone.',
      event_date_type: 'today',
      event_days_offset: 1,
      notify_title: '📈 Soglia avanzamento raggiunta: {task_name} ({progress}%)',
      notify_message: 'La fase {task_name} ({project_code}) ha raggiunto il {progress}% di avanzamento. PM: {pm_name}.',
    };
  }

  if (triggerType === 'budget_hours_exceeded') {
    return {
      rule_name: 'Ore oltre budget ➔ Revisione Consuntivo e Costi',
      rule_description: 'Se le ore lavorate superano il budget preventivato, allerta il PM ed analizza gli scostamenti.',
      todo_title: '⚠️ Analisi scostamento ore a consuntivo: {task_name} ({project_code})',
      todo_content: 'La fase {task_name} ha registrato {actual_hours}h su {planned_hours}h di budget previsto ({hours_pct}%). Il reparto {department} deve analizzare gli extra-tempi con il PM {pm_name}.',
      assignee_department: 'pm',
      due_days: 1,
      event_title: 'Audit Costi e Consuntivo Ore: {task_name} ({project_code})',
      event_description: 'Revisione urgente delle ore lavorate e analisi budget con il PM per la fase {task_name} ({hours_pct}% del budget consumato).',
      event_date_type: 'today',
      event_days_offset: 0,
      notify_title: '⏱️ Ore consuntivate oltre budget: {task_name} ({hours_pct}%)',
      notify_message: 'Attenzione: la fase {task_name} ({project_code}) ha registrato {actual_hours}h su {planned_hours}h di budget ({hours_pct}%). Verificare le cause dello scostamento.',
    };
  }

  if (triggerType === 'phase_delayed') {
    return {
      rule_name: 'Fase scaduta non completata ➔ Piano Recupero Urgente',
      rule_description: 'Quando la scadenza è passata senza completamento, genera un\'azione prioritaria di ripristino.',
      todo_title: '🚨 Task Urgente: Piano recupero ritardo {task_name} ({project_code})',
      todo_content: 'La fase {task_name} è oltre la scadenza prevista ({end_date}) ed è attualmente al {progress}%. Richiesto intervento prioritario per evitare penali o ritardi su {project_name}.',
      assignee_department: 'pm',
      due_days: 1,
      event_title: '🚨 Riunione Straordinaria Ritardo: {task_name} ({project_code})',
      event_description: 'Tavolo urgente di coordinamento per superamento data fine della fase {task_name} nella commessa {project_code}. Analisi criticità e riprogrammazione.',
      event_date_type: 'today',
      event_days_offset: 0,
      notify_title: '🚨 Fase Scaduta in Ritardo: {task_name} ({project_code})',
      notify_message: 'Attenzione: la fase {task_name} della commessa {project_code} è scaduta il {end_date} ed è ferma al {progress}%. Intervento urgente richiesto.',
    };
  }

  if (triggerType === 'phase_deadline_approaching') {
    return {
      rule_name: 'Scadenza imminente a rischio ➔ Sollecito Avanzamento',
      rule_description: 'Se la scadenza è vicina e l\'avanzamento è ridotto, invia un promemoria operativo.',
      todo_title: '⏰ Sollecito chiusura fase imminente: {task_name} ({project_code})',
      todo_content: 'La fase {task_name} scade il {end_date} ed è attualmente ferma al {progress}%. Verificare le attività residue per completarla nei tempi previsti per {project_name}.',
      assignee_department: 'pm',
      due_days: 2,
      event_title: 'Check Scadenza Imminente: {task_name} ({project_code})',
      event_description: 'Verifica dello stato di avanzamento e dei vincoli a ridosso della scadenza per la fase {task_name} della commessa {project_code}.',
      event_date_type: 'today',
      event_days_offset: 1,
      notify_title: '⏰ Scadenza fase imminente: {task_name} ({project_code})',
      notify_message: 'La fase {task_name} scade tra pochi giorni ed è ancora al {progress}%. Verificare lo stato dei lavori.',
    };
  }

  return {
    rule_name: 'Nuova Regola di Automazione',
    rule_description: '',
    todo_title: 'Attività operativa per commessa {project_code}',
    todo_content: 'Attività generata dall\'automazione per la fase {task_name} della commessa {project_name}.',
    assignee_department: 'acquisti',
    due_days: 3,
    event_title: 'Evento: {task_name} ({project_code})',
    event_description: 'Promemoria e verifica per la fase {task_name} della commessa {project_code}.',
    event_date_type: 'task_end_date',
    event_days_offset: 0,
    notify_title: 'Notifica automazione: {task_name}',
    notify_message: 'Avviso generato per la fase {task_name} ({project_code}).',
  };
}

const DYNAMIC_VARIABLES = [
  { key: 'project_code', label: 'Codice Commessa', iconName: 'tag', sample: 'COM-2024-042', desc: 'Codice identificativo commessa' },
  { key: 'project_name', label: 'Nome Commessa', iconName: 'briefcase', sample: 'Impianto Packaging', desc: 'Descrizione / titolo commessa' },
  { key: 'task_name', label: 'Nome Fase', iconName: 'gantt', sample: 'Progettazione Meccanica', desc: 'Nome della fase scatenante' },
  { key: 'department', label: 'Reparto Fase', iconName: 'building', sample: 'Ufficio Tecnico', desc: 'Reparto associato alla fase' },
  { key: 'pm_name', label: 'Project Manager', iconName: 'user', sample: 'Mario Rossi', desc: 'PM responsabile commessa' },
  { key: 'progress', label: '% Avanzamento', iconName: 'trendingUp', sample: '65%', desc: 'Percentuale completamento' },
  { key: 'actual_hours', label: 'Ore Consuntivate', iconName: 'clock', sample: '38h', desc: 'Totale ore lavorate effettive' },
  { key: 'planned_hours', label: 'Ore a Budget', iconName: 'target', sample: '40h', desc: 'Ore preventivate da piano' },
  { key: 'hours_pct', label: '% Ore Consuntivo', iconName: 'activity', sample: '95%', desc: 'Rapporto % consuntivo/budget' },
  { key: 'end_date', label: 'Data Fine Prevista', iconName: 'calendar', sample: '25/09/2026', desc: 'Data scadenza programmata' },
  { key: 'start_date', label: 'Data Inizio', iconName: 'calendar', sample: '10/09/2026', desc: 'Data avvio programmata' },
];

const VAR_MAP = DYNAMIC_VARIABLES.reduce((acc, v) => {
  acc[v.key] = v;
  return acc;
}, {});

const LABEL_TO_KEY = {
  'codice commessa': 'project_code',
  'nome commessa': 'project_name',
  'nome fase': 'task_name',
  'reparto fase': 'department',
  'reparto': 'department',
  'project manager': 'pm_name',
  'pm': 'pm_name',
  '% avanzamento': 'progress',
  'avanzamento': 'progress',
  'ore consuntivate': 'actual_hours',
  'ore consuntivo': 'actual_hours',
  'ore a budget': 'planned_hours',
  'budget ore': 'planned_hours',
  '% ore consuntivo': 'hours_pct',
  'data fine prevista': 'end_date',
  'data fine': 'end_date',
  'data inizio': 'start_date',
};

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderTemplateToHtml(text) {
  if (!text) return '';
  const pattern = /\{([a-zA-Z0-9_]+)\}|\[([^\]]+)\]/g;
  let lastIndex = 0;
  let html = '';
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const rawKey = match[1];
    const rawLabel = match[2];
    let key = rawKey;
    if (!key && rawLabel) {
      const cleanedLabel = rawLabel.replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/gu, '').trim().toLowerCase();
      key = LABEL_TO_KEY[cleanedLabel];
    }
    const varMeta = key ? VAR_MAP[key] : null;

    const beforeText = text.substring(lastIndex, match.index);
    html += escapeHtml(beforeText).replace(/\n/g, '<br>');

    if (varMeta) {
      html += `<span class="automation-pill-tag" data-key="${varMeta.key}" contenteditable="false">${varMeta.label}<span class="pill-close-btn" data-remove="${varMeta.key}">&times;</span></span>`;
    } else if (rawKey) {
      html += `{${escapeHtml(rawKey)}}`;
    } else if (rawLabel) {
      html += `[${escapeHtml(rawLabel)}]`;
    }
    lastIndex = pattern.lastIndex;
  }
  const remaining = text.substring(lastIndex);
  html += escapeHtml(remaining).replace(/\n/g, '<br>');
  return html;
}

function serializeContent(node) {
  if (!node) return '';
  let res = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      res += child.textContent.replace(/\u00A0/g, ' ');
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      if (child.classList && child.classList.contains('automation-pill-tag')) {
        const k = child.getAttribute('data-key');
        if (k) res += `{${k}}`;
      } else if (child.tagName === 'BR') {
        res += '\n';
      } else if (child.tagName === 'DIV' || child.tagName === 'P') {
        if (res.length > 0 && !res.endsWith('\n')) {
          res += '\n';
        }
        res += serializeContent(child);
      } else {
        res += serializeContent(child);
      }
    }
  }
  return res;
}

const BadgeEditor = ({
  value = '',
  onChange,
  onFocus,
  active = false,
  activeBorderColor = '#10b981',
  placeholder = '',
  isTextarea = false,
  minHeight,
  style = {},
}) => {
  const editorRef = useRef(null);

  useEffect(() => {
    if (!editorRef.current) return;
    if (!value || value.trim() === '') {
      editorRef.current.innerHTML = '';
      return;
    }
    const currentSerialized = serializeContent(editorRef.current);
    if (currentSerialized.trim() !== value.trim()) {
      editorRef.current.innerHTML = renderTemplateToHtml(value);
    }
  }, [value]);

  const handleInput = () => {
    if (!editorRef.current) return;
    const serialized = serializeContent(editorRef.current);
    onChange(serialized);
  };

  const handleClick = (e) => {
    const removeBtn = e.target.closest('.pill-close-btn');
    if (removeBtn) {
      e.preventDefault();
      e.stopPropagation();
      const pill = removeBtn.closest('.automation-pill-tag');
      if (pill) {
        pill.remove();
        handleInput();
      }
    }
  };

  const handleKeyDown = (e) => {
    if (!isTextarea && e.key === 'Enter') {
      e.preventDefault();
    }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  };

  return (
    <div
      ref={editorRef}
      contentEditable
      suppressContentEditableWarning
      onInput={handleInput}
      onClick={handleClick}
      onFocus={onFocus}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      data-placeholder={placeholder}
      style={{
        width: '100%',
        minHeight: minHeight || (isTextarea ? '72px' : '40px'),
        height: isTextarea ? undefined : '40px',
        padding: isTextarea ? '10px 12px' : '8px 12px',
        borderRadius: '8px',
        border: active ? `2px solid ${activeBorderColor}` : '1px solid var(--border-color)',
        background: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
        fontSize: '13px',
        lineHeight: isTextarea ? '1.5' : '22px',
        outline: 'none',
        overflowY: isTextarea ? 'auto' : 'hidden',
        wordBreak: 'break-word',
        whiteSpace: isTextarea ? 'pre-wrap' : 'nowrap',
        cursor: 'text',
        boxSizing: 'border-box',
        ...style,
      }}
    />
  );
};

const PRESET_TEMPLATES = [
  {
    title: 'Progettazione UT ➔ TODO Acquisti',
    iconName: 'package',
    badge: 'Passaggio consegne',
    name: 'Progettazione UT completata ➔ Ordine Materiali (Acquisti)',
    trigger_type: 'phase_completed',
    department: 'ufficio_tecnico',
    action_type: 'create_todo',
    todo_title: 'Ordinare materiali e componenti commessa {project_code}',
    todo_content: 'La fase "{task_name}" dell\'Ufficio Tecnico è completata al 100%. Procedere con l\'ordine dei componenti per {project_name}.',
    assignee_department: 'acquisti',
    due_days: 3,
    description: 'Genera automaticamente un TODO per il Reparto Acquisti a completamento progettazione.',
  },
  {
    title: 'Consuntivo > 90% ➔ Alert PM',
    iconName: 'clock',
    badge: 'Controllo costi',
    name: 'Superamento 90% ore a budget ➔ Allerta PM',
    trigger_type: 'budget_hours_exceeded',
    threshold_pct: 90,
    department: '',
    action_type: 'send_notification',
    notify_title: 'Alert Budget {hours_pct}%: {task_name}',
    notify_message: 'La fase "{task_name}" ({project_code}) ha raggiunto {actual_hours}h su {planned_hours}h di budget ({hours_pct}%). Avanzamento attuale: {progress}%.',
    recipient_role: 'pm',
    description: 'Invia notifica di controllo al Project Manager quando le ore consuntivate sfiorano il budget.',
  },
  {
    title: 'Fase Scaduta ➔ TODO Urgente PM',
    iconName: 'alertTriangle',
    badge: 'Recupero ritardi',
    name: 'Fase oltre data fine ➔ Task Urgente PM',
    trigger_type: 'phase_delayed',
    department: '',
    action_type: 'create_todo',
    todo_title: 'Task Urgente: Piano recupero ritardo {task_name} ({project_code})',
    todo_content: 'La fase "{task_name}" è oltre la scadenza del {end_date} con avanzamento al {progress}%. Coordinare intervento urgente.',
    assignee_department: 'pm',
    due_days: 1,
    description: 'Attiva un task operativo prioritario per il PM quando una fase supera la data di fine.',
  },
  {
    title: 'Inizio Produzione ➔ Check Kit Materiali',
    iconName: 'play',
    badge: 'Avvio reparto',
    name: 'Inizio lavori Produzione ➔ Check Kit Magazzino',
    trigger_type: 'phase_started',
    department: 'produzione',
    action_type: 'create_todo',
    todo_title: 'Verifica arrivo kit e materiali per {task_name} ({project_code})',
    todo_content: 'La fase "{task_name}" in Produzione è stata avviata. Verificare che tutti i materiali e disegni siano presenti sulla linea.',
    assignee_department: 'produzione',
    due_days: 1,
    description: 'Appena la produzione avvia la fase, crea il task di controllo kit materiali a terra.',
  },
  {
    title: 'SAL 50% Raggiunto ➔ Notifica Fatturazione',
    iconName: 'trendingUp',
    badge: 'Stato avanzamento',
    name: 'Raggiunto 50% avanzamento ➔ Notifica SAL Amministrazione',
    trigger_type: 'phase_progress_reached',
    target_progress: 50,
    department: '',
    action_type: 'send_notification',
    notify_title: 'SAL 50% completato per {project_code}',
    notify_message: 'La fase "{task_name}" della commessa {project_code} ({project_name}) ha superato il 50% di avanzamento.',
    recipient_role: 'pm',
    description: 'Segnala il completamento di metà commessa per eventuale emissione SAL o verifica commerciale.',
  },
  {
    title: 'Scadenza tra 48h con < 50% ➔ Alert Critico',
    iconName: 'clock',
    badge: 'Early warning',
    name: 'Scadenza imminente con avanzamento ridotto (< 50%)',
    trigger_type: 'phase_deadline_approaching',
    days_before: 2,
    max_progress: 50,
    department: '',
    action_type: 'send_notification',
    notify_title: 'Scadenza imminente tra 48h: {task_name}',
    notify_message: 'La fase "{task_name}" ({project_code}) scade tra 2 giorni ed è ancora al {progress}%. Intervenire per evitare ritardi.',
    recipient_role: 'pm_and_workers',
    description: 'Monitora le scadenze vicine e allerta team e PM se l\'avanzamento è troppo basso.',
  },
  {
    title: 'Fine Fase ➔ Inserisci Collaudo nel Calendario',
    iconName: 'calendar',
    badge: 'Evento Calendario',
    name: 'Fase completata ➔ Evento di Collaudo nel Calendario',
    trigger_type: 'phase_completed',
    department: '',
    action_type: 'create_calendar_event',
    event_title: 'Collaudo / Revisione: {task_name} ({project_code})',
    event_description: 'Riunione e collaudo finale per la fase {task_name} della commessa {project_code}. Verificare conformità e documenti di consegna.',
    event_date_type: 'task_end_date',
    event_days_offset: 0,
    event_color: '#10b981',
    calendar_attendees: 'pm_and_workers',
    calendar_attendee_ids: [],
    notify_attendees: true,
    description: 'Inserisce automaticamente un evento di verifica e collaudo nel calendario aziendale al completamento della fase.',
  },
];

function WorkerMultiSelect({
  selected = [],
  onChange,
  users = [],
  valueKey = 'username',
  title = 'Seleziona addetti:',
  accentColor = '#f59e0b',
}) {
  const [searchTerm, setSearchTerm] = useState('');

  const safeSelected = Array.isArray(selected) ? selected : [];
  const safeUsers = Array.isArray(users) ? users : [];

  const filteredUsers = safeUsers.filter((u) => {
    if (u.is_active === false) return false;
    if (!searchTerm.trim()) return true;
    const s = searchTerm.toLowerCase();
    return (
      (u.full_name || '').toLowerCase().includes(s) ||
      (u.username || '').toLowerCase().includes(s) ||
      (u.department || '').toLowerCase().includes(s)
    );
  });

  const toggleUser = (val) => {
    if (safeSelected.includes(val)) {
      onChange(safeSelected.filter((item) => item !== val));
    } else {
      onChange([...safeSelected, val]);
    }
  };

  const selectAll = () => {
    const allVals = filteredUsers.map((u) => u[valueKey]);
    const merged = Array.from(new Set([...safeSelected, ...allVals]));
    onChange(merged);
  };

  const deselectAll = () => {
    const removeSet = new Set(filteredUsers.map((u) => u[valueKey]));
    onChange(safeSelected.filter((v) => !removeSet.has(v)));
  };

  return (
    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <AppIcon name="users" size={13} style={{ color: accentColor }} />
          <span style={{ fontSize: '12px', fontWeight: '700', color: 'var(--text-primary)' }}>{title}</span>
          <span style={{ fontSize: '11px', background: `${accentColor}20`, color: accentColor, padding: '2px 8px', borderRadius: '12px', fontWeight: '700' }}>
            {safeSelected.length} selezionat{safeSelected.length === 1 ? 'o' : 'i'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            type="button"
            onClick={selectAll}
            style={{ fontSize: '11px', padding: '3px 8px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-secondary)', cursor: 'pointer' }}
          >
            Seleziona tutti
          </button>
          {safeSelected.length > 0 && (
            <button
              type="button"
              onClick={deselectAll}
              style={{ fontSize: '11px', padding: '3px 8px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--color-danger, #dc2626)', cursor: 'pointer' }}
            >
              Deseleziona tutti
            </button>
          )}
        </div>
      </div>

      {/* Barra di ricerca rapida */}
      <div style={{ marginBottom: '10px' }}>
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="🔍 Cerca per nome, reparto o username..."
          style={{ width: '100%', height: '36px', padding: '0 12px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '12px', boxSizing: 'border-box' }}
        />
      </div>

      {/* Griglia chip addetti */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '6px', maxHeight: '180px', overflowY: 'auto', paddingRight: '4px' }}>
        {filteredUsers.map((u) => {
          const val = u[valueKey];
          const isSelected = safeSelected.includes(val);
          const deptLabel = DEPARTMENT_LABELS[u.department] || u.department;
          return (
            <button
              key={u.id || u.username}
              type="button"
              onClick={() => toggleUser(val)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 10px',
                borderRadius: '8px',
                border: isSelected ? `2px solid ${accentColor}` : '1px solid var(--border-color)',
                background: isSelected ? `${accentColor}12` : 'var(--bg-primary)',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.15s ease',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                <div style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  background: isSelected ? accentColor : 'var(--bg-secondary)',
                  color: isSelected ? '#fff' : 'var(--text-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '11px',
                  fontWeight: '700',
                  flexShrink: 0
                }}>
                  {(u.full_name || u.username || '?')[0].toUpperCase()}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '12px', fontWeight: isSelected ? '700' : '600', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {u.full_name || u.username}
                  </div>
                  {deptLabel && (
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                      {deptLabel}
                    </div>
                  )}
                </div>
              </div>
              <span style={{ fontSize: '13px', fontWeight: '800', color: isSelected ? accentColor : 'var(--text-muted)', marginLeft: '6px' }}>
                {isSelected ? '✓' : '+'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function AutomationsPage() {
  const { user } = useAuth();
  const { addToast } = useToast();

  const [rules, setRules] = useState([]);
  const [logs, setLogs] = useState([]);
  const [usersList, setUsersList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('rules'); // rules | logs
  const [filterDept, setFilterDept] = useState('all');

  // Modal State
  const [showModal, setShowModal] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [activeField, setActiveField] = useState('todo_content');
  const initialSmartDefaults = getSmartContentDefaults('phase_completed', '', 'create_todo');
  const [formData, setFormData] = useState({
    name: initialSmartDefaults.rule_name,
    description: initialSmartDefaults.rule_description,
    trigger_type: 'phase_completed',
    threshold_pct: 90,
    days_before: 2,
    max_progress: 50,
    target_progress: 50,
    department: '',
    selected_workers: [],
    action_type: 'create_todo',
    todo_title: initialSmartDefaults.todo_title,
    todo_content: initialSmartDefaults.todo_content,
    assignee_department: initialSmartDefaults.assignee_department || 'acquisti',
    assignee_ids: [],
    due_days: initialSmartDefaults.due_days ?? 3,
    notify_title: initialSmartDefaults.notify_title,
    notify_message: initialSmartDefaults.notify_message,
    recipient_role: 'pm',
    recipient_ids: [],
    event_title: initialSmartDefaults.event_title,
    event_description: initialSmartDefaults.event_description,
    event_date_type: initialSmartDefaults.event_date_type || 'task_end_date',
    event_days_offset: initialSmartDefaults.event_days_offset ?? 0,
    event_color: '#10b981',
    event_all_day: true,
    calendar_attendees: 'pm_and_workers',
    calendar_attendee_ids: [],
    notify_attendees: true,
    is_active: true,
  });

  const canManage = user?.role === 'admin' || user?.role === 'editor';

  const fetchRules = async () => {
    try {
      const res = await api.get('/automations/rules');
      setRules(res.data);
    } catch (err) {
      console.error('Errore caricamento regole:', err);
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await api.get('/automations/logs?limit=40');
      setLogs(res.data);
    } catch (err) {
      console.error('Errore caricamento log:', err);
    }
  };

  const loadData = async () => {
    setLoading(true);
    await Promise.all([
      fetchRules(),
      fetchLogs(),
      api.get('/users').then((res) => {
        if (Array.isArray(res.data)) setUsersList(res.data);
      }).catch(() => { }),
    ]);
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleToggle = async (ruleId) => {
    if (!canManage) return;
    try {
      const res = await api.patch(`/automations/rules/${ruleId}/toggle`);
      const updated = res.data;
      setRules((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      addToast(
        updated.is_active ? 'Regola attivata con successo' : 'Regola disattivata',
        'success'
      );
    } catch (err) {
      addToast('Errore durante il cambio stato', 'error');
    }
  };

  const handleDelete = async (ruleId) => {
    if (!canManage) return;
    if (!window.confirm('Sei sicuro di voler eliminare questa regola di automazione?')) return;
    try {
      await api.delete(`/automations/rules/${ruleId}`);
      setRules((prev) => prev.filter((r) => r.id !== ruleId));
      addToast('Regola eliminata con successo', 'success');
    } catch (err) {
      addToast('Errore durante l\'eliminazione', 'error');
    }
  };

  const applySmartDefaults = (trigger = formData.trigger_type, dept = formData.department, action = formData.action_type) => {
    const smart = getSmartContentDefaults(trigger, dept, action);
    const autoColor = TRIGGER_DEFAULT_COLORS[trigger] || '#10b981';
    setFormData((prev) => ({
      ...prev,
      name: smart.rule_name,
      description: smart.rule_description,
      todo_title: smart.todo_title,
      todo_content: smart.todo_content,
      event_title: smart.event_title,
      event_description: smart.event_description,
      notify_title: smart.notify_title,
      notify_message: smart.notify_message,
      event_color: autoColor,
      assignee_department: smart.assignee_department || prev.assignee_department,
      due_days: smart.due_days ?? prev.due_days,
      event_date_type: smart.event_date_type || prev.event_date_type,
      event_days_offset: smart.event_days_offset ?? prev.event_days_offset,
    }));
    addToast('Titoli e parametri precompilati in base a Quando/Se/Allora', 'info');
  };

  const openCreateModal = () => {
    setEditingRule(null);
    setActiveField('todo_content');
    const smart = getSmartContentDefaults('phase_completed', '', 'create_todo');
    setFormData({
      name: smart.rule_name,
      description: smart.rule_description,
      trigger_type: 'phase_completed',
      threshold_pct: 90,
      days_before: 2,
      max_progress: 50,
      target_progress: 50,
      department: '',
      selected_workers: [],
      action_type: 'create_todo',
      todo_title: smart.todo_title,
      todo_content: smart.todo_content,
      assignee_department: smart.assignee_department || 'acquisti',
      assignee_ids: [],
      due_days: smart.due_days ?? 3,
      notify_title: smart.notify_title,
      notify_message: smart.notify_message,
      recipient_role: 'pm',
      recipient_ids: [],
      event_title: smart.event_title,
      event_description: smart.event_description,
      event_date_type: smart.event_date_type || 'task_end_date',
      event_days_offset: smart.event_days_offset ?? 0,
      event_color: TRIGGER_DEFAULT_COLORS['phase_completed'] || '#10b981',
      event_all_day: true,
      calendar_attendees: 'pm_and_workers',
      calendar_attendee_ids: [],
      notify_attendees: true,
      is_active: true,
    });
    setShowModal(true);
  };

  const openEditModal = (rule) => {
    setEditingRule(rule);
    const tCfg = rule.trigger_config || {};
    const conds = rule.conditions || {};
    const aCfg = rule.action_config || {};

    if (rule.action_type === 'create_calendar_event') {
      setActiveField('event_title');
    } else if (rule.action_type === 'send_notification') {
      setActiveField('notify_message');
    } else {
      setActiveField('todo_content');
    }

    setFormData({
      name: rule.name || '',
      description: rule.description || '',
      trigger_type: rule.trigger_type || 'phase_completed',
      threshold_pct: tCfg.threshold_pct ?? 90,
      days_before: tCfg.days_before ?? 2,
      max_progress: tCfg.max_progress ?? 50,
      target_progress: tCfg.target_progress ?? 50,
      department: conds.department || (conds.workers?.length ? 'specific_workers' : ''),
      selected_workers: conds.workers || conds.assigned_workers || [],
      action_type: rule.action_type || 'create_todo',
      todo_title: aCfg.title || '',
      todo_content: aCfg.content || '',
      assignee_department: aCfg.assignee_department || (aCfg.assignee_ids?.length ? 'specific_workers' : 'acquisti'),
      assignee_ids: aCfg.assignee_ids || [],
      due_days: aCfg.due_days ?? 3,
      notify_title: aCfg.notify_title || aCfg.title || '',
      notify_message: aCfg.notify_message || aCfg.message || '',
      recipient_role: aCfg.recipient_role || (aCfg.recipient_ids?.length ? 'specific_workers' : 'pm'),
      recipient_ids: aCfg.recipient_ids || [],
      event_title: aCfg.event_title || aCfg.title || 'Collaudo / Revisione: {task_name} ({project_code})',
      event_description: aCfg.event_description || aCfg.description || 'Lavorazione completata per la fase {task_name} della commessa {project_code}.',
      event_date_type: aCfg.event_date_type || 'task_end_date',
      event_days_offset: aCfg.event_days_offset ?? 0,
      event_color: aCfg.event_color || '#0284c7',
      event_all_day: aCfg.event_all_day ?? true,
      calendar_attendees: aCfg.calendar_attendees || (aCfg.attendee_ids?.length ? 'specific_workers' : 'pm_and_workers'),
      calendar_attendee_ids: aCfg.attendee_ids || [],
      notify_attendees: aCfg.notify_attendees ?? true,
      is_active: rule.is_active,
    });
    setShowModal(true);
  };

  const applyPreset = (preset) => {
    setFormData((prev) => ({
      ...prev,
      name: preset.name,
      description: preset.description || '',
      trigger_type: preset.trigger_type,
      threshold_pct: preset.threshold_pct ?? 90,
      days_before: preset.days_before ?? 2,
      max_progress: preset.max_progress ?? 50,
      target_progress: preset.target_progress ?? 50,
      department: preset.department ?? '',
      selected_workers: [],
      action_type: preset.action_type,
      todo_title: preset.todo_title || prev.todo_title,
      todo_content: preset.todo_content || prev.todo_content,
      assignee_department: preset.assignee_department || prev.assignee_department,
      assignee_ids: [],
      due_days: preset.due_days ?? prev.due_days,
      notify_title: preset.notify_title || prev.notify_title,
      notify_message: preset.notify_message || prev.notify_message,
      recipient_role: preset.recipient_role || prev.recipient_role,
      recipient_ids: [],
      event_title: preset.event_title || prev.event_title,
      event_description: preset.event_description || prev.event_description,
      event_date_type: preset.event_date_type || prev.event_date_type,
      event_days_offset: preset.event_days_offset ?? prev.event_days_offset,
      event_color: preset.event_color || TRIGGER_DEFAULT_COLORS[preset.trigger_type] || prev.event_color,
      event_all_day: preset.event_all_day ?? prev.event_all_day,
      calendar_attendees: preset.calendar_attendees || prev.calendar_attendees,
      calendar_attendee_ids: preset.calendar_attendee_ids || [],
      notify_attendees: preset.notify_attendees ?? prev.notify_attendees,
    }));
    if (preset.action_type === 'create_calendar_event') {
      setActiveField('event_title');
    } else if (preset.action_type === 'send_notification') {
      setActiveField('notify_message');
    } else {
      setActiveField('todo_content');
    }
    addToast(`Scenario applicato: ${preset.name}`, 'info');
  };

  const handleSaveModal = async (e) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      addToast('Inserisci un nome per la regola', 'error');
      return;
    }

    // Costruisci configurazioni JSON
    const trigger_config = {};
    if (formData.trigger_type === 'budget_hours_exceeded') {
      trigger_config.threshold_pct = Number(formData.threshold_pct);
    } else if (formData.trigger_type === 'phase_deadline_approaching') {
      trigger_config.days_before = Number(formData.days_before);
      trigger_config.max_progress = Number(formData.max_progress);
    } else if (formData.trigger_type === 'phase_progress_reached') {
      trigger_config.target_progress = Number(formData.target_progress || 50);
    }

    const conditions = {};
    if (formData.department) {
      conditions.department = formData.department;
    }
    if (formData.department === 'specific_workers' || (formData.selected_workers && formData.selected_workers.length > 0)) {
      conditions.department = 'specific_workers';
      conditions.workers = formData.selected_workers || [];
    }

    const action_config = {};
    if (formData.action_type === 'create_todo' || formData.action_type === 'create_todo_and_notify') {
      action_config.title = formData.todo_title;
      action_config.content = formData.todo_content;
      action_config.assignee_department = formData.assignee_department;
      action_config.due_days = Number(formData.due_days);
      if (formData.assignee_department === 'specific_workers') {
        action_config.assignee_ids = formData.assignee_ids || [];
      }
    }
    if (formData.action_type === 'send_notification' || formData.action_type === 'create_todo_and_notify') {
      action_config.notify_title = formData.notify_title;
      action_config.notify_message = formData.notify_message;
      action_config.recipient_role = formData.recipient_role;
      if (formData.recipient_role === 'specific_workers') {
        action_config.recipient_ids = formData.recipient_ids || [];
      }
    }
    if (formData.action_type === 'create_calendar_event') {
      action_config.event_title = formData.event_title;
      action_config.event_description = formData.event_description;
      action_config.event_date_type = formData.event_date_type;
      action_config.event_days_offset = Number(formData.event_days_offset || 0);
      action_config.event_color = formData.event_color;
      action_config.event_all_day = formData.event_all_day;
      action_config.calendar_attendees = formData.calendar_attendees;
      if (formData.calendar_attendees === 'specific_workers') {
        action_config.attendee_ids = formData.calendar_attendee_ids || [];
      }
      action_config.notify_attendees = formData.notify_attendees;
    }

    const payload = {
      name: formData.name,
      description: formData.description,
      trigger_type: formData.trigger_type,
      trigger_config,
      conditions,
      action_type: formData.action_type,
      action_config,
      is_active: formData.is_active,
    };

    try {
      if (editingRule) {
        await api.put(`/automations/rules/${editingRule.id}`, payload);
        addToast('Regola modificata con successo', 'success');
      } else {
        await api.post('/automations/rules', payload);
        addToast('Nuova regola creata con successo', 'success');
      }
      setShowModal(false);
      fetchRules();
    } catch (err) {
      console.error(err);
      addToast(err?.response?.data?.detail || 'Errore salvataggio regola', 'error');
    }
  };

  const insertVariable = (variableKey) => {
    const targetField = activeField || (formData.action_type === 'send_notification' ? 'notify_message' : 'todo_content');
    const varMeta = DYNAMIC_VARIABLES.find(v => v.key === variableKey);
    setFormData((prev) => {
      const currentVal = (prev[targetField] || '').trim();
      return {
        ...prev,
        [targetField]: currentVal ? `${currentVal} {${variableKey}} ` : `{${variableKey}} `,
      };
    });
    addToast(`Etichetta "${varMeta?.label || variableKey}" inserita nel testo`, 'info');
  };

  const previewValues = useMemo(() => {
    const sampleData = {
      project_code: 'COM-2024-042',
      project_name: 'Impianto Packaging Bobine',
      task_name: 'Progettazione Meccanica',
      department: DEPARTMENT_LABELS[formData.department] || 'Ufficio Tecnico',
      pm_name: 'Mario Rossi (PM)',
      actual_hours: '38h',
      planned_hours: '40h',
      hours_pct: `${formData.threshold_pct || 90}%`,
      progress: `${formData.target_progress || 100}%`,
      end_date: '25/09/2026',
      start_date: '10/09/2026',
    };

    const labelMap = {
      'codice commessa': sampleData.project_code,
      'nome commessa': sampleData.project_name,
      'nome fase': sampleData.task_name,
      'reparto fase': sampleData.department,
      'reparto': sampleData.department,
      'project manager': sampleData.pm_name,
      'pm': sampleData.pm_name,
      '% avanzamento': sampleData.progress,
      'avanzamento': sampleData.progress,
      'ore consuntivate': sampleData.actual_hours,
      'ore consuntivo': sampleData.actual_hours,
      'ore a budget': sampleData.planned_hours,
      'budget ore': sampleData.planned_hours,
      '% ore consuntivo': sampleData.hours_pct,
      'data fine prevista': sampleData.end_date,
      'data fine': sampleData.end_date,
      'data inizio': sampleData.start_date,
    };

    const replaceVars = (text) => {
      if (!text) return '';
      let res = text;
      Object.entries(sampleData).forEach(([k, v]) => {
        res = res.replaceAll(`{${k}}`, v);
      });
      Object.entries(labelMap).forEach(([lbl, val]) => {
        res = res.replace(new RegExp(`\\[${lbl}\\]`, 'gi'), val);
      });
      return res;
    };

    return {
      todo_title: replaceVars(formData.todo_title),
      todo_content: replaceVars(formData.todo_content),
      notify_title: replaceVars(formData.notify_title),
      notify_message: replaceVars(formData.notify_message),
      event_title: replaceVars(formData.event_title),
      event_description: replaceVars(formData.event_description),
    };
  }, [formData]);

  const filteredRules = useMemo(() => {
    return rules.filter((r) => {
      if (filterDept !== 'all') {
        const rDept = r.conditions?.department;
        if (rDept !== filterDept) return false;
      }
      return true;
    });
  }, [rules, filterDept]);

  const stats = useMemo(() => {
    const activeCount = rules.filter((r) => r.is_active).length;
    const totalTriggers = rules.reduce((sum, r) => sum + (r.trigger_count || 0), 0);
    return { activeCount, totalTriggers, totalRules: rules.length };
  }, [rules]);

  return (
    <div className="automations-page" style={{ padding: '24px', maxWidth: '1400px', margin: '0 auto' }}>
      <style>{`
        @keyframes automationsPulseRadar {
          0% {
            box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
          }
          70% {
            box-shadow: 0 0 0 9px rgba(16, 185, 129, 0);
          }
          100% {
            box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
          }
        }
        .automation-kpi-card {
          transition: transform 0.22s ease, box-shadow 0.22s ease, border-color 0.22s ease;
        }
        .automation-kpi-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.06);
        }
        .automation-rule-card {
          transition: transform 0.22s ease, box-shadow 0.22s ease, border-color 0.22s ease;
        }
        .automation-rule-card:hover {
          transform: translateY(-3px);
          box-shadow: 0 12px 28px rgba(0, 0, 0, 0.08);
        }
        .automation-action-btn {
          transition: all 0.16s ease;
        }
        .automation-action-btn:hover {
          transform: translateY(-1px);
        }
        .automation-table-row {
          transition: background-color 0.15s ease;
        }
        .automation-table-row:hover {
          background-color: var(--bg-hover, rgba(0, 0, 0, 0.025)) !important;
        }
      `}</style>

      {/* Action Bar & Subtitle (senza duplicare il titolo 'Automazioni Senza Codice' già presente nel layout) */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '22px',
          flexWrap: 'wrap',
          gap: '16px',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-color)',
          borderRadius: '14px',
          padding: '16px 22px',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.02)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
          <div
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '12px',
              background: 'linear-gradient(135deg, rgba(8, 127, 186, 0.15), rgba(37, 111, 197, 0.12))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-accent, #087fba)',
              border: '1px solid rgba(8, 127, 186, 0.25)',
              flexShrink: 0,
            }}
          >
            <AppIcon name="zap" size={22} />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '15.5px', fontWeight: '700', color: 'var(--text-primary)' }}>
                Regole Automatiche
              </span>
              <span
                style={{
                  fontSize: '11px',
                  background: 'rgba(16, 185, 129, 0.12)',
                  color: '#10b981',
                  padding: '2px 8px',
                  borderRadius: '12px',
                  fontWeight: '700',
                  letterSpacing: '0.4px',
                }}
              >
                ● REAL-TIME ENGINE
              </span>
            </div>
            <p style={{ color: 'var(--text-secondary)', margin: '3px 0 0 0', fontSize: '13.5px', lineHeight: 1.4 }}>
              Configura passaggi di consegna automatici tra reparti: creazione TODO, notifiche ai PM e scadenze a calendario.
            </p>
          </div>
        </div>

        {canManage && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              onClick={openCreateModal}
              className="btn btn-primary"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '10px 20px',
                borderRadius: '10px',
                fontWeight: '700',
                fontSize: '13.5px',
                background: 'linear-gradient(135deg, #0797d3 0%, #087fba 100%)',
                color: '#fff',
                border: 'none',
                cursor: 'pointer',
                boxShadow: '0 4px 14px rgba(7, 151, 211, 0.28)',
                transition: 'all 0.2s',
              }}
            >
              <AppIcon name="plus" size={15} />
              <span>Nuova Regola</span>
            </button>
          </div>
        )}
      </div>

      {/* KPI Stats Bar */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '16px',
          marginBottom: '26px',
        }}
      >
        {/* Card 1: Regole Attive */}
        <div
          className="automation-kpi-card"
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            borderRadius: '14px',
            padding: '18px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              width: '4px'
            }}
          />
          <div
            style={{
              width: '46px',
              height: '46px',
              borderRadius: '12px',
              background: 'rgba(16, 185, 129, 0.12)',
              border: '1px solid rgba(16, 185, 129, 0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#10b981',
              flexShrink: 0,
            }}
          >
            <AppIcon name="zap" size={22} />
          </div>
          <div>
            <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
              Regole Attive
            </div>
            <div style={{ fontSize: '24px', fontWeight: '800', color: 'var(--text-primary)', lineHeight: 1.2, marginTop: '2px' }}>
              {stats.activeCount}{' '}
              <span style={{ fontSize: '14px', color: 'var(--text-secondary)', fontWeight: '500' }}>
                / {stats.totalRules}
              </span>
            </div>
            <div style={{ fontSize: '11px', color: '#10b981', fontWeight: '600', marginTop: '2px' }}>
              {stats.activeCount > 0 ? `${stats.activeCount} in monitoraggio` : 'Nessuna attiva'}
            </div>
          </div>
        </div>

        {/* Card 2: Esecuzioni Totali */}
        <div
          className="automation-kpi-card"
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            borderRadius: '14px',
            padding: '18px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              width: '4px'
            }}
          />
          <div
            style={{
              width: '46px',
              height: '46px',
              borderRadius: '12px',
              background: 'rgba(2, 132, 199, 0.12)',
              border: '1px solid rgba(2, 132, 199, 0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#0284c7',
              flexShrink: 0,
            }}
          >
            <AppIcon name="target" size={22} />
          </div>
          <div>
            <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
              Esecuzioni Totali
            </div>
            <div style={{ fontSize: '24px', fontWeight: '800', color: '#0284c7', lineHeight: 1.2, marginTop: '2px' }}>
              {stats.totalTriggers}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '500', marginTop: '2px' }}>
              Trigger scattati finora
            </div>
          </div>
        </div>

        {/* Card 3: Log Recenti */}
        <div
          className="automation-kpi-card"
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            borderRadius: '14px',
            padding: '18px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              width: '4px'
            }}
          />
          <div
            style={{
              width: '46px',
              height: '46px',
              borderRadius: '12px',
              background: 'rgba(139, 92, 246, 0.12)',
              border: '1px solid rgba(139, 92, 246, 0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#8b5cf6',
              flexShrink: 0,
            }}
          >
            <AppIcon name="fileText" size={22} />
          </div>
          <div>
            <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
              Registro Eventi
            </div>
            <div style={{ fontSize: '24px', fontWeight: '800', color: 'var(--text-primary)', lineHeight: 1.2, marginTop: '2px' }}>
              {logs.length}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '500', marginTop: '2px' }}>
              Attività archiviate
            </div>
          </div>
        </div>

        {/* Card 4: Stato Motore */}
        <div
          className="automation-kpi-card"
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            borderRadius: '14px',
            padding: '18px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              width: '4px'
            }}
          />
          <div
            style={{
              width: '46px',
              height: '46px',
              borderRadius: '12px',
              background: 'rgba(16, 185, 129, 0.12)',
              border: '1px solid rgba(16, 185, 129, 0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: '13px',
                height: '13px',
                borderRadius: '50%',
                backgroundColor: '#10b981',
                animation: 'automationsPulseRadar 2s infinite',
              }}
            />
          </div>
          <div>
            <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
              Stato
            </div>
            <div style={{ fontSize: '15px', fontWeight: '700', color: '#10b981', lineHeight: 1.2, marginTop: '2px' }}>
              Operativo in background
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '500', marginTop: '2px' }}>
              Polling & trigger attivi
            </div>
          </div>
        </div>
      </div>

      {/* Tabs & Controls */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '24px',
          flexWrap: 'wrap',
          gap: '14px',
        }}
      >
        {/* Segmented Control Pill Container */}
        <div
          style={{
            background: 'var(--bg-tertiary, #eef3f8)',
            padding: '4px',
            borderRadius: '12px',
            display: 'inline-flex',
            gap: '4px',
            border: '1px solid var(--border-color)',
          }}
        >
          <button
            onClick={() => setActiveTab('rules')}
            style={{
              padding: '8px 18px',
              borderRadius: '9px',
              fontWeight: activeTab === 'rules' ? '700' : '500',
              fontSize: '13.5px',
              border: 'none',
              cursor: 'pointer',
              background: activeTab === 'rules' ? 'var(--bg-secondary)' : 'transparent',
              color: activeTab === 'rules' ? 'var(--text-primary)' : 'var(--text-secondary)',
              boxShadow: activeTab === 'rules' ? '0 2px 8px rgba(0, 0, 0, 0.08)' : 'none',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              transition: 'all 0.18s ease',
            }}
          >
            <AppIcon name="zap" size={15} style={{ color: activeTab === 'rules' ? '#087fba' : 'inherit' }} />
            <span>Regole Configurate</span>
            <span
              style={{
                fontSize: '11px',
                padding: '1px 7px',
                borderRadius: '10px',
                background: activeTab === 'rules' ? 'var(--primary-color, #087fba)' : 'rgba(0,0,0,0.06)',
                color: activeTab === 'rules' ? '#fff' : 'var(--text-secondary)',
                fontWeight: '700',
              }}
            >
              {rules.length}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('logs')}
            style={{
              padding: '8px 18px',
              borderRadius: '9px',
              fontWeight: activeTab === 'logs' ? '700' : '500',
              fontSize: '13.5px',
              border: 'none',
              cursor: 'pointer',
              background: activeTab === 'logs' ? 'var(--bg-secondary)' : 'transparent',
              color: activeTab === 'logs' ? 'var(--text-primary)' : 'var(--text-secondary)',
              boxShadow: activeTab === 'logs' ? '0 2px 8px rgba(0, 0, 0, 0.08)' : 'none',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              transition: 'all 0.18s ease',
            }}
          >
            <AppIcon name="fileText" size={15} style={{ color: activeTab === 'logs' ? '#087fba' : 'inherit' }} />
            <span>Registro Esecuzioni</span>
            <span
              style={{
                fontSize: '11px',
                padding: '1px 7px',
                borderRadius: '10px',
                background: activeTab === 'logs' ? 'var(--primary-color, #087fba)' : 'rgba(0,0,0,0.06)',
                color: activeTab === 'logs' ? '#fff' : 'var(--text-secondary)',
                fontWeight: '700',
              }}
            >
              {logs.length}
            </span>
          </button>
        </div>

        {/* Filter on Department */}
        {activeTab === 'rules' && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: '10px',
              padding: '5px 12px',
              boxShadow: '0 1px 4px rgba(0,0,0,0.02)',
            }}
          >
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <AppIcon name="filter" size={14} />
              <span>Filtra reparto:</span>
            </span>
            <select
              value={filterDept}
              onChange={(e) => setFilterDept(e.target.value)}
              style={{
                padding: '5px 10px',
                borderRadius: '6px',
                background: 'var(--bg-tertiary, #f8fafc)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                fontSize: '13px',
                fontWeight: '600',
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              <option value="all">Tutti i reparti</option>
              <option value="ufficio_tecnico">Ufficio Tecnico</option>
              <option value="produzione">Produzione</option>
              <option value="acquisti">Acquisti</option>
              <option value="commerciale">Commerciale</option>
              <option value="amministrazione">Amministrazione</option>
            </select>
          </div>
        )}
      </div>

      {/* Rules Tab */}
      {activeTab === 'rules' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(390px, 1fr))', gap: '22px' }}>
          {loading ? (
            <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>
              Caricamento regole in corso...
            </div>
          ) : filteredRules.length === 0 ? (
            <div
              style={{
                gridColumn: '1 / -1',
                textAlign: 'center',
                padding: '48px 24px',
                background: 'var(--bg-secondary)',
                borderRadius: '16px',
                border: '1px dashed var(--border-color)',
              }}
            >
              <div style={{ marginBottom: '10px', display: 'flex', justifyContent: 'center' }}>
                <AppIcon name="settings" size={38} style={{ color: 'var(--text-muted)' }} />
              </div>
              <div style={{ fontSize: '17px', fontWeight: '700', color: 'var(--text-primary)' }}>Nessuna regola configurata</div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '13.5px', margin: '6px 0 20px 0' }}>
                Crea la tua prima regola "Se/Allora" per automatizzare i passaggi di consegna tra reparti.
              </p>
              {canManage && (
                <button
                  onClick={openCreateModal}
                  className="btn btn-primary"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '10px 20px',
                    fontSize: '13.5px',
                    borderRadius: '10px',
                    fontWeight: '600',
                  }}
                >
                  <AppIcon name="plus" size={15} />
                  <span>Crea Nuova Regola</span>
                </button>
              )}
            </div>
          ) : (
            filteredRules.map((rule) => {
              const triggerMeta = TRIGGER_LABELS[rule.trigger_type] || { label: rule.trigger_type, iconName: 'zap', color: '#64748b' };
              const actionMeta = ACTION_LABELS[rule.action_type] || { label: rule.action_type, iconName: 'todo', color: '#64748b' };
              const deptKey = rule.conditions?.department;
              const workersList = rule.conditions?.workers || rule.conditions?.assigned_workers || [];
              let deptLabel = 'Tutti i reparti';
              let deptIconName = 'building';
              if (deptKey === 'specific_workers' || workersList.length > 0) {
                deptLabel = `${workersList.length} addett${workersList.length === 1 ? 'o' : 'i'} specific${workersList.length === 1 ? 'o' : 'i'}`;
                deptIconName = 'user';
              } else if (deptKey) {
                deptLabel = DEPARTMENT_LABELS[deptKey] || deptKey;
                deptIconName = DEPARTMENT_ICON_NAMES[deptKey] || 'building';
              }

              const accentColor = rule.trigger_color || triggerMeta.color || '#0797d3';

              return (
                <div
                  key={rule.id}
                  className="automation-rule-card"
                  style={{
                    background: 'var(--bg-secondary)',
                    border: `1px solid ${rule.is_active ? 'var(--border-color)' : 'rgba(150, 150, 150, 0.25)'}`,
                    borderLeft: `4px solid ${accentColor}`,
                    borderRadius: '14px',
                    padding: '20px 22px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    boxShadow: rule.is_active ? '0 4px 16px rgba(0,0,0,0.04)' : 'none',
                    opacity: rule.is_active ? 1 : 0.72,
                    position: 'relative',
                  }}
                >
                  <div>
                    {/* Top Row: Dept badge & Switch */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                      <span
                        style={{
                          fontSize: '11.5px',
                          fontWeight: '700',
                          padding: '4px 10px',
                          borderRadius: '8px',
                          background: 'rgba(7, 151, 211, 0.1)',
                          color: 'var(--text-accent, #087fba)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          textTransform: 'uppercase',
                          letterSpacing: '0.3px',
                        }}
                      >
                        <AppIcon name={deptIconName} size={13} />
                        <span>{deptLabel}</span>
                      </span>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span
                          style={{
                            fontSize: '11.5px',
                            color: rule.is_active ? '#10b981' : 'var(--text-secondary)',
                            fontWeight: '700',
                            letterSpacing: '0.3px',
                          }}
                        >
                          {rule.is_active ? 'ATTIVA' : 'IN PAUSA'}
                        </span>
                        {canManage && (
                          <label style={{ position: 'relative', display: 'inline-block', width: '38px', height: '20px', margin: 0, cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={rule.is_active}
                              onChange={() => handleToggle(rule.id)}
                              style={{ opacity: 0, width: 0, height: 0 }}
                            />
                            <span
                              style={{
                                position: 'absolute',
                                cursor: 'pointer',
                                top: 0,
                                left: 0,
                                right: 0,
                                bottom: 0,
                                backgroundColor: rule.is_active ? '#10b981' : '#cbd5e1',
                                transition: '.25s ease',
                                borderRadius: '20px',
                              }}
                            >
                              <span
                                style={{
                                  position: 'absolute',
                                  height: '14px',
                                  width: '14px',
                                  left: rule.is_active ? '20px' : '3px',
                                  bottom: '3px',
                                  backgroundColor: 'white',
                                  transition: '.25s ease',
                                  borderRadius: '50%',
                                  boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                                }}
                              />
                            </span>
                          </label>
                        )}
                      </div>
                    </div>

                    {/* Rule Title */}
                    <h3 style={{ fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)', margin: '0 0 6px 0', lineHeight: 1.4 }}>
                      {rule.name}
                    </h3>
                    {rule.description && (
                      <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '0 0 16px 0', lineHeight: 1.45 }}>
                        {rule.description}
                      </p>
                    )}

                    {/* Flow Recipe Card (QUANDO -> ALLORA) */}
                    <div
                      style={{
                        background: 'var(--bg-tertiary, rgba(0,0,0,0.02))',
                        border: '1px solid var(--border-color)',
                        borderRadius: '12px',
                        padding: '12px 14px',
                        fontSize: '13px',
                        marginBottom: '16px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                      }}
                    >
                      {/* QUANDO */}
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                        <span
                          style={{
                            fontSize: '10px',
                            fontWeight: '800',
                            color: 'var(--text-secondary)',
                            background: 'rgba(0,0,0,0.05)',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            letterSpacing: '0.4px',
                            marginTop: '2px',
                            flexShrink: 0,
                          }}
                        >
                          QUANDO
                        </span>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontWeight: '700', color: triggerMeta.color }}>
                            <AppIcon name={triggerMeta.iconName || 'zap'} size={15} />
                            <span>{triggerMeta.label}</span>
                          </span>
                          {rule.trigger_type === 'budget_hours_exceeded' && (
                            <span
                              style={{
                                background: 'rgba(245, 158, 11, 0.15)',
                                color: '#d97706',
                                padding: '2px 7px',
                                borderRadius: '6px',
                                fontSize: '11.5px',
                                fontWeight: '700',
                              }}
                            >
                              &ge; {rule.trigger_config?.threshold_pct}%
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Divider connector */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingLeft: '18px' }}>
                        <div style={{ width: '2px', height: '8px', background: 'var(--border-color)', borderRadius: '1px' }} />
                        <span style={{ fontSize: '10.5px', color: 'var(--text-secondary)', opacity: 0.65 }}>↓ attiva</span>
                      </div>

                      {/* ALLORA */}
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                        <span
                          style={{
                            fontSize: '10px',
                            fontWeight: '800',
                            color: 'var(--text-secondary)',
                            background: 'rgba(0,0,0,0.05)',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            letterSpacing: '0.4px',
                            marginTop: '2px',
                            flexShrink: 0,
                          }}
                        >
                          ALLORA
                        </span>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontWeight: '700', color: actionMeta.color }}>
                            <AppIcon name={actionMeta.iconName || 'todo'} size={15} />
                            <span>{actionMeta.label}</span>
                          </span>
                          {rule.action_type === 'create_todo' && rule.action_config?.assignee_department && (
                            <span
                              style={{
                                background: 'rgba(59, 130, 246, 0.12)',
                                color: '#2563eb',
                                padding: '2px 7px',
                                borderRadius: '6px',
                                fontSize: '11.5px',
                                fontWeight: '700',
                              }}
                            >
                              &rarr; {DEPARTMENT_LABELS[rule.action_config.assignee_department] || rule.action_config.assignee_department}
                            </span>
                          )}
                          {rule.action_type === 'create_calendar_event' && (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '5px',
                                background: 'rgba(2, 132, 199, 0.12)',
                                color: '#0284c7',
                                padding: '2px 8px',
                                borderRadius: '6px',
                                fontSize: '11.5px',
                                fontWeight: '700',
                              }}
                            >
                              <span
                                style={{
                                  width: '8px',
                                  height: '8px',
                                  borderRadius: '50%',
                                  backgroundColor: rule.action_config?.event_color || '#10b981',
                                  display: 'inline-block',
                                }}
                              />
                              <span>&rarr; {rule.action_config?.event_date_type === 'task_start_date' ? 'Inizio fase' : rule.action_config?.event_date_type === 'today' ? 'Data evento' : 'Fine fase'}</span>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Bottom Footer: Stats & Actions */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      paddingTop: '12px',
                      borderTop: '1px solid var(--border-color)',
                      fontSize: '12px',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <AppIcon name="target" size={13} style={{ color: 'var(--text-secondary)' }} />
                      <span>
                        Scattata: <strong>{rule.trigger_count || 0}</strong> {rule.trigger_count === 1 ? 'volta' : 'volte'}
                      </span>
                      {rule.last_triggered_at && (
                        <span style={{ marginLeft: '4px', opacity: 0.7, fontSize: '11px' }}>
                          (ult: {new Date(rule.last_triggered_at).toLocaleDateString('it-IT')})
                        </span>
                      )}
                    </div>

                    {canManage && (
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          onClick={() => openEditModal(rule)}
                          className="automation-action-btn"
                          style={{
                            background: 'var(--bg-secondary)',
                            border: '1px solid var(--border-color)',
                            borderRadius: '8px',
                            padding: '4px 10px',
                            cursor: 'pointer',
                            fontSize: '12px',
                            fontWeight: '600',
                            color: 'var(--text-primary)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                          }}
                          title="Modifica regola"
                        >
                          <AppIcon name="edit" size={13} />
                          <span>Modifica</span>
                        </button>
                        <button
                          onClick={() => handleDelete(rule.id)}
                          className="automation-action-btn"
                          style={{
                            background: 'rgba(239, 68, 68, 0.08)',
                            border: '1px solid rgba(239, 68, 68, 0.25)',
                            color: '#ef4444',
                            borderRadius: '8px',
                            padding: '4px 8px',
                            cursor: 'pointer',
                            fontSize: '12px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                          title="Elimina regola"
                        >
                          <AppIcon name="trash" size={13} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Logs Tab */}
      {activeTab === 'logs' && (
        <div
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            borderRadius: '14px',
            overflow: 'hidden',
            boxShadow: '0 2px 10px rgba(0,0,0,0.03)',
          }}
        >
          {logs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px', color: 'var(--text-secondary)' }}>
              <div style={{ marginBottom: '8px', display: 'flex', justifyContent: 'center' }}>
                <AppIcon name="fileText" size={32} style={{ color: 'var(--text-muted)' }} />
              </div>
              <div style={{ fontWeight: '600', color: 'var(--text-primary)' }}>Nessuna esecuzione registrata finora</div>
              <p style={{ fontSize: '13px', margin: '4px 0 0 0' }}>I log delle regole scattate appariranno qui automaticamente.</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
                <thead>
                  <tr
                    style={{
                      background: 'var(--bg-tertiary, rgba(0,0,0,0.03))',
                      borderBottom: '1px solid var(--border-color)',
                      color: 'var(--text-secondary)',
                      fontSize: '11.5px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.4px',
                    }}
                  >
                    <th style={{ padding: '14px 18px' }}>Data / Ora</th>
                    <th style={{ padding: '14px 18px' }}>Regola</th>
                    <th style={{ padding: '14px 18px' }}>Commessa</th>
                    <th style={{ padding: '14px 18px' }}>Fase</th>
                    <th style={{ padding: '14px 18px' }}>Dettagli Esecuzione</th>
                    <th style={{ padding: '14px 18px' }}>Esito</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} className="automation-table-row" style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '12px 18px', color: 'var(--text-secondary)', whiteSpace: 'nowrap', fontSize: '12.5px' }}>
                        {log.created_at ? new Date(log.created_at).toLocaleString('it-IT') : '-'}
                      </td>
                      <td style={{ padding: '12px 18px', fontWeight: '700', color: 'var(--text-primary)' }}>
                        {log.rule_name}
                      </td>
                      <td style={{ padding: '12px 18px' }}>
                        {log.project_code ? (
                          <span
                            style={{
                              fontWeight: '700',
                              color: 'var(--text-accent, #087fba)',
                              background: 'rgba(8, 127, 186, 0.08)',
                              border: '1px solid rgba(8, 127, 186, 0.2)',
                              padding: '2px 8px',
                              borderRadius: '6px',
                              fontFamily: 'monospace',
                              fontSize: '12px',
                            }}
                          >
                            {log.project_code}
                          </span>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td style={{ padding: '12px 18px', color: 'var(--text-primary)' }}>
                        {log.task_name || '-'}
                      </td>
                      <td style={{ padding: '12px 18px', color: 'var(--text-secondary)', maxWidth: '420px', lineHeight: 1.4 }}>
                        {log.details || '-'}
                      </td>
                      <td style={{ padding: '12px 18px' }}>
                        {log.status === 'success' ? (
                          <span
                            style={{
                              background: 'rgba(16, 185, 129, 0.12)',
                              color: '#10b981',
                              padding: '3px 10px',
                              borderRadius: '8px',
                              fontSize: '11.5px',
                              fontWeight: '700',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '5px',
                            }}
                          >
                            <AppIcon name="checkCircle" size={13} />
                            <span>Completata</span>
                          </span>
                        ) : (
                          <span
                            style={{
                              background: 'rgba(239, 68, 68, 0.12)',
                              color: '#ef4444',
                              padding: '3px 10px',
                              borderRadius: '8px',
                              fontSize: '11.5px',
                              fontWeight: '700',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '5px',
                            }}
                          >
                            <AppIcon name="close" size={13} />
                            <span>Errore</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Modal Creazione / Modifica Regola */}
      {showModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.65)',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '20px',
          }}
        >
          <div
            style={{
              background: 'var(--bg-primary)',
              borderRadius: '20px',
              width: '100%',
              maxWidth: '1280px',
              maxHeight: '92vh',
              overflowY: 'auto',
              boxShadow: '0 25px 60px rgba(0,0,0,0.3)',
              border: '1px solid var(--border-color)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* Modal Header */}
            <div style={{ padding: '22px 28px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', background: 'var(--bg-secondary)', borderTopLeftRadius: '20px', borderTopRightRadius: '20px' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <AppIcon name="zap" size={24} style={{ color: 'var(--text-accent, #087fba)' }} />
                  <h2 style={{ fontSize: '19px', fontWeight: '800', color: 'var(--text-primary)', margin: 0 }}>
                    {editingRule ? 'Modifica Regola di Automazione' : 'Crea Nuova Regola di Automazione'}
                  </h2>
                </div>
                <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: 'var(--text-secondary)' }}>
                  Configura workflow Se/Allora senza codice con passaggi automatici tra reparti, alert e scadenze.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowModal(false)}
                style={{
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border-color)',
                  width: '34px',
                  height: '34px',
                  borderRadius: '10px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  color: 'var(--text-secondary)',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = 'var(--text-primary)';
                  e.currentTarget.style.borderColor = 'var(--text-muted)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'var(--text-secondary)';
                  e.currentTarget.style.borderColor = 'var(--border-color)';
                }}
                title="Chiudi"
              >
                <AppIcon name="close" size={18} />
              </button>
            </div>

            <form onSubmit={handleSaveModal} style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: '22px' }}>
              {/* Toolbar Scenari Rapidi Preimpostati (solo per nuove regole) */}
              {!editingRule && (
                <div style={{ background: 'linear-gradient(135deg, rgba(24, 95, 165, 0.06), rgba(139, 92, 246, 0.06))', border: '1px solid rgba(24, 95, 165, 0.18)', borderRadius: '14px', padding: '14px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px', flexWrap: 'wrap', gap: '8px' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: '700', color: 'var(--color-primary, #185fa5)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      <AppIcon name="sparkles" size={14} />
                      <span>Scenari Rapidi in 1 Click (seleziona per compilare subito):</span>
                    </span>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      Puoi personalizzare qualsiasi campo dopo la selezione
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '8px' }}>
                    {PRESET_TEMPLATES.map((preset, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => applyPreset(preset)}
                        style={{
                          textAlign: 'left',
                          padding: '8px 12px',
                          background: 'var(--bg-primary)',
                          border: '1px solid var(--border-color)',
                          borderRadius: '8px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '8px',
                          transition: 'all 0.15s ease',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-primary, #185fa5)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-color)'; e.currentTarget.style.transform = 'none'; }}
                      >
                        <span style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-primary)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                          <AppIcon name={preset.iconName || 'sparkles'} size={14} style={{ color: 'var(--text-accent, #087fba)' }} />
                          <span>{preset.title}</span>
                        </span>
                        <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', background: 'rgba(0,0,0,0.06)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                          {preset.badge}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Informazioni Base: Nome & Descrizione */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '6px' }}>
                    Nome della Regola *
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="Es: Ufficio Tecnico completato ➔ TODO Ordine Materiali"
                    style={{ width: '100%', padding: '10px 14px', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '13px' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '6px' }}>
                    Descrizione (opzionale)
                  </label>
                  <input
                    type="text"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="Es: Quando finisce la progettazione UT crea task urgente per Acquisti"
                    style={{ width: '100%', padding: '10px 14px', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '13px' }}
                  />
                </div>
              </div>

              {/* SEZIONE 1: QUANDO (TRIGGER) */}
              <div style={{ background: 'rgba(59, 130, 246, 0.04)', border: '1px solid rgba(59, 130, 246, 0.22)', borderRadius: '14px', padding: '18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: '800', color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    <AppIcon name="zap" size={14} />
                    <span>1. QUANDO (Evento Scatenante)</span>
                  </div>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    Condizione di innesco della regola
                  </span>
                </div>

                <div style={{ marginBottom: '14px' }}>
                  <select
                    value={formData.trigger_type}
                    onChange={(e) => {
                      const nextTrigger = e.target.value;
                      const autoColor = TRIGGER_DEFAULT_COLORS[nextTrigger] || '#10b981';
                      const smart = getSmartContentDefaults(nextTrigger, formData.department, formData.action_type);
                      setFormData((prev) => ({
                        ...prev,
                        trigger_type: nextTrigger,
                        event_color: autoColor,
                        name: smart.rule_name,
                        description: smart.rule_description,
                        todo_title: smart.todo_title,
                        todo_content: smart.todo_content,
                        event_title: smart.event_title,
                        event_description: smart.event_description,
                        notify_title: smart.notify_title,
                        notify_message: smart.notify_message,
                        assignee_department: smart.assignee_department || prev.assignee_department,
                        due_days: smart.due_days ?? prev.due_days,
                        event_date_type: smart.event_date_type || prev.event_date_type,
                        event_days_offset: smart.event_days_offset ?? prev.event_days_offset,
                      }));
                    }}
                    style={{ width: '100%', padding: '11px 14px', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '14px', fontWeight: '600' }}
                  >
                    <option value="phase_completed">Una fase raggiunge il 100% (o viene completata)</option>
                    <option value="phase_started">Una fase viene avviata (inizio lavori o primo consuntivo)</option>
                    <option value="phase_progress_reached">L'avanzamento della fase raggiunge o supera una soglia %</option>
                    <option value="phase_delayed">Una fase è scaduta senza essere completata</option>
                    <option value="budget_hours_exceeded">Il consuntivo ore supera la soglia % del budget</option>
                    <option value="phase_deadline_approaching">La fase scade a breve con avanzamento ridotto</option>
                  </select>
                </div>

                {/* Parametri Condizionali Trigger */}
                {formData.trigger_type === 'budget_hours_exceeded' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'var(--bg-primary)', padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: '500' }}>Invia alert se le ore consuntivate superano il:</span>
                    <input
                      type="number"
                      min="50"
                      max="250"
                      value={formData.threshold_pct}
                      onChange={(e) => setFormData({ ...formData, threshold_pct: e.target.value })}
                      style={{ width: '80px', padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontWeight: '700', fontSize: '14px', textAlign: 'center' }}
                    />
                    <span style={{ fontSize: '14px', fontWeight: '700', color: 'var(--text-primary)' }}>% del budget previsto</span>
                  </div>
                )}

                {formData.trigger_type === 'phase_progress_reached' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'var(--bg-primary)', padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: '500' }}>Innesca quando la percentuale di avanzamento raggiunge almeno il:</span>
                    <input
                      type="number"
                      min="10"
                      max="99"
                      value={formData.target_progress}
                      onChange={(e) => setFormData({ ...formData, target_progress: e.target.value })}
                      style={{ width: '80px', padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontWeight: '700', fontSize: '14px', textAlign: 'center' }}
                    />
                    <span style={{ fontSize: '14px', fontWeight: '700', color: 'var(--text-primary)' }}>% (es. 50% per SAL intermedio o 75% per collaudo)</span>
                  </div>
                )}

                {formData.trigger_type === 'phase_deadline_approaching' && (
                  <div style={{ display: 'flex', gap: '14px', background: 'var(--bg-primary)', padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border-color)', flexWrap: 'wrap', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: '500' }}>Scadenza entro:</span>
                      <input
                        type="number"
                        min="1"
                        max="30"
                        value={formData.days_before}
                        onChange={(e) => setFormData({ ...formData, days_before: e.target.value })}
                        style={{ width: '70px', padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontWeight: '700', textAlign: 'center' }}
                      />
                      <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>giorni</span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: '500' }}>ed avanzamento ancora sotto il:</span>
                      <input
                        type="number"
                        min="10"
                        max="95"
                        value={formData.max_progress}
                        onChange={(e) => setFormData({ ...formData, max_progress: e.target.value })}
                        style={{ width: '70px', padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontWeight: '700', textAlign: 'center' }}
                      />
                      <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>%</span>
                    </div>
                  </div>
                )}

                {formData.trigger_type === 'phase_delayed' && (
                  <div style={{ fontSize: '12px', color: 'var(--color-danger, #dc2626)', background: 'var(--bg-primary)', padding: '8px 12px', borderRadius: '6px', border: '1px solid rgba(220, 38, 38, 0.2)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <AppIcon name="alertTriangle" size={14} />
                    <span>Questa automazione scatterà quando la data di scadenza della fase è nel passato ma lo stato non è ancora completato (100%).</span>
                  </div>
                )}

                {formData.trigger_type === 'phase_started' && (
                  <div style={{ fontSize: '12px', color: 'var(--color-primary, #2563eb)', background: 'var(--bg-primary)', padding: '8px 12px', borderRadius: '6px', border: '1px solid rgba(37, 99, 235, 0.2)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <AppIcon name="play" size={14} />
                    <span>Scatterà non appena viene registrata la prima ora di consuntivo o l'avanzamento passa dallo 0% a una percentuale superiore.</span>
                  </div>
                )}
              </div>

              {/* SEZIONE 2: SE (CONDIZIONI & REPARTO) */}
              <div style={{ background: 'rgba(245, 158, 11, 0.04)', border: '1px solid rgba(245, 158, 11, 0.25)', borderRadius: '14px', padding: '18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: '800', color: '#d97706', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    <AppIcon name="filter" size={14} />
                    <span>2. SE (Filtri & Condizioni)</span>
                  </div>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    Limita a quale reparto o fase applicare la regola
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: '600' }}>Applica alle fasi del reparto:</span>
                  <select
                    value={formData.department}
                    onChange={(e) => {
                      const nextDept = e.target.value;
                      const smart = getSmartContentDefaults(formData.trigger_type, nextDept, formData.action_type);
                      setFormData((prev) => ({
                        ...prev,
                        department: nextDept,
                        name: smart.rule_name,
                        description: smart.rule_description,
                        todo_title: smart.todo_title,
                        todo_content: smart.todo_content,
                        event_title: smart.event_title,
                        event_description: smart.event_description,
                        notify_title: smart.notify_title,
                        notify_message: smart.notify_message,
                        assignee_department: smart.assignee_department || prev.assignee_department,
                        due_days: smart.due_days ?? prev.due_days,
                      }));
                    }}
                    style={{ flex: 1, minWidth: '220px', height: '40px', padding: '0 14px', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '13px', fontWeight: '500', boxSizing: 'border-box' }}
                  >
                    <option value="">Tutti i reparti (qualsiasi fase)</option>
                    <option value="ufficio_tecnico">Ufficio Tecnico</option>
                    <option value="produzione">Produzione</option>
                    <option value="acquisti">Acquisti</option>
                    <option value="commerciale">Commerciale</option>
                    <option value="amministrazione">Amministrazione</option>
                    <option value="specific_workers">Addetti specifici...</option>
                  </select>
                </div>

                {formData.department === 'specific_workers' && (
                  <div style={{ marginTop: '14px' }}>
                    <WorkerMultiSelect
                      selected={formData.selected_workers}
                      onChange={(workers) => setFormData((p) => ({ ...p, selected_workers: workers }))}
                      users={usersList}
                      valueKey="username"
                      title="Seleziona addetti:"
                      accentColor="#d97706"
                    />
                  </div>
                )}
              </div>

              {/* SEZIONE 3: ALLORA (AZIONE AUTOMATICA) */}
              <div style={{ background: 'rgba(16, 185, 129, 0.04)', border: '1px solid rgba(16, 185, 129, 0.25)', borderRadius: '14px', padding: '18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: '800', color: '#059669', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    <AppIcon name="checkCircle" size={14} />
                    <span>3. ALLORA (Azione Automatica Eseguita)</span>
                  </div>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    Cosa deve fare il sistema quando si verifica l'evento
                  </span>
                </div>

                <div style={{ marginBottom: '14px' }}>
                  <select
                    value={formData.action_type}
                    onChange={(e) => {
                      const nextType = e.target.value;
                      const smart = getSmartContentDefaults(formData.trigger_type, formData.department, nextType);
                      setFormData((prev) => ({
                        ...prev,
                        action_type: nextType,
                        todo_title: smart.todo_title,
                        todo_content: smart.todo_content,
                        event_title: smart.event_title,
                        event_description: smart.event_description,
                        notify_title: smart.notify_title,
                        notify_message: smart.notify_message,
                      }));
                      if (nextType === 'create_calendar_event') {
                        setActiveField('event_title');
                      } else if (nextType === 'send_notification') {
                        setActiveField('notify_message');
                      } else {
                        setActiveField('todo_content');
                      }
                    }}
                    style={{ width: '100%', padding: '11px 14px', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '14px', fontWeight: '600' }}
                  >
                    <option value="create_todo">Crea automaticamente un TODO operativo</option>
                    <option value="send_notification">Invia una Notifica in-app di avviso</option>
                    <option value="create_calendar_event">Crea un Evento nel Calendario aziendale</option>
                  </select>
                </div>

                {/* Banner Testi Consigliati Smart */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '9px 13px',
                  background: 'rgba(24, 95, 165, 0.06)',
                  borderRadius: '9px',
                  marginBottom: '16px',
                  flexWrap: 'wrap',
                  gap: '8px',
                  border: '1px dashed rgba(24, 95, 165, 0.28)'
                }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-primary)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <AppIcon name="sparkles" size={13} style={{ color: '#0284c7' }} />
                    <span>
                      Campi precompilati per: <strong>{TRIGGER_LABELS[formData.trigger_type]?.label || formData.trigger_type}</strong>
                      {formData.department ? ` • Reparto: ${DEPARTMENT_LABELS[formData.department] || formData.department}` : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => applySmartDefaults()}
                    style={{
                      background: 'var(--bg-primary)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '6px',
                      padding: '3px 9px',
                      fontSize: '11px',
                      fontWeight: '600',
                      cursor: 'pointer',
                      color: 'var(--color-primary, #185fa5)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px'
                    }}
                    title="Reimposta i testi consigliati per la combinazione Quando/Se/Allora corrente"
                  >
                    <span>↺</span> Reimposta testi predefiniti
                  </button>
                </div>

                {/* Sezione Campi TODO */}
                {(formData.action_type === 'create_todo' || formData.action_type === 'create_todo_and_notify') && (
                  <div style={{ background: 'var(--bg-primary)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)', marginBottom: formData.action_type === 'create_todo_and_notify' ? '16px' : '0' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                      <span style={{ fontSize: '12px', fontWeight: '700', color: 'var(--color-primary, #185fa5)', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <AppIcon name="todo" size={15} /> Configurazione Attività TODO:
                      </span>
                    </div>

                    <div style={{ marginBottom: '12px' }}>
                      <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '5px' }}>
                        <span>Titolo del TODO</span>
                        {activeField === 'todo_title' && <span style={{ color: '#10b981', fontSize: '11px', fontWeight: '600' }}>● Campo attivo per inserimento etichette</span>}
                      </label>
                      <BadgeEditor
                        value={formData.todo_title}
                        onFocus={() => setActiveField('todo_title')}
                        onChange={(val) => setFormData((p) => ({ ...p, todo_title: val }))}
                        placeholder="Es: Ordinare materiali per commessa [Codice Commessa]"
                        active={activeField === 'todo_title'}
                        activeBorderColor="#10b981"
                      />
                    </div>

                    <div style={{ marginBottom: '14px' }}>
                      <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '5px' }}>
                        <span>Descrizione / Istruzioni del TODO</span>
                        {activeField === 'todo_content' && <span style={{ color: '#10b981', fontSize: '11px', fontWeight: '600' }}>● Campo attivo per inserimento etichette</span>}
                      </label>
                      <BadgeEditor
                        isTextarea
                        value={formData.todo_content}
                        onFocus={() => setActiveField('todo_content')}
                        onChange={(val) => setFormData((p) => ({ ...p, todo_content: val }))}
                        placeholder="Es: La fase [Nome Fase] è completata. Procedere con le attività previste."
                        active={activeField === 'todo_content'}
                        activeBorderColor="#10b981"
                      />
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px', alignItems: 'flex-start' }}>
                      <div>
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '6px' }}>
                          Assegna automaticamente a:
                        </label>
                        <select
                          value={formData.assignee_department}
                          onChange={(e) => setFormData({ ...formData, assignee_department: e.target.value })}
                          style={{
                            width: '100%',
                            height: '40px',
                            padding: '0 12px',
                            borderRadius: '8px',
                            border: '1px solid var(--border-color)',
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                            fontSize: '13px',
                            boxSizing: 'border-box',
                          }}
                        >
                          <option value="acquisti">Reparto Acquisti</option>
                          <option value="produzione">Reparto Produzione</option>
                          <option value="ufficio_tecnico">Ufficio Tecnico</option>
                          <option value="commerciale">Reparto Commerciale</option>
                          <option value="amministrazione">Amministrazione</option>
                          <option value="pm">Project Manager della Commessa</option>
                          <option value="specific_workers">Addetti specifici...</option>
                        </select>
                      </div>

                      <div>
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '6px' }}>
                          Scadenza TODO:
                        </label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', height: '40px' }}>
                          <input
                            type="number"
                            min="1"
                            max="60"
                            value={formData.due_days}
                            onChange={(e) => setFormData({ ...formData, due_days: e.target.value })}
                            style={{
                              width: '80px',
                              height: '40px',
                              padding: '0 12px',
                              borderRadius: '8px',
                              border: '1px solid var(--border-color)',
                              background: 'var(--bg-secondary)',
                              color: 'var(--text-primary)',
                              fontSize: '13px',
                              textAlign: 'center',
                              fontWeight: '700',
                              boxSizing: 'border-box',
                            }}
                          />
                          <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>giorni dalla creazione</span>
                        </div>
                      </div>
                    </div>

                    {formData.assignee_department === 'specific_workers' && (
                      <div style={{ marginTop: '14px' }}>
                        <WorkerMultiSelect
                          selected={formData.assignee_ids}
                          onChange={(ids) => setFormData((p) => ({ ...p, assignee_ids: ids }))}
                          users={usersList}
                          valueKey="id"
                          title="Seleziona gli addetti a cui assegnare il TODO:"
                          accentColor="#10b981"
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Sezione Campi Notifica */}
                {(formData.action_type === 'send_notification' || formData.action_type === 'create_todo_and_notify') && (
                  <div style={{ background: 'var(--bg-primary)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                      <span style={{ fontSize: '12px', fontWeight: '700', color: '#8b5cf6', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <AppIcon name="bell" size={15} /> Configurazione Notifica in-app:
                      </span>
                    </div>

                    <div style={{ marginBottom: '12px' }}>
                      <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '5px' }}>
                        <span>Titolo della Notifica</span>
                        {activeField === 'notify_title' && <span style={{ color: '#8b5cf6', fontSize: '11px', fontWeight: '600' }}>● Campo attivo per inserimento etichette</span>}
                      </label>
                      <BadgeEditor
                        value={formData.notify_title}
                        onFocus={() => setActiveField('notify_title')}
                        onChange={(val) => setFormData((p) => ({ ...p, notify_title: val }))}
                        placeholder="Es: Allerta fase: [Nome Fase]"
                        active={activeField === 'notify_title'}
                        activeBorderColor="#8b5cf6"
                      />
                    </div>

                    <div style={{ marginBottom: '14px' }}>
                      <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '5px' }}>
                        <span>Messaggio della Notifica</span>
                        {activeField === 'notify_message' && <span style={{ color: '#8b5cf6', fontSize: '11px', fontWeight: '600' }}>● Campo attivo per inserimento etichette</span>}
                      </label>
                      <BadgeEditor
                        isTextarea
                        value={formData.notify_message}
                        onFocus={() => setActiveField('notify_message')}
                        onChange={(val) => setFormData((p) => ({ ...p, notify_message: val }))}
                        placeholder="Es: La fase [Nome Fase] ([Codice Commessa]) ha raggiunto [Ore Consuntivate] su [Ore a Budget]."
                        active={activeField === 'notify_message'}
                        activeBorderColor="#8b5cf6"
                      />
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: '12px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '6px' }}>
                        Destinatari della Notifica:
                      </label>
                      <select
                        value={formData.recipient_role}
                        onChange={(e) => setFormData({ ...formData, recipient_role: e.target.value })}
                        style={{
                          width: '100%',
                          height: '40px',
                          padding: '0 12px',
                          borderRadius: '8px',
                          border: '1px solid var(--border-color)',
                          background: 'var(--bg-secondary)',
                          color: 'var(--text-primary)',
                          fontSize: '13px',
                          boxSizing: 'border-box',
                        }}
                      >
                        <option value="pm">Project Manager della commessa</option>
                        <option value="pm_and_workers">Project Manager + Addetti assegnati alla fase</option>
                        <option value="workers">Solo gli addetti assegnati alla fase</option>
                        <option value="specific_workers">Addetti specifici...</option>
                      </select>
                    </div>

                    {formData.recipient_role === 'specific_workers' && (
                      <div style={{ marginTop: '14px' }}>
                        <WorkerMultiSelect
                          selected={formData.recipient_ids}
                          onChange={(ids) => setFormData((p) => ({ ...p, recipient_ids: ids }))}
                          users={usersList}
                          valueKey="id"
                          title="Seleziona gli addetti da notificare:"
                          accentColor="#8b5cf6"
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Sezione Campi Evento Calendario */}
                {formData.action_type === 'create_calendar_event' && (
                  <div style={{ background: 'var(--bg-primary)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                      <span style={{ fontSize: '12px', fontWeight: '700', color: '#0284c7', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <AppIcon name="calendar" size={15} /> Configurazione Evento a Calendario:
                      </span>
                    </div>

                    <div style={{ marginBottom: '12px' }}>
                      <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '5px' }}>
                        <span>Titolo dell'Evento</span>
                        {activeField === 'event_title' && <span style={{ color: '#0284c7', fontSize: '11px', fontWeight: '600' }}>● Campo attivo per inserimento etichette</span>}
                      </label>
                      <BadgeEditor
                        value={formData.event_title}
                        onFocus={() => setActiveField('event_title')}
                        onChange={(val) => setFormData((p) => ({ ...p, event_title: val }))}
                        placeholder="Es: Collaudo / Verifica: [Nome Fase] ([Codice Commessa])"
                        active={activeField === 'event_title'}
                        activeBorderColor="#0284c7"
                      />
                    </div>

                    <div style={{ marginBottom: '14px' }}>
                      <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '5px' }}>
                        <span>Descrizione / Note dell'Evento</span>
                        {activeField === 'event_description' && <span style={{ color: '#0284c7', fontSize: '11px', fontWeight: '600' }}>● Campo attivo per inserimento etichette</span>}
                      </label>
                      <BadgeEditor
                        isTextarea
                        value={formData.event_description}
                        onFocus={() => setActiveField('event_description')}
                        onChange={(val) => setFormData((p) => ({ ...p, event_description: val }))}
                        placeholder="Es: Lavorazione completata per la fase [Nome Fase] commessa [Codice Commessa]. Procedere con collaudo finale."
                        active={activeField === 'event_description'}
                        activeBorderColor="#0284c7"
                      />
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px', alignItems: 'flex-start', marginBottom: '16px' }}>
                      <div>
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '6px' }}>
                          Data di riferimento evento:
                        </label>
                        <select
                          value={formData.event_date_type}
                          onChange={(e) => setFormData({ ...formData, event_date_type: e.target.value })}
                          style={{
                            width: '100%',
                            height: '40px',
                            padding: '0 12px',
                            borderRadius: '8px',
                            border: '1px solid var(--border-color)',
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                            fontSize: '13px',
                            boxSizing: 'border-box',
                          }}
                        >
                          <option value="task_end_date">Data di fine della fase</option>
                          <option value="task_start_date">Data di inizio della fase</option>
                          <option value="today">Giorno dell'evento (oggi)</option>
                        </select>
                      </div>

                      <div>
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '6px' }}>
                          Offset giorni rispetto alla data:
                        </label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', height: '40px' }}>
                          <input
                            type="number"
                            min="-30"
                            max="60"
                            value={formData.event_days_offset}
                            onChange={(e) => setFormData({ ...formData, event_days_offset: e.target.value })}
                            style={{
                              width: '80px',
                              height: '40px',
                              padding: '0 12px',
                              borderRadius: '8px',
                              border: '1px solid var(--border-color)',
                              background: 'var(--bg-secondary)',
                              color: 'var(--text-primary)',
                              fontSize: '13px',
                              textAlign: 'center',
                              fontWeight: '700',
                              boxSizing: 'border-box',
                            }}
                          />
                          <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                            {Number(formData.event_days_offset) === 0 ? 'giorno stesso' : `${formData.event_days_offset > 0 ? '+' : ''}${formData.event_days_offset} gg`}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Palette Colore a Calendario */}
                    <div style={{
                      marginBottom: '16px',
                      padding: '12px 14px',
                      borderRadius: '10px',
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border-color)'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px', flexWrap: 'wrap', gap: '8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <label style={{ fontSize: '12px', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>
                            🎨 Colore a Calendario:
                          </label>
                          <span style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '5px',
                            fontSize: '12px',
                            fontWeight: '700',
                            color: formData.event_color,
                          }}>
                            <span style={{
                              width: '10px',
                              height: '10px',
                              borderRadius: '50%',
                              backgroundColor: formData.event_color,
                              display: 'inline-block',
                              boxShadow: `0 0 6px ${formData.event_color}88`,
                            }} />
                            {CALENDAR_COLORS.find(c => c.value === formData.event_color)?.label || formData.event_color}
                            <span style={{ fontSize: '11px', fontWeight: '500', color: 'var(--text-secondary)' }}>
                              ({CALENDAR_COLORS.find(c => c.value === formData.event_color)?.desc || ''})
                            </span>
                          </span>
                        </div>

                        {formData.event_color === (TRIGGER_DEFAULT_COLORS[formData.trigger_type] || '#10b981') ? (
                          <span style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontSize: '11px',
                            fontWeight: '700',
                            padding: '2px 8px',
                            borderRadius: '999px',
                            background: 'rgba(16, 185, 129, 0.12)',
                            color: '#10b981',
                            border: '1px solid rgba(16, 185, 129, 0.28)'
                          }}>
                            <AppIcon name="zap" size={12} /> Auto da motivo trigger
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setFormData(p => ({ ...p, event_color: TRIGGER_DEFAULT_COLORS[formData.trigger_type] || '#10b981' }))}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: '#0284c7',
                              fontSize: '11px',
                              fontWeight: '600',
                              cursor: 'pointer',
                              padding: '2px 4px',
                              textDecoration: 'underline'
                            }}
                          >
                            ↺ Ripristina colore del trigger ({CALENDAR_COLORS.find(c => c.value === TRIGGER_DEFAULT_COLORS[formData.trigger_type])?.label})
                          </button>
                        )}
                      </div>

                      {/* Swatches / Bottoni Colore */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                        {CALENDAR_COLORS.map((col) => {
                          const isSelected = formData.event_color === col.value;
                          const isAutoMatch = TRIGGER_DEFAULT_COLORS[formData.trigger_type] === col.value;
                          return (
                            <button
                              key={col.value}
                              type="button"
                              onClick={() => setFormData(p => ({ ...p, event_color: col.value }))}
                              title={`${col.label} — ${col.desc}${isAutoMatch ? ' (Predefinito del trigger)' : ''}`}
                              style={{
                                position: 'relative',
                                width: '34px',
                                height: '34px',
                                borderRadius: '50%',
                                backgroundColor: col.value,
                                border: isSelected ? '3px solid #ffffff' : '2px solid rgba(255,255,255,0.3)',
                                outline: isSelected ? `2.5px solid ${col.value}` : 'none',
                                outlineOffset: '1px',
                                boxShadow: isSelected
                                  ? `0 0 10px ${col.value}99, 0 2px 4px rgba(0,0,0,0.2)`
                                  : '0 2px 4px rgba(0,0,0,0.12)',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                transition: 'all 0.18s cubic-bezier(0.4, 0, 0.2, 1)',
                                transform: isSelected ? 'scale(1.12)' : 'scale(1)',
                                padding: 0,
                              }}
                              onMouseEnter={(e) => {
                                if (!isSelected) e.currentTarget.style.transform = 'scale(1.12)';
                              }}
                              onMouseLeave={(e) => {
                                if (!isSelected) e.currentTarget.style.transform = 'scale(1)';
                              }}
                            >
                              {isSelected && (
                                <svg width="18" height="18" viewBox="0 0 20 20" fill="white" style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))' }}>
                                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                </svg>
                              )}
                              {isAutoMatch && !isSelected && (
                                <span
                                  title="Colore associato a questo trigger"
                                  style={{
                                    position: 'absolute',
                                    top: '-2px',
                                    right: '-2px',
                                    width: '9px',
                                    height: '9px',
                                    borderRadius: '50%',
                                    background: '#ffffff',
                                    border: `2px solid ${col.value}`,
                                  }}
                                />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div style={{ marginBottom: '14px' }}>
                      <label style={{ display: 'block', fontSize: '12px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '6px' }}>
                        Partecipanti / Calendario di destinazione:
                      </label>
                      <select
                        value={formData.calendar_attendees}
                        onChange={(e) => setFormData({ ...formData, calendar_attendees: e.target.value })}
                        style={{
                          width: '100%',
                          height: '40px',
                          padding: '0 12px',
                          borderRadius: '8px',
                          border: '1px solid var(--border-color)',
                          background: 'var(--bg-secondary)',
                          color: 'var(--text-primary)',
                          fontSize: '13px',
                          boxSizing: 'border-box',
                        }}
                      >
                        <option value="pm_and_workers">Project Manager + Addetti assegnati alla fase</option>
                        <option value="pm">Solo il Project Manager della commessa</option>
                        <option value="workers">Solo gli addetti assegnati alla fase</option>
                        <option value="specific_workers">Addetti specifici...</option>
                      </select>
                    </div>

                    {formData.calendar_attendees === 'specific_workers' && (
                      <div style={{ marginTop: '14px', marginBottom: '14px' }}>
                        <WorkerMultiSelect
                          selected={formData.calendar_attendee_ids}
                          onChange={(ids) => setFormData((p) => ({ ...p, calendar_attendee_ids: ids }))}
                          users={usersList}
                          valueKey="id"
                          title="Seleziona gli addetti nel cui calendario inserire l'evento:"
                          accentColor="#0284c7"
                        />
                      </div>
                    )}

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '4px' }}>
                      <input
                        type="checkbox"
                        id="notify_attendees_checkbox"
                        checked={formData.notify_attendees}
                        onChange={(e) => setFormData({ ...formData, notify_attendees: e.target.checked })}
                        style={{ width: '16px', height: '16px', cursor: 'pointer', accentColor: '#0284c7' }}
                      />
                      <label htmlFor="notify_attendees_checkbox" style={{ fontSize: '13px', color: 'var(--text-primary)', cursor: 'pointer', userSelect: 'none' }}>
                        Invia contemporaneamente anche una notifica in-app di avviso a tutti i partecipanti
                      </label>
                    </div>
                  </div>
                )}
              </div>

              {/* SEZIONE 4: LIBRERIA VARIABILI USER-FRIENDLY & ANTEPRIMA LIVE */}
              <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '10px' }}>
                  <div>
                    <span style={{ fontSize: '13px', fontWeight: '800', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <AppIcon name="tag" size={15} style={{ color: '#0284c7' }} /> Libreria Etichette Dinamiche
                    </span>
                    <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      Clicca su un'etichetta per inserirla direttamente nel campo selezionato come badge interattivo:
                    </span>
                  </div>

                  {/* Selettore rapido del campo di destinazione */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'var(--bg-primary)', padding: '4px 8px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                    <span style={{ fontSize: '11px', fontWeight: '700', color: 'var(--text-muted)' }}>Destinazione:</span>
                    {(formData.action_type === 'create_todo' || formData.action_type === 'create_todo_and_notify') && (
                      <>
                        <button
                          type="button"
                          onClick={() => setActiveField('todo_title')}
                          style={{
                            padding: '3px 8px',
                            borderRadius: '5px',
                            fontSize: '11px',
                            fontWeight: '600',
                            border: 'none',
                            cursor: 'pointer',
                            background: activeField === 'todo_title' ? '#10b981' : 'transparent',
                            color: activeField === 'todo_title' ? '#fff' : 'var(--text-secondary)',
                          }}
                        >
                          Titolo TODO
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveField('todo_content')}
                          style={{
                            padding: '3px 8px',
                            borderRadius: '5px',
                            fontSize: '11px',
                            fontWeight: '600',
                            border: 'none',
                            cursor: 'pointer',
                            background: activeField === 'todo_content' ? '#10b981' : 'transparent',
                            color: activeField === 'todo_content' ? '#fff' : 'var(--text-secondary)',
                          }}
                        >
                          Testo TODO
                        </button>
                      </>
                    )}
                    {(formData.action_type === 'send_notification' || formData.action_type === 'create_todo_and_notify') && (
                      <>
                        <button
                          type="button"
                          onClick={() => setActiveField('notify_title')}
                          style={{
                            padding: '3px 8px',
                            borderRadius: '5px',
                            fontSize: '11px',
                            fontWeight: '600',
                            border: 'none',
                            cursor: 'pointer',
                            background: activeField === 'notify_title' ? '#8b5cf6' : 'transparent',
                            color: activeField === 'notify_title' ? '#fff' : 'var(--text-secondary)',
                          }}
                        >
                          Titolo Notifica
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveField('notify_message')}
                          style={{
                            padding: '3px 8px',
                            borderRadius: '5px',
                            fontSize: '11px',
                            fontWeight: '600',
                            border: 'none',
                            cursor: 'pointer',
                            background: activeField === 'notify_message' ? '#8b5cf6' : 'transparent',
                            color: activeField === 'notify_message' ? '#fff' : 'var(--text-secondary)',
                          }}
                        >
                          Testo Notifica
                        </button>
                      </>
                    )}
                    {formData.action_type === 'create_calendar_event' && (
                      <>
                        <button
                          type="button"
                          onClick={() => setActiveField('event_title')}
                          style={{
                            padding: '3px 8px',
                            borderRadius: '5px',
                            fontSize: '11px',
                            fontWeight: '600',
                            border: 'none',
                            cursor: 'pointer',
                            background: activeField === 'event_title' ? '#0284c7' : 'transparent',
                            color: activeField === 'event_title' ? '#fff' : 'var(--text-secondary)',
                          }}
                        >
                          Titolo Evento
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveField('event_description')}
                          style={{
                            padding: '3px 8px',
                            borderRadius: '5px',
                            fontSize: '11px',
                            fontWeight: '600',
                            border: 'none',
                            cursor: 'pointer',
                            background: activeField === 'event_description' ? '#0284c7' : 'transparent',
                            color: activeField === 'event_description' ? '#fff' : 'var(--text-secondary)',
                          }}
                        >
                          Descrizione Evento
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Grid dei Chip Etichette */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '8px', marginBottom: '16px' }}>
                  {DYNAMIC_VARIABLES.map((v) => (
                    <button
                      key={v.key}
                      type="button"
                      onClick={() => insertVariable(v.key)}
                      style={{
                        padding: '8px 10px',
                        borderRadius: '9px',
                        border: '1px solid var(--border-color)',
                        background: 'var(--bg-primary)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '8px',
                        transition: 'all 0.15s ease',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = '#0284c7';
                        e.currentTarget.style.background = 'rgba(2, 132, 199, 0.05)';
                        e.currentTarget.style.transform = 'translateY(-1px)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = 'var(--border-color)';
                        e.currentTarget.style.background = 'var(--bg-primary)';
                        e.currentTarget.style.transform = 'translateY(0)';
                      }}
                      title={`Clicca per inserire l'etichetta ${v.label} (Esempio: ${v.sample})`}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', textAlign: 'left', minWidth: 0 }}>
                        <AppIcon name={v.iconName || 'tag'} size={15} style={{ color: '#0284c7', flexShrink: 0 }} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: '12px', fontWeight: '700', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {v.label}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                            Es: {v.sample}
                          </div>
                        </div>
                      </div>
                      <span style={{
                        fontSize: '11px',
                        fontWeight: '700',
                        color: '#0284c7',
                        background: 'rgba(2, 132, 199, 0.12)',
                        padding: '3px 7px',
                        borderRadius: '6px',
                        flexShrink: 0
                      }}>
                        + Aggiungi
                      </span>
                    </button>
                  ))}
                </div>

                {/* Anteprima Live in Tempo Reale */}
                <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '14px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ fontSize: '11px', fontWeight: '800', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <AppIcon name="eye" size={14} style={{ color: '#0284c7' }} /> Anteprima Messaggio Generato (con dati di esempio realistici):
                    </span>
                    <span style={{ fontSize: '11px', color: '#10b981', fontWeight: '600' }}>
                      Aggiornamento in tempo reale
                    </span>
                  </div>

                  {(formData.action_type === 'create_todo' || formData.action_type === 'create_todo_and_notify') && (
                    <div style={{ background: 'rgba(59, 130, 246, 0.04)', border: '1px solid rgba(59, 130, 246, 0.2)', borderRadius: '8px', padding: '10px 14px', marginBottom: formData.action_type === 'create_todo_and_notify' ? '8px' : '0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                        <span style={{ fontSize: '11px', fontWeight: '700', color: '#2563eb' }}>TODO:</span>
                        <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)' }}>
                          {previewValues.todo_title || 'Nessun titolo specificato'}
                        </span>
                      </div>
                      <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                        {previewValues.todo_content || 'Nessun contenuto specificato'}
                      </p>
                      <div style={{ marginTop: '6px', display: 'flex', gap: '12px', fontSize: '11px', color: 'var(--text-muted)', alignItems: 'center' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                          <AppIcon name="user" size={12} /> Assegnato: <strong>{
                            formData.assignee_department === 'specific_workers'
                              ? `${formData.assignee_ids?.length || 0} addett${formData.assignee_ids?.length === 1 ? 'o' : 'i'} specific${formData.assignee_ids?.length === 1 ? 'o' : 'i'}`
                              : (DEPARTMENT_LABELS[formData.assignee_department] || formData.assignee_department)
                          }</strong></span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                          <AppIcon name="calendar" size={12} /> Scadenza: <strong>+{formData.due_days} gg</strong>
                        </span>
                      </div>
                    </div>
                  )}

                  {(formData.action_type === 'send_notification' || formData.action_type === 'create_todo_and_notify') && (
                    <div style={{ background: 'rgba(139, 92, 246, 0.04)', border: '1px solid rgba(139, 92, 246, 0.2)', borderRadius: '8px', padding: '10px 14px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                        <span style={{ fontSize: '11px', fontWeight: '700', color: '#8b5cf6' }}>NOTIFICA:</span>
                        <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)' }}>
                          {previewValues.notify_title || 'Nessun titolo notifica'}
                        </span>
                      </div>
                      <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                        {previewValues.notify_message || 'Nessun messaggio notifica'}
                      </p>
                      <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--text-muted)' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                          <AppIcon name="bell" size={12} /> Destinatari: <strong>{
                            formData.recipient_role === 'specific_workers'
                              ? `${formData.recipient_ids?.length || 0} addett${formData.recipient_ids?.length === 1 ? 'o' : 'i'} specific${formData.recipient_ids?.length === 1 ? 'o' : 'i'}`
                              : formData.recipient_role === 'pm'
                                ? 'Project Manager'
                                : formData.recipient_role === 'pm_and_workers'
                                  ? 'PM + Addetti fase'
                                  : 'Solo addetti fase'
                          }</strong></span>
                      </div>
                    </div>
                  )}

                  {formData.action_type === 'create_calendar_event' && (
                    <div style={{ background: 'rgba(2, 132, 199, 0.04)', border: '1px solid rgba(2, 132, 199, 0.2)', borderRadius: '8px', padding: '10px 14px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                        <span style={{ fontSize: '11px', fontWeight: '700', color: '#0284c7' }}>CALENDARIO:</span>
                        <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)' }}>
                          {previewValues.event_title || 'Nessun titolo evento specificato'}
                        </span>
                      </div>
                      <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                        {previewValues.event_description || 'Nessuna descrizione evento specificata'}
                      </p>
                      <div style={{ marginTop: '6px', display: 'flex', gap: '14px', fontSize: '11px', color: 'var(--text-muted)', flexWrap: 'wrap', alignItems: 'center' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                          <AppIcon name="calendar" size={12} /> Riferimento: <strong>{
                            formData.event_date_type === 'task_start_date' ? 'Data inizio fase' : formData.event_date_type === 'today' ? 'Data odierna' : 'Data fine fase'
                          } {Number(formData.event_days_offset) !== 0 ? `(${formData.event_days_offset > 0 ? '+' : ''}${formData.event_days_offset} gg)` : '(stesso giorno)'}</strong></span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                          <AppIcon name="users" size={12} /> Partecipanti: <strong>{
                            formData.calendar_attendees === 'specific_workers'
                              ? `${formData.calendar_attendee_ids?.length || 0} addett${formData.calendar_attendee_ids?.length === 1 ? 'o' : 'i'} specific${formData.calendar_attendee_ids?.length === 1 ? 'o' : 'i'}`
                              : formData.calendar_attendees === 'pm'
                                ? 'Project Manager'
                                : formData.calendar_attendees === 'workers'
                                  ? 'Addetti della fase'
                                  : 'PM + Addetti fase'
                          }</strong></span>
                        {formData.notify_attendees && (
                          <span style={{ color: '#0284c7', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                            <AppIcon name="bell" size={12} /> Con notifica automatica
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Bottoni Azione Footer */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '14px', paddingTop: '10px', borderTop: '1px solid var(--border-color)' }}>
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  style={{ padding: '10px 20px', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '14px', fontWeight: '600' }}
                >
                  Annulla
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  style={{ padding: '10px 28px', borderRadius: '10px', fontSize: '14px', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '8px' }}
                >
                  <AppIcon name="zap" size={15} />
                  <span>{editingRule ? 'Salva Modifiche' : 'Crea Regola'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
