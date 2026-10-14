// Ferie a giornata intera e permessi a ore (un solo giorno, hours < 8).

export const FULL_DAY_HOURS = 8;

export const LEAVE_DURATION_OPTIONS = [
  { value: 'full', label: 'Giornata intera', hours: null, part_of_day: null },
  { value: '1h', label: '1 ora', hours: 1, part_of_day: null },
  { value: '2h', label: '2 ore', hours: 2, part_of_day: null },
  { value: '3h', label: '3 ore', hours: 3, part_of_day: null },
  { value: 'morning', label: 'Mezza giornata – mattina (4h)', hours: 4, part_of_day: 'morning' },
  { value: 'afternoon', label: 'Mezza giornata – pomeriggio (4h)', hours: 4, part_of_day: 'afternoon' },
];

const PART_OF_DAY_LABELS = { morning: 'mattina', afternoon: 'pomeriggio' };

export function leaveDurationPayload(durationValue) {
  const opt = LEAVE_DURATION_OPTIONS.find(o => o.value === durationValue) || LEAVE_DURATION_OPTIONS[0];
  return { hours: opt.hours, part_of_day: opt.part_of_day };
}

export function isFullDayVacation(vacation) {
  return vacation?.hours == null || Number(vacation.hours) >= FULL_DAY_HOURS;
}

// Es. "2h", "4h mattina"; stringa vuota per la giornata intera
export function formatLeaveHours(vacation) {
  if (isFullDayVacation(vacation)) return '';
  const part = PART_OF_DAY_LABELS[vacation.part_of_day];
  return `${Number(vacation.hours)}h${part ? ` ${part}` : ''}`;
}

// Ore di permesso in un dato giorno (YYYY-MM-DD) per un elenco di ferie dello stesso addetto
export function leaveHoursOnDate(vacations, dateStr) {
  return (vacations || [])
    .filter(v => !isFullDayVacation(v) && v.start_date === dateStr)
    .reduce((sum, v) => sum + Number(v.hours), 0);
}

// Valore del selettore durata corrispondente a una ferie esistente (per i modali di modifica)
export function leaveDurationValue(vacation) {
  if (isFullDayVacation(vacation)) return 'full';
  const match = LEAVE_DURATION_OPTIONS.find(
    o => o.hours === Number(vacation.hours) && (o.part_of_day || null) === (vacation.part_of_day || null)
  );
  return match ? match.value : 'full';
}
