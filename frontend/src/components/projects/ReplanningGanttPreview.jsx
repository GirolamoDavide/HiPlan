import React, { useState, useMemo, useRef } from 'react';
import {
  CheckCircle,
  X,
  Layers,
  ShieldCheck,
  AlertTriangle,
  Eye,
  ZoomIn,
  ZoomOut,
  Calendar,
  Sparkles
} from 'lucide-react';
import { addWorkingDays as addWorkDaysUtil, countWorkingDays } from '../../utils/workingDays';

const parseDateSafe = (d) => {
  if (!d) return null;
  if (d instanceof Date && !isNaN(d)) return d;
  const str = String(d).split(' ')[0].split('T')[0];
  const parts = str.split('-');
  if (parts.length === 3) {
    const yr = parseInt(parts[0], 10);
    const mo = parseInt(parts[1], 10) - 1;
    const dy = parseInt(parts[2], 10);
    const dt = new Date(yr, mo, dy);
    if (!isNaN(dt)) return dt;
  }
  const dt = new Date(d);
  return isNaN(dt) ? null : dt;
};

const formatDateIt = (d) => {
  const dt = parseDateSafe(d);
  return dt ? dt.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '-';
};

const formatShortDate = (d) => {
  const dt = parseDateSafe(d);
  return dt ? dt.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' }) : '-';
};

