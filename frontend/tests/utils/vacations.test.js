import { describe, it, expect } from 'vitest';
import {
  isFullDayVacation,
  formatLeaveHours,
  leaveDurationPayload,
  leaveDurationValue,
  leaveHoursOnDate,
} from '../../src/utils/vacations';

describe('vacations utils', () => {
  it('distingue ferie intere e permessi a ore', () => {
    expect(isFullDayVacation({ hours: null })).toBe(true);
    expect(isFullDayVacation({ hours: 8 })).toBe(true);
    expect(isFullDayVacation({ hours: 2 })).toBe(false);
  });

  it('formatta le ore di permesso con la fascia della giornata', () => {
    expect(formatLeaveHours({ hours: null })).toBe('');
    expect(formatLeaveHours({ hours: 2 })).toBe('2h');
    expect(formatLeaveHours({ hours: 4, part_of_day: 'afternoon' })).toBe('4h pomeriggio');
  });

  it('converte il selettore durata in payload e ritorno', () => {
    expect(leaveDurationPayload('full')).toEqual({ hours: null, part_of_day: null });
    expect(leaveDurationPayload('morning')).toEqual({ hours: 4, part_of_day: 'morning' });
    expect(leaveDurationValue({ hours: 4, part_of_day: 'morning' })).toBe('morning');
    expect(leaveDurationValue({ hours: 3, part_of_day: null })).toBe('3h');
    expect(leaveDurationValue({ hours: null })).toBe('full');
  });

  it('somma le ore di permesso di un giorno', () => {
    const vacations = [
      { start_date: '2026-10-19', end_date: '2026-10-19', hours: 1 },
      { start_date: '2026-10-19', end_date: '2026-10-19', hours: 2 },
      { start_date: '2026-10-19', end_date: '2026-10-23', hours: null },
    ];
    expect(leaveHoursOnDate(vacations, '2026-10-19')).toBe(3);
  });
});
