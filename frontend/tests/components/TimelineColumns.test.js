import { describe, it, expect } from 'vitest';
import { TIMELINE_COLUMNS, DEFAULT_COL_WIDTHS, MIN_COL_WIDTHS, getProjectResponsible } from '../../src/components/calendar/TimelineView';

describe('Timeline Columns & Helpers', () => {
  const mockUsers = [
    { id: 101, username: 'm.rossi', full_name: 'Mario Rossi' },
    { id: 102, username: 'g.verdi', full_name: 'Giuseppe Verdi' },
  ];

  it('defines all required columns (code, name, client, responsible)', () => {
    const colIds = TIMELINE_COLUMNS.map(c => c.id);
    expect(colIds).toContain('code');
    expect(colIds).toContain('name');
    expect(colIds).toContain('client');
    expect(colIds).toContain('responsible');

    expect(TIMELINE_COLUMNS.find(c => c.id === 'code').label).toBe('Cod. Commessa');
    expect(TIMELINE_COLUMNS.find(c => c.id === 'name').label).toBe('Titolo');
    expect(TIMELINE_COLUMNS.find(c => c.id === 'client').label).toBe('Cliente');
    expect(TIMELINE_COLUMNS.find(c => c.id === 'responsible').label).toBe('Responsabile');
  });

  it('defines default and minimum column widths for resizing', () => {
    expect(DEFAULT_COL_WIDTHS.code).toBeGreaterThan(0);
    expect(DEFAULT_COL_WIDTHS.name).toBeGreaterThan(0);
    expect(DEFAULT_COL_WIDTHS.client).toBeGreaterThan(0);
    expect(DEFAULT_COL_WIDTHS.responsible).toBeGreaterThan(0);

    expect(MIN_COL_WIDTHS.code).toBeLessThanOrEqual(DEFAULT_COL_WIDTHS.code);
    expect(MIN_COL_WIDTHS.name).toBeLessThanOrEqual(DEFAULT_COL_WIDTHS.name);
  });

  describe('getProjectResponsible', () => {
    it('returns responsible_name if present', () => {
      const proj = { responsible_name: 'Ing. Bianchi' };
      expect(getProjectResponsible(proj, mockUsers)).toBe('Ing. Bianchi');
    });

    it('returns responsible_username if responsible_name is absent', () => {
      const proj = { responsible_username: 'luigi.bianchi' };
      expect(getProjectResponsible(proj, mockUsers)).toBe('luigi.bianchi');
    });

    it('resolves responsible_id from systemUsers', () => {
      const proj = { responsible_id: 101 };
      expect(getProjectResponsible(proj, mockUsers)).toBe('Mario Rossi');
    });

    it('resolves owner_id from systemUsers if responsible_id is absent', () => {
      const proj = { owner_id: 102 };
      expect(getProjectResponsible(proj, mockUsers)).toBe('Giuseppe Verdi');
    });

    it('returns "-" when no responsible or owner is found', () => {
      const proj = {};
      expect(getProjectResponsible(proj, mockUsers)).toBe('-');
    });
  });

  describe('custom_dates phases for timeline', () => {
    it('clusters non-contiguous calendar dates into separate timeline bar segments', () => {
      const task = {
        id: 99,
        text: 'scadenza 1',
        budget_mode: 'custom_dates',
        custom_dates: [
          { date: '2026-09-17', hours: 4 },
          { date: '2026-09-18', hours: 4 },
          { date: '2026-09-25', hours: 1 }
        ]
      };

      const { getCustomDatesList, clusterCustomDates } = require('../../src/utils/customDates');
      const list = getCustomDatesList(task);
      expect(list).toHaveLength(3);

      const clusters = clusterCustomDates(list);
      expect(clusters).toHaveLength(2); // Two segments: 17-18 (8h) and 25 (1h)
      expect(clusters[0].startDateStr).toBe('2026-09-17');
      expect(clusters[0].endDateStr).toBe('2026-09-18');
      expect(clusters[0].hours).toBe(8);

      expect(clusters[1].startDateStr).toBe('2026-09-25');
      expect(clusters[1].endDateStr).toBe('2026-09-25');
      expect(clusters[1].hours).toBe(1);

      const totalH = list.reduce((acc, d) => acc + d.hours, 0);
      expect(totalH).toBe(9);
    });
  });
});

