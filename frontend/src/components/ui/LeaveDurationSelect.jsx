import { LEAVE_DURATION_OPTIONS } from '../../utils/vacations';

// Selettore durata ferie: giornata intera oppure permesso a ore su un singolo giorno
export default function LeaveDurationSelect({ value, onChange, className, id }) {
  return (
    <select id={id} className={className} value={value} onChange={e => onChange(e.target.value)}>
      {LEAVE_DURATION_OPTIONS.map(opt => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}