const parseWorkers = (w) => {
  if (!w) return [];
  if (Array.isArray(w)) return w.map(String);
  try {
    const parsed = JSON.parse(w);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch (e) {
    // Non è JSON, gestisci formato stringa con virgole o singolo nome
  }
  return [String(w)];
};

// Funzione helper per verificare se un suggerimento è un'opzione alternativa secondaria
const isAlternativeOption = (sugg) => {
  if (!sugg) return false;
  if (sugg.is_alternative === true) return true;
  if (sugg.badge && String(sugg.badge).toLowerCase().includes('alternativa')) return true;
  if (sugg.title && String(sugg.title).toLowerCase().includes('opzione alternativa')) return true;
  if (String(sugg.id).startsWith('vac_reassign_alt_')) return true;
  return false;
};

// Funzione helper per formattare il codice prima del titolo della commessa
const formatProjectTitleWithCode = (name, code) => {
  const cleanName = name || 'Commessa';
  if (code) {
    return `[${code}] ${cleanName}`;
  }
  return cleanName;
};

// Funzioni helper per la gestione delle fasi spezzettate (budget_mode === 'custom_dates')
const getCustomDatesList = (task) => {
  if (!task || !task.custom_dates) return [];
  let list = task.custom_dates;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch (e) {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map(item => {
      if (typeof item === 'string') return { date: item, hours: 8 };
      if (item && item.date) return { date: item.date, hours: Number(item.hours) || 8 };
      return null;
    })
    .filter(Boolean);
};

const clusterCustomDates = (customDatesList) => {
  if (!customDatesList || customDatesList.length === 0) return [];

  const sorted = [...customDatesList]
    .map(item => {
      const d = typeof item === 'string' ? item : item.date;
      const h = typeof item === 'object' && item.hours !== undefined ? Number(item.hours) : 8;
      return { date: d, hours: h };
    })
    .filter(x => Boolean(x.date))
    .sort((a, b) => a.date.localeCompare(b.date));

  const clusters = [];
  let curCluster = null;

  for (const item of sorted) {
    const itemDate = new Date(item.date + 'T00:00:00');
    if (isNaN(itemDate)) continue;

    if (!curCluster) {
      curCluster = {
        startDate: itemDate,
        endDate: itemDate,
        lastDateStr: item.date,
        hours: item.hours,
        dates: [item.date]
      };
    } else {
      const prevDate = new Date(curCluster.lastDateStr + 'T00:00:00');
      const diffMs = itemDate.getTime() - prevDate.getTime();
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

      if (diffDays === 1) {
        curCluster.endDate = itemDate;
        curCluster.lastDateStr = item.date;
        curCluster.hours += item.hours;
        curCluster.dates.push(item.date);
      } else {
        clusters.push(curCluster);
        curCluster = {
          startDate: itemDate,
          endDate: itemDate,
          lastDateStr: item.date,
          hours: item.hours,
          dates: [item.date]
        };
      }
    }
  }
  if (curCluster) {
    clusters.push(curCluster);
  }

  return clusters;
};

const shiftCustomDatesList = (customDatesList, shiftWorkingDays, excludedDates = []) => {
  if (!customDatesList || customDatesList.length === 0 || !shiftWorkingDays) {
    return customDatesList || [];
  }
  return customDatesList.map(item => {
    const dStr = typeof item === 'string' ? item : item.date;
    const h = typeof item === 'object' && item.hours !== undefined ? item.hours : 8;
    const newDateStr = addWorkDaysUtil(dStr, shiftWorkingDays + 1, excludedDates);
    return { date: newDateStr, hours: h };
  });
};

export default function ReplanningGanttPreview({
  tasks = [],
  links = [],
  suggestions = [],
  projectName = '',
  projectCode = '',
  relatedProjects = {},
  projectStartDate,
  projectEndDate,
  onApplySuggestion,
  onClose,
  canManage = false,
  initialSuggestionId = 'all'
}) {
  const [selectedSuggestionId, setSelectedSuggestionId] = useState(initialSuggestionId || 'all');
  const [activeProjectId, setActiveProjectId] = useState('main');
  const [hoveredLinkId, setHoveredLinkId] = useState(null);
  const [hoveredTaskId, setHoveredTaskId] = useState(null);
  const [dayWidth, setDayWidth] = useState(26); // px per day (zoom)

  const scrollContainerRef = useRef(null);

  // Scorrimento orizzontale reattivo tramite rotellina del mouse
  const handleWheel = (e) => {
    if (scrollContainerRef.current) {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && e.deltaY !== 0) {
        scrollContainerRef.current.scrollLeft += e.deltaY;
      }
    }
  };


  // Filtra suggerimenti con modifiche applicabili
  const actionableSuggestions = useMemo(() => {
    return (suggestions || []).filter((s) => s.proposed_changes);
  }, [suggestions]);

  // Suggerimenti primari per la simulazione combinata:
  // Esclude le opzioni alternative (quelle che assegnano fasi spostandole da un addetto a un altro)
  const primaryCombinedSuggestions = useMemo(() => {
    return actionableSuggestions.filter((s) => !isAlternativeOption(s));
  }, [actionableSuggestions]);

  // Suggerimento attivo (o null per 'all')
  const activeSuggestion = useMemo(() => {
    if (selectedSuggestionId === 'all') return null;
    return actionableSuggestions.find((s) => s.id === selectedSuggestionId) || null;
  }, [selectedSuggestionId, actionableSuggestions]);

  // Calcolo delle commesse correlate impattate dalla simulazione corrente
  const impactedRelatedProjects = useMemo(() => {
    const targets = activeSuggestion ? [activeSuggestion] : primaryCombinedSuggestions;
    const projMap = new Map();

    targets.forEach((sugg) => {
      const otherList = sugg.cascade_impact?.other_projects || [];
      otherList.forEach((op) => {
        if (!op.project_id) return;
        const pId = String(op.project_id);
        const relData = relatedProjects[pId] || {};
        const pName = op.project_name || relData.project_name || 'Altra Commessa';
        const pCode = op.project_code || relData.project_code || '';

        if (!projMap.has(pId)) {
          projMap.set(pId, {
            project_id: pId,
            project_name: pName,
            project_code: pCode,
            color: relData.color || '#f59e0b',
            tasks: relData.tasks || [],
            links: relData.links || [],
            project_start_date: relData.project_start_date,
            project_end_date: relData.project_end_date,
            impacts: []
          });
        }
        projMap.get(pId).impacts.push(op);
      });
    });

    return Array.from(projMap.values());
  }, [activeSuggestion, primaryCombinedSuggestions, relatedProjects]);

  // Commessa correlata attiva (o null per commessa principale)
  const activeRelatedProject = useMemo(() => {
    if (activeProjectId === 'main') return null;
    return impactedRelatedProjects.find((p) => p.project_id === activeProjectId) || null;
  }, [activeProjectId, impactedRelatedProjects]);

  const effectiveActiveProjectId = activeRelatedProject ? activeProjectId : 'main';
  const isViewingRelated = effectiveActiveProjectId !== 'main' && activeRelatedProject !== null;

  // Calcolo della simulazione dei task della commessa principale
  const simulatedTasks = useMemo(() => {
    const directModMap = new Map();
    const cascadeModMap = new Map();

    const addCascadeTasks = (list, parentSugg) => {
      if (!list || !Array.isArray(list)) return;
      list.forEach((cs) => {
        if (cs.task_id) {
          cascadeModMap.set(String(cs.task_id), {
            sugg: parentSugg,
            cascade: cs
          });
        }
        if (cs.sub_successors && Array.isArray(cs.sub_successors)) {
          addCascadeTasks(cs.sub_successors, parentSugg);
        }
      });
    };

    // Se è selezionato 'all', applichiamo solo le modifiche primarie (escludendo le opzioni alternative secondarie)
    const targets = activeSuggestion ? [activeSuggestion] : primaryCombinedSuggestions;

    targets.forEach((sugg) => {
      if (sugg.proposed_changes) {
        directModMap.set(String(sugg.proposed_changes.task_id), {
          sugg,
          changes: sugg.proposed_changes
        });
      }
      if (sugg.cascade_impact?.same_project_tasks) {
        addCascadeTasks(sugg.cascade_impact.same_project_tasks, sugg);
      }
    });

    const taskMap = new Map();
    tasks.forEach((t) => {
      const tId = String(t.id);
      const direct = directModMap.get(tId);
      const cascade = cascadeModMap.get(tId);

      const origStart = parseDateSafe(t.start_date);
      const origEnd = parseDateSafe(t.end_date) || origStart;
      const origWorkers = parseWorkers(t.workers);
      const origCustomDates = getCustomDatesList(t);
      let simCustomDates = origCustomDates;

      let simStart = origStart;
      let simEnd = origEnd;
      let simWorkers = origWorkers;
      let status = 'unchanged'; // 'unchanged' | 'direct' | 'cascade'
      let shiftDays = 0;
      let relatedSugg = null;

      if (direct) {
        status = 'direct';
        relatedSugg = direct.sugg;
        simStart = parseDateSafe(direct.changes.start_date) || origStart;
        simEnd = parseDateSafe(direct.changes.end_date) || origEnd;
        simWorkers = direct.changes.workers || origWorkers;
        shiftDays = direct.changes.shift_working_days || 0;
        if (direct.changes.custom_dates) {
          simCustomDates = getCustomDatesList({ custom_dates: direct.changes.custom_dates });
        } else if (shiftDays > 0 && t.budget_mode === 'custom_dates') {
          simCustomDates = shiftCustomDatesList(origCustomDates, shiftDays, t.excluded_dates || []);
        }
      } else if (cascade) {
        status = 'cascade';
        relatedSugg = cascade.sugg;
        simStart = parseDateSafe(cascade.cascade.proposed_start) || origStart;
        simEnd = parseDateSafe(cascade.cascade.proposed_end) || origEnd;
        shiftDays = cascade.cascade.shift_working_days || 0;
        if (cascade.cascade.custom_dates) {
          simCustomDates = getCustomDatesList({ custom_dates: cascade.cascade.custom_dates });
        } else if (shiftDays > 0 && t.budget_mode === 'custom_dates') {
          simCustomDates = shiftCustomDatesList(origCustomDates, shiftDays, t.excluded_dates || []);
        }
      }

      if (t.budget_mode === 'custom_dates' && simCustomDates && simCustomDates.length > 0) {
        const cList = clusterCustomDates(simCustomDates);
        if (cList.length > 0) {
          simStart = cList[0].startDate;
          simEnd = cList[cList.length - 1].endDate;
        }
      }

      taskMap.set(tId, {
        ...t,
        origStart,
        origEnd,
        origWorkers,
        origCustomDates,
        simStart,
        simEnd,
        simWorkers,
        simCustomDates,
        status,
        shiftDays,
        relatedSugg
      });
    });

    // Risoluzione rigorosa dipendenze da links FS:
    // Se Fase B dipende da Fase A (link FS), Fase B DEVE iniziare solo dopo il termine di Fase A.
    // Se invece due fasi NON sono dipendenti (nessun link tra loro), non viene applicato alcun vincolo
    // e la fase indipendente mantiene le sue date autonome.
    const incomingLinksMap = new Map();
    (links || []).forEach((l) => {
      const targetId = String(l.target);
      if (!incomingLinksMap.has(targetId)) {
        incomingLinksMap.set(targetId, []);
      }
      incomingLinksMap.get(targetId).push(l);
    });

    let changed = true;
    let iterations = 0;
    while (changed && iterations < 20) {
      changed = false;
      iterations++;

      taskMap.forEach((simTask, tId) => {
        const inLinks = incomingLinksMap.get(tId) || [];
        inLinks.forEach((link) => {
          const linkType = String(link.type !== undefined ? link.type : '0');
          const lag = Number(link.lag) || 0;
          const predTask = taskMap.get(String(link.source));

          if (predTask && predTask.simEnd && (linkType === '0' || linkType === 'FS')) {
            const minStartStr = addWorkDaysUtil(predTask.simEnd, 2 + lag, simTask.excluded_dates || []);
            const minAllowedStart = parseDateSafe(minStartStr);
            if (minAllowedStart && simTask.simStart && simTask.simStart < minAllowedStart) {
              const durDays = simTask.duration || Math.max(1, countWorkingDays(simTask.simStart, simTask.simEnd, simTask.excluded_dates || []));
              const newEndStr = addWorkDaysUtil(minAllowedStart, durDays, simTask.excluded_dates || []);
              const newSimEnd = parseDateSafe(newEndStr) || minAllowedStart;

              simTask.simStart = minAllowedStart;
              simTask.simEnd = newSimEnd;
              if (simTask.status === 'unchanged') {
                simTask.status = 'cascade';
              }
              const origS = simTask.origStart;
              if (origS && minAllowedStart > origS) {
                const sDays = Math.max(1, countWorkingDays(origS, minAllowedStart, simTask.excluded_dates || []) - 1);
                simTask.shiftDays = sDays;
                if (simTask.budget_mode === 'custom_dates' && simTask.origCustomDates?.length > 0) {
                  simTask.simCustomDates = shiftCustomDatesList(simTask.origCustomDates, sDays, simTask.excluded_dates || []);
                  const cList = clusterCustomDates(simTask.simCustomDates);
                  if (cList.length > 0) {
                    simTask.simStart = cList[0].startDate;
                    simTask.simEnd = cList[cList.length - 1].endDate;
                  }
                }
              }
              changed = true;
            }
          }
        });
      });
    }

    return Array.from(taskMap.values());
  }, [tasks, links, activeSuggestion, primaryCombinedSuggestions]);

  // Calcolo dei task per commessa correlata (quando attiva) con simulazione correzioni a catena
  const relatedSimulatedTasks = useMemo(() => {
    if (!isViewingRelated || !activeRelatedProject) return [];
    const impacts = activeRelatedProject.impacts || [];

    // 1. Mappe per correzioni dirette e a cascata per questa commessa correlata
    const directCorrectionMap = new Map();
    const cascadeCorrectionMap = new Map();

    const addCascadeTasks = (cascadeList, parentCorr, parentImpact) => {
      if (!cascadeList || !Array.isArray(cascadeList)) return;
      cascadeList.forEach((cItem) => {
        if (cItem.task_id) {
          cascadeCorrectionMap.set(String(cItem.task_id), {
            cascadeItem: cItem,
            parentCorr,
            parentImpact
          });
        }
        if (cItem.sub_successors && Array.isArray(cItem.sub_successors)) {
          addCascadeTasks(cItem.sub_successors, parentCorr, parentImpact);
        }
      });
    };

    impacts.forEach((imp) => {
      if (imp.proposed_correction) {
        const corr = imp.proposed_correction;
        const cTaskId = String(corr.task_id || imp.task_id);
        directCorrectionMap.set(cTaskId, {
          corr,
          impact: imp
        });

        if (corr.cascade_tasks && Array.isArray(corr.cascade_tasks)) {
          addCascadeTasks(corr.cascade_tasks, corr, imp);
        }
      }
    });

    return (activeRelatedProject.tasks || []).map((t) => {
      const origStart = parseDateSafe(t.start_date);
      const origEnd = parseDateSafe(t.end_date) || origStart;
      const origWorkers = parseWorkers(t.workers);
      const origCustomDates = getCustomDatesList(t);
      let simCustomDates = origCustomDates;
      const tId = String(t.id);

      // Trova impatto warning originario (se presente)
      const impact = impacts.find(
        (imp) => String(imp.task_id) === tId || (imp.task_name && imp.task_name.toLowerCase() === (t.text || '').toLowerCase())
      );

      const directCorr = directCorrectionMap.get(tId);
      const cascadeCorr = cascadeCorrectionMap.get(tId);

      let status = 'unchanged';
      let simStart = origStart;
      let simEnd = origEnd;
      let shiftDays = 0;
      let isDirect = false;
      let isCascade = false;
      let peakHours = null;
      let impactedWorker = null;
      let impactMessage = null;
      let changes = null;
      let cascadeInfo = null;

      if (directCorr) {
        isDirect = true;
        status = 'direct';
        simStart = parseDateSafe(directCorr.corr.proposed_start) || origStart;
        simEnd = parseDateSafe(directCorr.corr.proposed_end) || simStart;
        shiftDays = directCorr.corr.shift_working_days || 0;
        peakHours = directCorr.impact.peak_hours;
        impactedWorker = directCorr.impact.worker;
        impactMessage = directCorr.corr.summary || directCorr.impact.message;
        changes = directCorr.corr;
        if (directCorr.corr.custom_dates) {
          simCustomDates = getCustomDatesList({ custom_dates: directCorr.corr.custom_dates });
        } else if (shiftDays > 0 && t.budget_mode === 'custom_dates') {
          simCustomDates = shiftCustomDatesList(origCustomDates, shiftDays, t.excluded_dates || []);
        }
      } else if (cascadeCorr) {
        isCascade = true;
        status = 'cascade';
        simStart = parseDateSafe(cascadeCorr.cascadeItem.proposed_start) || origStart;
        simEnd = parseDateSafe(cascadeCorr.cascadeItem.proposed_end) || simStart;
        shiftDays = cascadeCorr.cascadeItem.shift_working_days || 0;
        cascadeInfo = cascadeCorr.cascadeItem;
        impactMessage = `Slittamento a cascata a catena (+${shiftDays} gg)`;
        if (cascadeCorr.cascadeItem.custom_dates) {
          simCustomDates = getCustomDatesList({ custom_dates: cascadeCorr.cascadeItem.custom_dates });
        } else if (shiftDays > 0 && t.budget_mode === 'custom_dates') {
          simCustomDates = shiftCustomDatesList(origCustomDates, shiftDays, t.excluded_dates || []);
        }
      } else if (impact) {
        status = impact.status === 'warning' ? 'warning' : 'safe';
        peakHours = impact.peak_hours;
        impactedWorker = impact.worker;
        impactMessage = impact.message;
      } else {
        const workerMatch = impacts.find((imp) => origWorkers.includes(imp.worker));
        if (workerMatch) {
          status = workerMatch.status === 'warning' ? 'warning' : 'safe';
          peakHours = workerMatch.peak_hours;
          impactedWorker = workerMatch.worker;
          impactMessage = workerMatch.message;
        }
      }

      if (t.budget_mode === 'custom_dates' && simCustomDates && simCustomDates.length > 0) {
        const cList = clusterCustomDates(simCustomDates);
        if (cList.length > 0) {
          simStart = cList[0].startDate;
          simEnd = cList[cList.length - 1].endDate;
        }
      }

      return {
        id: tId,
        text: t.text,
        origStart,
        origEnd,
        origWorkers,
        origCustomDates,
        simStart,
        simEnd,
        simWorkers: origWorkers,
        simCustomDates,
        status,
        shiftDays,
        peakHours,
        impactedWorker,
        impactMessage,
        isCascade,
        isDirect,
        isRelatedImpact: !isDirect && !isCascade && status === 'warning',
        changes,
        cascadeInfo,
        duration: t.duration,
        progress: t.progress
      };
    });
  }, [isViewingRelated, activeRelatedProject]);

  // Dati attivi per la visualizzazione corrente
  const activeProjectTasks = isViewingRelated ? relatedSimulatedTasks : simulatedTasks;
  const activeProjectStart = isViewingRelated ? activeRelatedProject?.project_start_date : projectStartDate;
  const activeProjectEnd = isViewingRelated ? activeRelatedProject?.project_end_date : projectEndDate;

  // Calcolo intervallo temporale armonizzato a settimane piene (Lunedì - Domenica)
  const { timelineStart, totalDays, monthsList, daysList } = useMemo(() => {
    let minD = parseDateSafe(activeProjectStart);
    let maxD = parseDateSafe(activeProjectEnd);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Controlla task attivi
    activeProjectTasks.forEach((t) => {
      if (t.origStart && (!minD || t.origStart < minD)) minD = new Date(t.origStart);
      if (t.origEnd && (!maxD || t.origEnd > maxD)) maxD = new Date(t.origEnd);
      if (t.simStart && (!minD || t.simStart < minD)) minD = new Date(t.simStart);
      if (t.simEnd && (!maxD || t.simEnd > maxD)) maxD = new Date(t.simEnd);
    });

    if (today && (!minD || today < minD)) minD = new Date(today);
    if (today && (!maxD || today > maxD)) maxD = new Date(today);

    // Assicurati che le date esplicite di commessa siano sempre coperte al 100%
    const explicitStart = parseDateSafe(activeProjectStart);
    const explicitEnd = parseDateSafe(activeProjectEnd);
    if (explicitStart && (!minD || explicitStart < minD)) minD = new Date(explicitStart);
    if (explicitEnd && (!maxD || explicitEnd > maxD)) maxD = new Date(explicitEnd);

    if (!minD) minD = new Date(today);
    if (!maxD) {
      maxD = new Date(minD);
      maxD.setDate(maxD.getDate() + 30);
    }

    // Allinea minD al Lunedì precedente (o stesso giorno se già Lunedì) - 7 giorni di respiro a sinistra
    const startMon = new Date(minD);
    startMon.setHours(0, 0, 0, 0);
    const dayOfWeek = startMon.getDay(); // 0 = Dom, 1 = Lun
    const diffToMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    startMon.setDate(startMon.getDate() - diffToMon - 7);

    // Allinea maxD alla Domenica successiva + 2 settimane di respiro oltre la fine
    const endSun = new Date(maxD);
    endSun.setHours(0, 0, 0, 0);
    const endDow = endSun.getDay();
    const diffToSun = endDow === 0 ? 0 : 7 - endDow;
    endSun.setDate(endSun.getDate() + diffToSun + 14);

    const diffMs = endSun.getTime() - startMon.getTime();
    const totDays = Math.max(14, Math.round(diffMs / (1000 * 60 * 60 * 24)));

    // Costruisci lista giorni per la timeline
    const days = [];
    for (let d = 0; d < totDays; d++) {
      const dDate = new Date(startMon);
      dDate.setDate(dDate.getDate() + d);
      const dow = dDate.getDay(); // 0 = Dom, 6 = Sab
      const isWeekend = dow === 0 || dow === 6;
      const isToday = dDate.getTime() === today.getTime();
      const dayNum = dDate.getDate();
      const dayNameShort = dDate.toLocaleDateString('it-IT', { weekday: 'narrow' }).toUpperCase();

      days.push({
        dayIndex: d,
        date: dDate,
        dayNum,
        dayNameShort,
        isWeekend,
        isToday,
        offsetDays: d
      });
    }

    // Costruisci lista mesi
    const months = [];
    let currentMonthName = '';
    let currentMonthObj = null;

    for (let d = 0; d < totDays; d++) {
      const dateForDay = new Date(startMon);
      dateForDay.setDate(dateForDay.getDate() + d);
      const mName = dateForDay.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' }).toUpperCase();

      if (mName !== currentMonthName) {
        if (currentMonthObj) {
          months.push(currentMonthObj);
        }
        currentMonthName = mName;
        currentMonthObj = {
          name: mName,
          startDay: d,
          daysCount: 1
        };
      } else if (currentMonthObj) {
        currentMonthObj.daysCount++;
      }
    }
    if (currentMonthObj) {
      months.push(currentMonthObj);
    }

    return { timelineStart: startMon, totalDays: totDays, monthsList: months, daysList: days };
  }, [activeProjectStart, activeProjectEnd, activeProjectTasks]);

  // Coordinate di posizionamento in pixel
  const getDayOffset = (d) => {
    if (!d) return 0;
    const ms = d.getTime() - timelineStart.getTime();
    return ms / (1000 * 60 * 60 * 24);
  };

  const getLeftPx = (d) => {
    return Math.max(0, getDayOffset(d) * dayWidth);
  };

  const getWidthPx = (startD, endD) => {
    if (!startD || !endD) return dayWidth;
    const diff = getDayOffset(endD) - getDayOffset(startD) + 1;
    return Math.max(dayWidth, diff * dayWidth);
  };

  // Posizione Oggi, Inizio Commessa e Scadenza Finale
  const today = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }, []);
  const todayLeftPx = getLeftPx(today);

  const explicitProjectStart = parseDateSafe(activeProjectStart);
  const derivedProjectStart = useMemo(() => {
    if (explicitProjectStart) return explicitProjectStart;
    let minD = null;
    activeProjectTasks.forEach((t) => {
      if (t.origStart && (!minD || t.origStart < minD)) minD = t.origStart;
    });
    return minD;
  }, [explicitProjectStart, activeProjectTasks]);

  const startDate = derivedProjectStart;
  const startLeftPx = startDate ? getLeftPx(startDate) : null;

  const deadlineDate = parseDateSafe(activeProjectEnd);
  const deadlineLeftPx = deadlineDate ? getLeftPx(deadlineDate) : null;

  const scrollToStart = () => {
    if (scrollContainerRef.current) {
      const target = startLeftPx !== null ? Math.max(0, startLeftPx - 100) : 0;
      scrollContainerRef.current.scrollTo({ left: target, behavior: 'smooth' });
    }
  };

  const scrollToToday = () => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({ left: Math.max(0, todayLeftPx - 260), behavior: 'smooth' });
    }
  };

  const scrollToEnd = () => {
    if (scrollContainerRef.current) {
      const target = deadlineLeftPx ? Math.max(0, deadlineLeftPx - 340) : scrollContainerRef.current.scrollWidth;
      scrollContainerRef.current.scrollTo({ left: target, behavior: 'smooth' });
    }
  };

  // Visualizza sempre tutte le fasi
  const displayedTasks = activeProjectTasks;

  const directCount = useMemo(() => {
    return activeProjectTasks.filter((t) => t.status === 'direct' || t.isDirect).length;
  }, [activeProjectTasks]);

  const cascadeCount = useMemo(() => {
    return activeProjectTasks.filter((t) => t.status === 'cascade' || t.isCascade).length;
  }, [activeProjectTasks]);

  const relatedImpactCount = useMemo(() => {
    return relatedSimulatedTasks.filter((t) => t.isDirect || t.isCascade || t.isRelatedImpact).length;
  }, [relatedSimulatedTasks]);
  const totalTimelineWidth = totalDays * dayWidth;

  // Collegamenti / Dipendenze della commessa attiva
  const activeProjectLinks = useMemo(() => {
    return isViewingRelated ? (activeRelatedProject?.links || []) : (links || []);
  }, [isViewingRelated, activeRelatedProject, links]);

  // Mappa predecessori per ciascun task (utile per sidebar e visualizzazione)
  const predecessorsMap = useMemo(() => {
    const map = new Map();
    const allTasksMap = new Map();
    activeProjectTasks.forEach((t) => allTasksMap.set(String(t.id), t));

    (activeProjectLinks || []).forEach((l, idx) => {
      const targetId = String(l.target);
      const sourceId = String(l.source);
      const predTask = allTasksMap.get(sourceId);
      if (predTask) {
        if (!map.has(targetId)) {
          map.set(targetId, []);
        }
        map.get(targetId).push({
          id: predTask.id,
          text: predTask.text,
          isDirect: predTask.status === 'direct' || predTask.isDirect,
          isCascade: predTask.status === 'cascade' || predTask.isCascade,
          linkType: l.type !== undefined ? l.type : '0',
          lag: l.lag || 0,
          linkId: l.id ? String(l.id) : `link-${sourceId}-${targetId}-${idx}`
        });
      }
    });
    return map;
  }, [activeProjectTasks, activeProjectLinks]);

  // Altezza riga uniforme tra Sidebar, Griglia Canvas e Overlay SVG
  const getRowHeight = (task) => {
    const isDirect = task.status === 'direct' || task.isDirect;
    const isCascade = task.status === 'cascade' || task.isCascade;
    return (isDirect || isCascade) ? 68 : 46;
  };

  // Mappa coordinate pixel esatte di ciascuna riga e barra visualizzata
  const taskLayoutMap = useMemo(() => {
    const map = new Map();
    let currentTop = 0;
    displayedTasks.forEach((task, index) => {
      const isDirect = task.status === 'direct' || task.isDirect;
      const isCascade = task.status === 'cascade' || task.isCascade;
      const isModified = isDirect || isCascade;
      const rowHeight = getRowHeight(task);

      const simLeft = getLeftPx(task.simStart);
      const simWidth = getWidthPx(task.simStart, task.simEnd);
      const simRight = simLeft + simWidth;

      const origLeft = getLeftPx(task.origStart);
      const origWidth = getWidthPx(task.origStart, task.origEnd);
      const origRight = origLeft + origWidth;

      const barTop = isModified ? 36 : Math.round((rowHeight - 24) / 2);
      const centerY = currentTop + barTop + 12;

      map.set(String(task.id), {
        task,
        index,
        rowTop: currentTop,
        rowHeight,
        barTop,
        isModified,
        isDirect,
        isCascade,
        simLeft,
        simRight,
        simWidth,
        origLeft,
        origRight,
        origWidth,
        centerY
      });

      currentTop += rowHeight;
    });
    return { map, totalHeight: currentTop };
  }, [displayedTasks, dayWidth, timelineStart, predecessorsMap]);

  // Calcolo percorso ortogonale SVG per collegamento dipendenze
  const getLinkPath = (x1, y1, x2, y2, linkType = '0') => {
    const typeStr = String(linkType);
    const arrowGap = 4;
    const targetX = Math.max(0, x2 - arrowGap);

    if (typeStr === '1' || typeStr === 'SS') {
      const minX = Math.min(x1, targetX) - 16;
      return `M ${x1} ${y1} L ${minX} ${y1} L ${minX} ${y2} L ${targetX} ${y2}`;
    }

    if (typeStr === '2' || typeStr === 'FF') {
      const maxX = Math.max(x1, x2) + 16;
      return `M ${x1} ${y1} L ${maxX} ${y1} L ${maxX} ${y2} L ${x2 + arrowGap} ${y2}`;
    }

    // Finish to Start (FS)
    if (targetX >= x1 + 14) {
      const midX = Math.round(x1 + (targetX - x1) / 2);
      return `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${targetX} ${y2}`;
    } else {
      const exitX = x1 + 12;
      const enterX = Math.max(8, targetX - 12);
      const midY = Math.round((y1 + y2) / 2);
      return `M ${x1} ${y1} L ${exitX} ${y1} L ${exitX} ${midY} L ${enterX} ${midY} L ${enterX} ${y2} L ${targetX} ${y2}`;
    }
  };

  // Tracciati SVG calcolati per tutte le dipendenze
  const renderedLinks = useMemo(() => {
    const list = [];
    (activeProjectLinks || []).forEach((link, idx) => {
      const sId = String(link.source);
      const tId = String(link.target);
      const sourcePos = taskLayoutMap.map.get(sId);
      const targetPos = taskLayoutMap.map.get(tId);

      if (sourcePos && targetPos) {
        const linkType = String(link.type !== undefined ? link.type : '0');
        let x1 = sourcePos.simRight;
        let y1 = sourcePos.centerY;
        let x2 = targetPos.simLeft;
        let y2 = targetPos.centerY;

        if (linkType === '1' || linkType === 'SS') {
          x1 = sourcePos.simLeft;
          x2 = targetPos.simLeft;
        } else if (linkType === '2' || linkType === 'FF') {
          x1 = sourcePos.simRight;
          x2 = targetPos.simRight;
        }

        const d = getLinkPath(x1, y1, x2, y2, linkType);
        const isTargetCascade = targetPos.isCascade;
        const isTargetDirect = targetPos.isDirect;
        const isSourceModified = sourcePos.isModified;
        const linkKey = link.id ? String(link.id) : `link-${sId}-${tId}-${idx}`;
        const isHovered =
          hoveredLinkId === linkKey ||
          hoveredTaskId === sId ||
          hoveredTaskId === tId;

        list.push({
          id: linkKey,
          sourceId: sId,
          targetId: tId,
          sourcePos,
          targetPos,
          linkType,
          lag: link.lag || 0,
          d,
          isTargetCascade,
          isTargetDirect,
          isSourceModified,
          isHovered
        });
      }
    });
    return list;
  }, [activeProjectLinks, taskLayoutMap, hoveredLinkId, hoveredTaskId]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.75)',
        backdropFilter: 'blur(6px)',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        overflow: 'hidden'
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '1440px',
          height: '92vh',
          backgroundColor: '#ffffff',
          borderRadius: '20px',
          boxShadow: '0 25px 60px -15px rgba(0, 0, 0, 0.4)',
          border: '1px solid #e2e8f0',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* HEADER MODALE */}
        <div
          style={{
            padding: '16px 24px',
            background: 'linear-gradient(135deg, rgba(37, 99, 235, 0.08), rgba(99, 102, 241, 0.04))',
            borderBottom: '1px solid #e2e8f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 42,
                height: 42,
                minWidth: 42,
                maxWidth: 42,
                minHeight: 42,
                maxHeight: 42,
                flexShrink: 0,
                borderRadius: '10px',
                background: 'linear-gradient(135deg, #2563eb, #4f46e5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                boxShadow: '0 4px 12px rgba(37, 99, 235, 0.25)',
                alignSelf: 'center'
              }}
            >
              <Eye size={20} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#0f172a' }}>
                  Anteprima Simulazione Gantt
                </h3>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    padding: '2px 8px',
                    borderRadius: '12px',
                    background: '#e0f2fe',
                    color: '#0369a1',
                    border: '1px solid rgba(3, 105, 161, 0.2)'
                  }}
                >
                  Simulazione Attiva
                </span>
              </div>
              <p style={{ margin: '3px 0 0', fontSize: 12, color: '#64748b', lineHeight: 1.4 }}>
                <span>
                  Confronto visivo tra <strong>Stato Attuale</strong> (barra tratteggiata) e <strong>Nuovo Stato Riprogrammato</strong> (barra piena).
                </span>
                {selectedSuggestionId === 'all' && actionableSuggestions.length > primaryCombinedSuggestions.length && (
                  <span style={{ display: 'block', marginTop: 3, color: '#4338ca', fontWeight: 500 }}>
                    Le opzioni alternative sono escluse dalla combinazione e selezionabili singolarmente.
                  </span>
                )}
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Selettore Simulazione */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#475569' }}>Simula:</span>
              <select
                value={selectedSuggestionId}
                onChange={(e) => setSelectedSuggestionId(e.target.value)}
                style={{
                  padding: '6px 12px',
                  borderRadius: '8px',
                  border: '1px solid #cbd5e1',
                  background: '#ffffff',
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#1e293b',
                  cursor: 'pointer',
                  outline: 'none',
                  maxWidth: '380px'
                }}
              >
                <option value="all">
                  Tutte le modifiche combinate ({primaryCombinedSuggestions.length} azioni principali)
                </option>
                {actionableSuggestions.map((s, idx) => {
                  const isAlt = isAlternativeOption(s);
                  return (
                    <option key={s.id} value={s.id}>
                      {idx + 1}. {s.title} {isAlt ? '• (Opzione Alternativa)' : ''}
                    </option>
                  );
                })}
              </select>
            </div>

            {/* Navigazione Rapida Inizio / Oggi / Fine */}
            <div style={{ display: 'flex', alignItems: 'center', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '2px', gap: '2px' }}>
              <button
                type="button"
                onClick={scrollToStart}
                title="Scorri a inizio commessa"
                style={{
                  border: 'none',
                  background: 'transparent',
                  padding: '5px 8px',
                  cursor: 'pointer',
                  borderRadius: '6px',
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#16a34a'
                }}
              >
                Inizio
              </button>
              <div style={{ width: 1, height: 14, background: '#cbd5e1' }} />
              <button
                type="button"
                onClick={scrollToToday}
                title="Scorri a oggi"
                style={{
                  border: 'none',
                  background: 'transparent',
                  padding: '5px 8px',
                  cursor: 'pointer',
                  borderRadius: '6px',
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#2563eb'
                }}
              >
                Oggi
              </button>
              <div style={{ width: 1, height: 14, background: '#cbd5e1' }} />
              <button
                type="button"
                onClick={scrollToEnd}
                title="Scorri a fine commessa / Scadenza Commessa"
                style={{
                  border: 'none',
                  background: 'transparent',
                  padding: '5px 8px',
                  cursor: 'pointer',
                  borderRadius: '6px',
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#059669'
                }}
              >
                Fine
              </button>
            </div>

            {/* Controlli Zoom Scala */}
            <div style={{ display: 'flex', alignItems: 'center', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '2px' }}>
              <button
                onClick={() => setDayWidth((prev) => Math.max(16, prev - 4))}
                title="Riduci zoom (-)"
                style={{
                  border: 'none',
                  background: 'transparent',
                  padding: '5px 8px',
                  cursor: 'pointer',
                  borderRadius: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <ZoomOut size={14} color="#475569" />
              </button>
              <div style={{ width: 1, height: 14, background: '#cbd5e1' }} />
              <button
                onClick={() => setDayWidth((prev) => Math.min(48, prev + 4))}
                title="Aumenta zoom (+)"
                style={{
                  border: 'none',
                  background: 'transparent',
                  padding: '5px 8px',
                  cursor: 'pointer',
                  borderRadius: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <ZoomIn size={14} color="#475569" />
              </button>
            </div>

            {/* Pulsante Chiudi */}
            <button
              onClick={onClose}
              style={{
                background: '#f1f5f9',
                border: '1px solid #cbd5e1',
                borderRadius: '8px',
                width: 32,
                height: 32,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#64748b',
                cursor: 'pointer'
              }}
              title="Chiudi anteprima"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* BARRA DI NAVIGAZIONE SCHEDE COMMESSE (SE CI SONO COMMESSE CORRELATE IMPATTATE) */}
        {impactedRelatedProjects.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 24px',
              background: '#f8fafc',
              borderBottom: '1px solid #e2e8f0',
              overflowX: 'auto'
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginRight: 4 }}>
              Commesse:
            </span>

            {/* Scheda Commessa Principale */}
            <button
              type="button"
              onClick={() => setActiveProjectId('main')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 14px',
                borderRadius: '8px',
                border: effectiveActiveProjectId === 'main' ? '2px solid #2563eb' : '1px solid #cbd5e1',
                background: effectiveActiveProjectId === 'main' ? '#eff6ff' : '#ffffff',
                color: effectiveActiveProjectId === 'main' ? '#1e40af' : '#475569',
                fontWeight: effectiveActiveProjectId === 'main' ? 700 : 500,
                fontSize: 12,
                cursor: 'pointer',
                boxShadow: effectiveActiveProjectId === 'main' ? '0 2px 5px rgba(37, 99, 235, 0.15)' : 'none',
                transition: 'all 0.15s ease'
              }}
            >
              <Layers size={14} color={effectiveActiveProjectId === 'main' ? '#2563eb' : '#64748b'} />
              <span>{formatProjectTitleWithCode(projectName || 'Commessa Principale', projectCode)}</span>
              <span
                style={{
                  fontSize: 10,
                  padding: '1px 6px',
                  borderRadius: '10px',
                  background: effectiveActiveProjectId === 'main' ? '#2563eb' : '#f1f5f9',
                  color: effectiveActiveProjectId === 'main' ? '#ffffff' : '#64748b',
                  fontWeight: 700
                }}
              >
                Principale
              </span>
            </button>

            {/* Schede Commesse Correlate Impattate */}
            {impactedRelatedProjects.map((relProj) => {
              const isActive = effectiveActiveProjectId === relProj.project_id;
              const warningCount = relProj.impacts.filter((imp) => imp.status === 'warning').length;
              return (
                <button
                  key={relProj.project_id}
                  type="button"
                  onClick={() => setActiveProjectId(relProj.project_id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 14px',
                    borderRadius: '8px',
                    border: isActive ? '2px solid #7c3aed' : '1px solid #ddd6fe',
                    background: isActive ? '#f5f3ff' : '#ffffff',
                    color: isActive ? '#5b21b6' : '#6d28d9',
                    fontWeight: isActive ? 700 : 500,
                    fontSize: 12,
                    cursor: 'pointer',
                    boxShadow: isActive ? '0 2px 5px rgba(124, 58, 237, 0.15)' : 'none',
                    transition: 'all 0.15s ease'
                  }}
                >
                  <Sparkles size={14} color={isActive ? '#7c3aed' : '#8b5cf6'} />
                  <span>{formatProjectTitleWithCode(relProj.project_name, relProj.project_code)}</span>
                  <span
                    style={{
                      fontSize: 10,
                      padding: '1px 6px',
                      borderRadius: '10px',
                      background: warningCount > 0 ? '#7c3aed' : '#10b981',
                      color: '#ffffff',
                      fontWeight: 700
                    }}
                  >
                    {warningCount > 0 ? `${warningCount} con correzione` : 'Correlata'}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* BANNER CONTESTUALE COMMESSA CORRELATA */}
        {isViewingRelated && activeRelatedProject && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 24px',
              background: '#f5f3ff',
              borderBottom: '1px solid #ddd6fe',
              color: '#5b21b6',
              fontSize: 12,
              gap: 12
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Sparkles size={16} color="#7c3aed" style={{ flexShrink: 0 }} />
              <span>
                Stai visualizzando l'anteprima della commessa correlata <strong>'{formatProjectTitleWithCode(activeRelatedProject.project_name, activeRelatedProject.project_code)}'</strong> con la <strong>simulazione delle correzioni a catena</strong> (stato originale tratteggiato e nuovo posizionamento) per riassorbire le sovrapposizioni orarie (&gt;8h/giorno) causate da <strong>{formatProjectTitleWithCode(projectName || 'Commessa Principale', projectCode)}</strong>.
              </span>
            </div>
            <button
              type="button"
              onClick={() => setActiveProjectId('main')}
              style={{
                border: '1px solid #7c3aed',
                background: '#ffffff',
                color: '#6d28d9',
                padding: '4px 12px',
                borderRadius: '6px',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
                flexShrink: 0,
                boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
              }}
            >
              ← Torna a {formatProjectTitleWithCode(projectName || 'Commessa Principale', projectCode)}
            </button>
          </div>
        )}

        {/* METRICHE E FILTRI */}
        <div
          style={{
            padding: '10px 24px',
            backgroundColor: '#f8fafc',
            borderBottom: '1px solid #e2e8f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
            fontSize: 12
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            {isViewingRelated ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#7c3aed' }} />
                  <span style={{ color: '#475569' }}>Correzioni a Catena:</span>
                  <strong style={{ color: '#6d28d9' }}>{directCount}</strong>
                </div>
                {cascadeCount > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#f59e0b' }} />
                    <span style={{ color: '#475569' }}>Cascata Correlata:</span>
                    <strong style={{ color: '#b45309' }}>{cascadeCount}</strong>
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: '#64748b' }}>Totale Fasi Commessa:</span>
                  <strong style={{ color: '#0f172a' }}>{activeProjectTasks.length}</strong>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#6366f1' }} />
                  <span style={{ color: '#475569' }}>Riprogrammazioni Dirette:</span>
                  <strong style={{ color: '#0f172a' }}>{directCount}</strong>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#f59e0b' }} />
                  <span style={{ color: '#475569' }}>Slittamenti a Cascata:</span>
                  <strong style={{ color: '#0f172a' }}>{cascadeCount}</strong>
                </div>
              </>
            )}

            {startDate && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Calendar size={15} color="#16a34a" />
                <span style={{ color: '#475569' }}>Inizio Commessa:</span>
                <strong style={{ color: '#16a34a' }}>{formatDateIt(startDate)}</strong>
              </div>
            )}

            {deadlineDate && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <ShieldCheck size={15} color="#10b981" />
                <span style={{ color: '#475569' }}>Scadenza Commessa:</span>
                <strong style={{ color: '#059669' }}>{formatDateIt(deadlineDate)}</strong>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>

            {!isViewingRelated && canManage && (
              activeSuggestion ? (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    if (onApplySuggestion) {
                      onApplySuggestion(activeSuggestion);
                    }
                  }}
                  style={{
                    padding: '6px 14px',
                    fontSize: 12,
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    background: '#2563eb'
                  }}
                  title="Applica questa singola proposta di ottimizzazione"
                >
                  <CheckCircle size={14} />
                  Applica Questa Modifica
                </button>
              ) : selectedSuggestionId === 'all' && primaryCombinedSuggestions.length > 0 ? (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    if (onApplySuggestion) {
                      onApplySuggestion({
                        isBatch: true,
                        suggestions: primaryCombinedSuggestions,
                        count: primaryCombinedSuggestions.length,
                        action_label: `Applicazione di ${primaryCombinedSuggestions.length} modifiche consigliate`
                      });
                    }
                  }}
                  style={{
                    padding: '6px 14px',
                    fontSize: 12,
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    background: '#2563eb'
                  }}
                  title="Applica contemporaneamente tutte le azioni consigliate simulate (escluse le opzioni alternative)"
                >
                  <CheckCircle size={14} />
                  Applica Modifiche Consigliate ({primaryCombinedSuggestions.length})
                </button>
              ) : null
            )}
          </div>
        </div>

        {/* CONTAINER SCROLLABILE GANTT */}
        <div
          ref={scrollContainerRef}
          onWheel={handleWheel}
          style={{
            flex: 1,
            overflow: 'auto',
            backgroundColor: '#ffffff',
            position: 'relative',
            scrollbarWidth: 'thin',
            scrollbarColor: '#94a3b8 #f1f5f9'
          }}
        >
          <div style={{ display: 'flex', minWidth: `${360 + totalTimelineWidth}px` }}>
            {/* COLONNA SINISTRA: ELENCO FASI (STICKY) */}
            <div
              style={{
                width: '360px',
                minWidth: '360px',
                position: 'sticky',
                left: 0,
                backgroundColor: '#ffffff',
                borderRight: '2px solid #cbd5e1',
                zIndex: 20,
                boxShadow: '4px 0 10px rgba(0, 0, 0, 0.04)'
              }}
            >
              {/* Header colonna sinistra */}
              <div
                style={{
                  height: '56px',
                  borderBottom: '2px solid #cbd5e1',
                  backgroundColor: '#f8fafc',
                  padding: '0 16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontWeight: 700,
                  fontSize: 12,
                  color: '#475569',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px'
                }}
              >
                <span>Fase / Stato</span>
                <span>Addetti</span>
              </div>

              {/* Righe elenco fasi */}
              {displayedTasks.map((task) => {
                const isDirect = task.status === 'direct';
                const isCascade = task.status === 'cascade';
                const isModified = isDirect || isCascade;
                const rowHeight = getRowHeight(task);
                const isHovered = hoveredTaskId === String(task.id);

                return (
                  <div
                    key={task.id}
                    onMouseEnter={() => setHoveredTaskId(String(task.id))}
                    onMouseLeave={() => setHoveredTaskId(null)}
                    style={{
                      height: `${rowHeight}px`,
                      borderBottom: '1px solid #e2e8f0',
                      padding: '0 16px',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'center',
                      transition: 'background-color 0.15s ease',
                      backgroundColor: isHovered
                        ? '#eff6ff'
                        : isDirect
                          ? 'rgba(99, 102, 241, 0.04)'
                          : isCascade
                            ? 'rgba(245, 158, 11, 0.04)'
                            : task.isRelatedImpact
                              ? 'rgba(245, 158, 11, 0.06)'
                              : '#ffffff'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: (isModified || task.isRelatedImpact) ? 700 : 500,
                          color: task.isRelatedImpact ? '#92400e' : isModified ? '#0f172a' : '#334155',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}
                        title={task.text}
                      >
                        {task.text}
                      </span>
                      {isDirect && (
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            padding: '1px 6px',
                            borderRadius: '4px',
                            background: '#ede9fe',
                            color: '#6d28d9',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {isViewingRelated ? 'Correzione' : 'Modifica'}
                        </span>
                      )}
                      {isCascade && (
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            padding: '1px 6px',
                            borderRadius: '4px',
                            background: '#fef3c7',
                            color: '#b45309',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          Cascata
                        </span>
                      )}
                      {task.isRelatedImpact && !isModified && (
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            padding: '1px 6px',
                            borderRadius: '4px',
                            background: '#fee2e2',
                            color: '#b91c1c',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          Sovraccarico
                        </span>
                      )}
                    </div>

                    <div
                      style={{
                        fontSize: 11,
                        color: '#64748b',
                        marginTop: 2,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 6
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {isModified && task.simWorkers?.join(', ') !== task.origWorkers?.join(', ') ? (
                          <>
                            <span style={{ textDecoration: 'line-through', color: '#94a3b8' }}>
                              {task.origWorkers.join(', ')}
                            </span>{' '}
                            → <strong style={{ color: '#2563eb' }}>{task.simWorkers.join(', ')}</strong>
                          </>
                        ) : task.isRelatedImpact && task.impactedWorker ? (
                          <span>
                            {task.origWorkers.map((w, idx) => (
                              <React.Fragment key={idx}>
                                {idx > 0 && ', '}
                                {w === task.impactedWorker ? (
                                  <strong style={{ color: '#b45309' }}>{w}</strong>
                                ) : (
                                  w
                                )}
                              </React.Fragment>
                            ))}
                          </span>
                        ) : (
                          <span>{task.simWorkers?.join(', ') || 'Nessuno'}</span>
                        )}
                      </span>

                      {task.shiftDays > 0 ? (
                        <span style={{ color: '#d97706', fontWeight: 700, fontSize: 10 }}>
                          +{task.shiftDays} gg
                        </span>
                      ) : task.isRelatedImpact && task.peakHours ? (
                        <span style={{ color: '#b45309', fontWeight: 700, fontSize: 10 }}>
                          Picco {task.peakHours}h/gg
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* AREA CANVAS TIMELINE */}
            <div
              style={{
                width: `${totalTimelineWidth}px`,
                position: 'relative',
                backgroundColor: '#ffffff'
              }}
            >
              {/* HEADER A DUE LIVELLI: MESI E SETTIMANE */}
              <div
                style={{
                  height: '56px',
                  borderBottom: '2px solid #cbd5e1',
                  backgroundColor: '#f8fafc',
                  position: 'sticky',
                  top: 0,
                  zIndex: 10
                }}
              >
                {/* LIVELLO 1: MESI */}
                <div style={{ height: '28px', borderBottom: '1px solid #e2e8f0', display: 'flex', position: 'relative' }}>
                  {monthsList.map((m, idx) => (
                    <div
                      key={idx}
                      style={{
                        position: 'absolute',
                        left: `${m.startDay * dayWidth}px`,
                        width: `${m.daysCount * dayWidth}px`,
                        height: '28px',
                        display: 'flex',
                        alignItems: 'center',
                        paddingLeft: '10px',
                        fontSize: 11,
                        fontWeight: 700,
                        color: '#334155',
                        borderRight: '1px solid #cbd5e1',
                        backgroundColor: idx % 2 === 0 ? 'rgba(241, 245, 249, 0.7)' : 'rgba(248, 250, 252, 0.7)',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {m.name}
                    </div>
                  ))}
                </div>

                {/* LIVELLO 2: GIORNI */}
                <div style={{ height: '28px', display: 'flex', position: 'relative' }}>
                  {daysList.map((day) => (
                    <div
                      key={day.dayIndex}
                      style={{
                        position: 'absolute',
                        left: `${day.offsetDays * dayWidth}px`,
                        width: `${dayWidth}px`,
                        height: '28px',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRight: '1px solid #e2e8f0',
                        backgroundColor: day.isToday
                          ? '#eff6ff'
                          : day.isWeekend
                            ? 'rgba(241, 245, 249, 0.85)'
                            : '#ffffff',
                        color: day.isToday
                          ? '#2563eb'
                          : day.isWeekend
                            ? '#94a3b8'
                            : '#334155',
                        fontWeight: day.isToday ? 700 : day.isWeekend ? 500 : 600,
                        overflow: 'hidden',
                        userSelect: 'none'
                      }}
                      title={`${formatDateIt(day.date)}${day.isToday ? ' (Oggi)' : ''}${day.isWeekend ? ' (Weekend)' : ''}`}
                    >
                      <span style={{ fontSize: dayWidth < 22 ? 9 : 11, lineHeight: 1 }}>{day.dayNum}</span>
                      {dayWidth >= 20 && (
                        <span style={{ fontSize: 8, opacity: day.isToday ? 1 : 0.7, marginTop: 1 }}>
                          {day.dayNameShort}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* GRIGLIA VERTICALE DI SFONDO (GIORNI) */}
              <div
                style={{
                  position: 'absolute',
                  top: '56px',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  pointerEvents: 'none',
                  zIndex: 1
                }}
              >
                {daysList.map((day) => (
                  <div
                    key={day.dayIndex}
                    style={{
                      position: 'absolute',
                      left: `${day.offsetDays * dayWidth}px`,
                      top: 0,
                      bottom: 0,
                      width: `${dayWidth}px`,
                      borderRight: '1px solid #f1f5f9',
                      backgroundColor: day.isWeekend ? 'rgba(241, 245, 249, 0.45)' : 'transparent'
                    }}
                  />
                ))}

                {/* LINEA VERTICALE: OGGI */}
                <div
                  style={{
                    position: 'absolute',
                    left: `${todayLeftPx}px`,
                    top: 0,
                    bottom: 0,
                    width: '2px',
                    backgroundColor: '#2563eb',
                    zIndex: 15
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      top: '2px',
                      left: '4px',
                      fontSize: 9,
                      fontWeight: 700,
                      color: '#ffffff',
                      background: '#2563eb',
                      padding: '1px 5px',
                      borderRadius: '3px',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    Oggi: {formatShortDate(today)}
                  </div>
                </div>

                {/* LINEA VERTICALE: INIZIO COMMESSA */}
                {startLeftPx !== null && (
                  <div
                    style={{
                      position: 'absolute',
                      left: `${startLeftPx}px`,
                      top: 0,
                      bottom: 0,
                      width: '2px',
                      borderLeft: '2px dashed #16a34a',
                      zIndex: 15
                    }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        top: '2px',
                        left: '4px',
                        fontSize: 9,
                        fontWeight: 700,
                        color: '#ffffff',
                        background: '#16a34a',
                        padding: '1px 5px',
                        borderRadius: '3px',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      Inizio: {formatShortDate(startDate)}
                    </div>
                  </div>
                )}

                {/* LINEA VERTICALE: SCADENZA COMMESSA */}
                {deadlineLeftPx !== null && (
                  <div
                    style={{
                      position: 'absolute',
                      left: `${deadlineLeftPx}px`,
                      top: 0,
                      bottom: 0,
                      width: '2px',
                      borderLeft: '2px dashed #dc2626',
                      zIndex: 15
                    }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        top: '2px',
                        left: '4px',
                        fontSize: 9,
                        fontWeight: 700,
                        color: '#ffffff',
                        background: '#dc2626',
                        padding: '1px 5px',
                        borderRadius: '3px',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      Scadenza: {formatShortDate(deadlineDate)}
                    </div>
                  </div>
                )}
              </div>

              {/* RIGHE DI BARRE GANTT */}
              <div style={{ position: 'relative', zIndex: 5 }}>
                {/* OVERLAY SVG DIPENDENZE */}
                <svg
                  style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: `${totalTimelineWidth}px`,
                      height: `${taskLayoutMap.totalHeight}px`,
                      pointerEvents: 'none',
                      zIndex: 9
                    }}
                  >
                    <defs>
                      <marker
                        id="arrow-default"
                        viewBox="0 0 10 10"
                        refX="8"
                        refY="5"
                        markerWidth="7"
                        markerHeight="7"
                        orient="auto"
                      >
                        <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#64748b" />
                      </marker>

                      <marker
                        id="arrow-hover"
                        viewBox="0 0 10 10"
                        refX="8"
                        refY="5"
                        markerWidth="8"
                        markerHeight="8"
                        orient="auto"
                      >
                        <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#2563eb" />
                      </marker>
                    </defs>

                    {renderedLinks.map((rl) => {
                      const isHovered = rl.isHovered;
                      const strokeColor = isHovered ? '#2563eb' : '#64748b';
                      const markerEnd = isHovered ? 'url(#arrow-hover)' : 'url(#arrow-default)';
                      const strokeWidth = isHovered ? 2.5 : 1.8;

                      return (
                        <g key={rl.id}>
                          {/* Hit area invisibile per facilitare hover e tooltip */}
                          <path
                            d={rl.d}
                            fill="none"
                            stroke="transparent"
                            strokeWidth="14"
                            style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                            onMouseEnter={() => setHoveredLinkId(rl.id)}
                            onMouseLeave={() => setHoveredLinkId(null)}
                          >
                            <title>
                              {`Dipendenza: ${rl.sourcePos.task.text} → ${rl.targetPos.task.text}${rl.lag ? ` (Lag: +${rl.lag} gg)` : ''}`}
                            </title>
                          </path>
                          {/* Tracciato visibile */}
                          <path
                            d={rl.d}
                            fill="none"
                            stroke={strokeColor}
                            strokeWidth={strokeWidth}
                            strokeLinejoin="round"
                            strokeLinecap="round"
                            markerEnd={markerEnd}
                            style={{
                              transition: 'stroke 0.15s ease, stroke-width 0.15s ease',
                              pointerEvents: 'none'
                            }}
                          />
                        </g>
                      );
                    })}
                  </svg>

                {displayedTasks.map((task) => {
                  const isDirect = task.status === 'direct';
                  const isCascade = task.status === 'cascade';
                  const isModified = isDirect || isCascade;
                  const rowHeight = getRowHeight(task);
                  const isHovered = hoveredTaskId === String(task.id);

                  // Gestione fasi spezzettate (budget_mode === 'custom_dates')
                  const isCustom = task.budget_mode === 'custom_dates';
                  const origCustomList = task.origCustomDates || getCustomDatesList(task);
                  const origClusters = isCustom && origCustomList.length > 0 ? clusterCustomDates(origCustomList) : null;

                  let simCustomList = task.simCustomDates;
                  if (isCustom && (!simCustomList || simCustomList.length === 0)) {
                    if (task.shiftDays > 0 && origCustomList.length > 0) {
                      simCustomList = shiftCustomDatesList(origCustomList, task.shiftDays, task.excluded_dates || []);
                    } else {
                      simCustomList = origCustomList;
                    }
                  }
                  const simClusters = isCustom && simCustomList && simCustomList.length > 0 ? clusterCustomDates(simCustomList) : null;

                  // Coordinate barra originale
                  const origLeft = getLeftPx(task.origStart);
                  const origWidth = getWidthPx(task.origStart, task.origEnd);

                  // Coordinate barra simulata
                  const simLeft = getLeftPx(task.simStart);
                  const simWidth = getWidthPx(task.simStart, task.simEnd);

                  return (
                    <div
                      key={task.id}
                      onMouseEnter={() => setHoveredTaskId(String(task.id))}
                      onMouseLeave={() => setHoveredTaskId(null)}
                      style={{
                        height: `${rowHeight}px`,
                        borderBottom: '1px solid #e2e8f0',
                        position: 'relative',
                        display: 'flex',
                        alignItems: 'center',
                        backgroundColor: isHovered ? 'rgba(59, 130, 246, 0.03)' : 'transparent',
                        transition: 'background-color 0.15s ease'
                      }}
                    >
                      {/* SE LA FASE È MODIFICATA: DUE CORSIE CHIARE (LANE 1: ORIGINALE, LANE 2: PROPOSTO) */}
                      {isModified ? (
                        <>
                          {/* CORSIA 1 (ALTO): STATO ORIGINALE GHOST BAR */}
                          {origClusters && origClusters.length > 0 ? (
                            origClusters.map((cluster, cIdx) => {
                              const cLeft = getLeftPx(cluster.startDate);
                              const cWidth = getWidthPx(cluster.startDate, cluster.endDate);
                              const rangeText = cluster.dates.length === 1
                                ? formatShortDate(cluster.startDate)
                                : `${formatShortDate(cluster.startDate)} - ${formatShortDate(cluster.endDate)}`;
                              return (
                                <div
                                  key={`ghost-c-${task.id}-${cIdx}`}
                                  style={{
                                    position: 'absolute',
                                    left: `${cLeft}px`,
                                    width: `${cWidth}px`,
                                    top: '8px',
                                    height: '22px',
                                    borderRadius: '5px',
                                    border: '1px dashed #94a3b8',
                                    backgroundColor: 'rgba(226, 232, 240, 0.75)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    padding: '0 4px',
                                    fontSize: 10,
                                    color: '#64748b',
                                    fontWeight: 600,
                                    zIndex: 6,
                                    overflow: 'hidden',
                                    whiteSpace: 'nowrap'
                                  }}
                                  title={`Stato Originale: ${rangeText} (${cluster.hours}h) - ${task.origWorkers.join(', ')}`}
                                >
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {cWidth >= 65 ? `${rangeText} (${cluster.hours}h)` : `${cluster.hours}h`}
                                  </span>
                                </div>
                              );
                            })
                          ) : (
                            <div
                              style={{
                                position: 'absolute',
                                left: `${origLeft}px`,
                                width: `${origWidth}px`,
                                top: '8px',
                                height: '22px',
                                borderRadius: '5px',
                                border: '1px dashed #94a3b8',
                                backgroundColor: 'rgba(226, 232, 240, 0.7)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: origWidth > 130 ? 'space-between' : 'center',
                                padding: '0 8px',
                                fontSize: 10,
                                color: '#64748b',
                                fontWeight: 600,
                                zIndex: 6,
                                overflow: 'hidden',
                                whiteSpace: 'nowrap'
                              }}
                              title={`Stato Originale: ${formatDateIt(task.origStart)} → ${formatDateIt(task.origEnd)} (${task.origWorkers.join(', ')})`}
                            >
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                Orig: {formatShortDate(task.origStart)} - {formatShortDate(task.origEnd)}
                              </span>
                              {origWidth > 130 && (
                                <span style={{ opacity: 0.8, fontSize: 9, flexShrink: 0 }}>
                                  {task.origWorkers.join(', ')}
                                </span>
                              )}
                            </div>
                          )}

                          {/* CORSIA 2 (BASSO): NUOVO STATO PROPOSTO */}
                          {simClusters && simClusters.length > 0 ? (
                            simClusters.map((cluster, cIdx) => {
                              const cLeft = getLeftPx(cluster.startDate);
                              const cWidth = getWidthPx(cluster.startDate, cluster.endDate);
                              const rangeText = cluster.dates.length === 1
                                ? formatShortDate(cluster.startDate)
                                : `${formatShortDate(cluster.startDate)} - ${formatShortDate(cluster.endDate)}`;
                              const isFirst = cIdx === 0;
                              const isLast = cIdx === simClusters.length - 1;
                              return (
                                <div
                                  key={`sim-c-${task.id}-${cIdx}`}
                                  style={{
                                    position: 'absolute',
                                    left: `${cLeft}px`,
                                    width: `${cWidth}px`,
                                    top: '36px',
                                    height: '24px',
                                    borderRadius: '5px',
                                    background: isDirect
                                      ? isViewingRelated
                                        ? 'linear-gradient(90deg, #7c3aed, #6366f1)'
                                        : 'linear-gradient(90deg, #6366f1, #4f46e5)'
                                      : 'linear-gradient(90deg, #f59e0b, #d97706)',
                                    boxShadow: '0 2px 6px rgba(0, 0, 0, 0.15)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: isFirst && cWidth >= 120 ? 'space-between' : 'center',
                                    padding: '0 6px',
                                    color: '#ffffff',
                                    fontSize: 11,
                                    fontWeight: 600,
                                    zIndex: 8,
                                    overflow: 'hidden',
                                    whiteSpace: 'nowrap'
                                  }}
                                  title={task.impactMessage ? `${task.impactMessage} | Nuovo Stato: ${rangeText} (${cluster.hours}h)` : `Nuovo Stato Proposto: ${rangeText} (${cluster.hours}h)`}
                                >
                                  {isFirst && (
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', marginRight: 4 }}>
                                      {task.text}
                                    </span>
                                  )}
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                                    <span style={{ fontSize: 9, opacity: 0.9 }}>
                                      {cWidth >= 65 ? `${rangeText} (${cluster.hours}h)` : `${cluster.hours}h`}
                                    </span>
                                    {isLast && task.shiftDays > 0 && (
                                      <span
                                        style={{
                                          padding: '1px 4px',
                                          borderRadius: '3px',
                                          background: 'rgba(0, 0, 0, 0.3)',
                                          fontSize: 9,
                                          fontWeight: 700
                                        }}
                                      >
                                        +{task.shiftDays}g
                                      </span>
                                    )}
                                  </div>
                                </div>
                              );
                            })
                          ) : (
                            <div
                              style={{
                                position: 'absolute',
                                left: `${simLeft}px`,
                                width: `${simWidth}px`,
                                top: '36px',
                                height: '24px',
                                borderRadius: '5px',
                                background: isDirect
                                  ? isViewingRelated
                                    ? 'linear-gradient(90deg, #7c3aed, #6366f1)'
                                    : 'linear-gradient(90deg, #6366f1, #4f46e5)'
                                  : 'linear-gradient(90deg, #f59e0b, #d97706)',
                                boxShadow: '0 2px 6px rgba(0, 0, 0, 0.15)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '0 8px',
                                color: '#ffffff',
                                fontSize: 11,
                                fontWeight: 600,
                                zIndex: 8,
                                overflow: 'hidden',
                                whiteSpace: 'nowrap'
                              }}
                              title={task.impactMessage ? `${task.impactMessage} | Nuovo Stato: ${formatDateIt(task.simStart)} → ${formatDateIt(task.simEnd)}` : `Nuovo Stato Proposto: ${formatDateIt(task.simStart)} → ${formatDateIt(task.simEnd)} (${task.simWorkers.join(', ')})`}
                            >
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {task.text}
                              </span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                                <span style={{ fontSize: 10, opacity: 0.9 }}>
                                  {formatShortDate(task.simStart)} - {formatShortDate(task.simEnd)}
                                </span>
                                {task.shiftDays > 0 && (
                                  <span
                                    style={{
                                      padding: '1px 5px',
                                      borderRadius: '3px',
                                      background: 'rgba(0, 0, 0, 0.3)',
                                      fontSize: 9,
                                      fontWeight: 700
                                    }}
                                  >
                                    +{task.shiftDays}g
                                  </span>
                                )}
                              </div>
                            </div>
                          )}
                        </>
                      ) : task.isRelatedImpact ? (
                        /* FASE IN SOVRACCARICO SU COMMESSA CORRELATA */
                        origClusters && origClusters.length > 0 ? (
                          origClusters.map((cluster, cIdx) => {
                            const cLeft = getLeftPx(cluster.startDate);
                            const cWidth = getWidthPx(cluster.startDate, cluster.endDate);
                            const rangeText = cluster.dates.length === 1
                              ? formatShortDate(cluster.startDate)
                              : `${formatShortDate(cluster.startDate)} - ${formatShortDate(cluster.endDate)}`;
                            const isFirst = cIdx === 0;
                            return (
                              <div
                                key={`warn-c-${task.id}-${cIdx}`}
                                style={{
                                  position: 'absolute',
                                  left: `${cLeft}px`,
                                  width: `${cWidth}px`,
                                  height: '26px',
                                  borderRadius: '6px',
                                  background: 'linear-gradient(90deg, #f59e0b, #d97706)',
                                  border: '1px solid #b45309',
                                  boxShadow: '0 2px 6px rgba(245, 158, 11, 0.25)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: isFirst && cWidth >= 120 ? 'space-between' : 'center',
                                  padding: '0 6px',
                                  color: '#ffffff',
                                  fontSize: 11,
                                  fontWeight: 600,
                                  zIndex: 8,
                                  overflow: 'hidden',
                                  whiteSpace: 'nowrap'
                                }}
                                title={task.impactMessage || `Sovraccarico: ${task.peakHours}h/gg con ${formatProjectTitleWithCode(projectName || 'Commessa Principale', projectCode)}`}
                              >
                                {isFirst && (
                                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden', textOverflow: 'ellipsis', marginRight: 4 }}>
                                    <AlertTriangle size={12} color="#ffffff" />
                                    {task.text}
                                  </span>
                                )}
                                <span style={{ fontSize: 9, opacity: 0.9, flexShrink: 0 }}>
                                  {cWidth >= 65 ? `${rangeText} (${cluster.hours}h)` : `${cluster.hours}h`}
                                </span>
                              </div>
                            );
                          })
                        ) : (
                          <div
                            style={{
                              position: 'absolute',
                              left: `${origLeft}px`,
                              width: `${origWidth}px`,
                              height: '26px',
                              borderRadius: '6px',
                              background: 'linear-gradient(90deg, #f59e0b, #d97706)',
                              border: '1px solid #b45309',
                              boxShadow: '0 2px 6px rgba(245, 158, 11, 0.25)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '0 8px',
                              color: '#ffffff',
                              fontSize: 11,
                              fontWeight: 600,
                              zIndex: 8,
                              overflow: 'hidden',
                              whiteSpace: 'nowrap'
                            }}
                            title={task.impactMessage || `Sovraccarico: ${task.peakHours}h/gg con ${formatProjectTitleWithCode(projectName || 'Commessa Principale', projectCode)}`}
                          >
                            <span style={{ display: 'flex', alignItems: 'center', gap: 5, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              <AlertTriangle size={12} color="#ffffff" />
                              {task.text}
                            </span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                              <span style={{ fontSize: 9, opacity: 0.9 }}>
                                {formatShortDate(task.origStart)} - {formatShortDate(task.origEnd)}
                              </span>
                              <span
                                style={{
                                  padding: '1px 5px',
                                  borderRadius: '3px',
                                  background: 'rgba(0, 0, 0, 0.3)',
                                  fontSize: 9,
                                  fontWeight: 700
                                }}
                              >
                                ⚠️ {task.peakHours ? `${task.peakHours}h/gg` : 'Sovraccarico'}
                              </span>
                            </div>
                          </div>
                        )
                      ) : (
                        /* FASE INVARIATA (SINGOLA CORSIA) */
                        origClusters && origClusters.length > 0 ? (
                          origClusters.map((cluster, cIdx) => {
                            const cLeft = getLeftPx(cluster.startDate);
                            const cWidth = getWidthPx(cluster.startDate, cluster.endDate);
                            const rangeText = cluster.dates.length === 1
                              ? formatShortDate(cluster.startDate)
                              : `${formatShortDate(cluster.startDate)} - ${formatShortDate(cluster.endDate)}`;
                            const isFirst = cIdx === 0;
                            return (
                              <div
                                key={`unchanged-c-${task.id}-${cIdx}`}
                                style={{
                                  position: 'absolute',
                                  left: `${cLeft}px`,
                                  width: `${cWidth}px`,
                                  top: `${Math.round((rowHeight - 24) / 2)}px`,
                                  height: '24px',
                                  borderRadius: '5px',
                                  background: 'linear-gradient(90deg, #3b82f6, #2563eb)',
                                  boxShadow: '0 1px 3px rgba(0, 0, 0, 0.08)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: isFirst && cWidth >= 120 ? 'space-between' : 'center',
                                  padding: '0 6px',
                                  color: '#ffffff',
                                  fontSize: 11,
                                  fontWeight: 500,
                                  zIndex: 6,
                                  overflow: 'hidden',
                                  whiteSpace: 'nowrap',
                                  opacity: isViewingRelated ? 0.85 : 0.95
                                }}
                                title={`Fase: ${rangeText} (${cluster.hours}h) - ${task.origWorkers.join(', ')}`}
                              >
                                {isFirst && (
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', marginRight: 4 }}>
                                    {task.text}
                                  </span>
                                )}
                                <span style={{ fontSize: 9, opacity: 0.85, flexShrink: 0 }}>
                                  {cWidth >= 65 ? `${rangeText} (${cluster.hours}h)` : `${cluster.hours}h`}
                                </span>
                              </div>
                            );
                          })
                        ) : (
                          <div
                            style={{
                              position: 'absolute',
                              left: `${origLeft}px`,
                              width: `${origWidth}px`,
                              height: '24px',
                              borderRadius: '5px',
                              background: 'linear-gradient(90deg, #3b82f6, #2563eb)',
                              boxShadow: '0 1px 3px rgba(0, 0, 0, 0.08)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '0 8px',
                              color: '#ffffff',
                              fontSize: 11,
                              fontWeight: 500,
                              zIndex: 6,
                              overflow: 'hidden',
                              whiteSpace: 'nowrap',
                              opacity: isViewingRelated ? 0.85 : 0.95
                            }}
                            title={`Fase: ${formatDateIt(task.origStart)} → ${formatDateIt(task.origEnd)} (${task.origWorkers.join(', ')})`}
                          >
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {task.text}
                            </span>
                            <span style={{ fontSize: 10, opacity: 0.85, flexShrink: 0 }}>
                              {formatShortDate(task.origStart)} - {formatShortDate(task.origEnd)}
                            </span>
                          </div>
                        )
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* FOOTER: LEGENDA ELEGANTE */}
        <div
          style={{
            padding: '12px 24px',
            background: '#f8fafc',
            borderTop: '1px solid #e2e8f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 16,
            fontSize: 12
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
            {isViewingRelated ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 14, height: 14, borderRadius: 3, background: 'linear-gradient(90deg, #7c3aed, #6366f1)' }} />
                  <span style={{ color: '#5b21b6', fontWeight: 700 }}>Correzione a Catena (+X gg)</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 14, height: 14, borderRadius: 3, background: 'linear-gradient(90deg, #f59e0b, #d97706)' }} />
                  <span style={{ color: '#92400e', fontWeight: 600 }}>Cascata Correlata</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 14, height: 14, borderRadius: 3, border: '1px dashed #94a3b8', background: 'rgba(226, 232, 240, 0.8)' }} />
                  <span style={{ color: '#64748b' }}>Stato Originale (Ghost)</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 14, height: 14, borderRadius: 3, background: 'linear-gradient(90deg, #3b82f6, #2563eb)' }} />
                  <span style={{ color: '#334155' }}>Altre Fasi Commessa</span>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 14, height: 14, borderRadius: 3, background: 'linear-gradient(90deg, #6366f1, #4f46e5)' }} />
                  <span style={{ color: '#334155', fontWeight: 600 }}>Nuova Proposta (Diretta)</span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 14, height: 14, borderRadius: 3, background: 'linear-gradient(90deg, #f59e0b, #d97706)' }} />
                  <span style={{ color: '#334155', fontWeight: 600 }}>Slittamento a Cascata</span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 14, height: 14, borderRadius: 3, border: '1px dashed #94a3b8', background: 'rgba(226, 232, 240, 0.8)' }} />
                  <span style={{ color: '#64748b' }}>Stato Originale (Ghost)</span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 14, height: 14, borderRadius: 3, background: 'linear-gradient(90deg, #3b82f6, #2563eb)' }} />
                  <span style={{ color: '#334155' }}>Fase Invariata</span>
                </div>
              </>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <svg width="22" height="10" viewBox="0 0 22 10" style={{ overflow: 'visible' }}>
                <line x1="0" y1="5" x2="15" y2="5" stroke="#64748b" strokeWidth="1.8" />
                <polygon points="15,2 21,5 15,8" fill="#64748b" />
              </svg>
              <span style={{ color: '#475569', fontWeight: 600 }}>Dipendenza tra Fasi</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 12, height: 0, borderBottom: '2px dashed #16a34a', display: 'inline-block' }} />
              <span style={{ color: '#16a34a', fontWeight: 700 }}>Inizio Commessa</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 12, height: 0, borderBottom: '2px dashed #dc2626', display: 'inline-block' }} />
              <span style={{ color: '#dc2626', fontWeight: 700 }}>Scadenza Commessa</span>
            </div>
          </div>

          <button
            className="btn btn-secondary"
            onClick={onClose}
            style={{ padding: '6px 16px', fontSize: 12 }}
          >
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
}
