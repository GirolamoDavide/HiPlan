import { describe, it, expect } from 'vitest';
import { getCustomDatesList, clusterCustomDates } from '../../src/utils/customDates';

describe('customDates utility', () => {
  describe('getCustomDatesList', () => {
    it('returns empty array when task or custom_dates is missing', () => {
      expect(getCustomDatesList(null)).toEqual([]);
      expect(getCustomDatesList({})).toEqual([]);
      expect(getCustomDatesList({ custom_dates: null })).toEqual([]);
    });

    it('parses JSON string custom_dates', () => {
      const task = {
        custom_dates: JSON.stringify([
          { date: '2026-09-16', hours: 1.5 },
          { date: '2026-09-18', hours: 2.0 }
        ])
      };
      const result = getCustomDatesList(task);
      expect(result).toEqual([
        { date: '2026-09-16', hours: 1.5 },
        { date: '2026-09-18', hours: 2.0 }
      ]);
    });

    it('normalizes string dates to 8 hours default', () => {
      const task = {
        custom_dates: ['2026-09-16', '2026-09-18']
      };
      const result = getCustomDatesList(task);
      expect(result).toEqual([
        { date: '2026-09-16', hours: 8 },
        { date: '2026-09-18', hours: 8 }
      ]);
    });
  });

  describe('clusterCustomDates', () => {
    it('returns empty array for empty inputs', () => {
      expect(clusterCustomDates([])).toEqual([]);
      expect(clusterCustomDates(null)).toEqual([]);
    });

    it('creates separate clusters for non-contiguous dates (la barra spezzettata)', () => {
      const list = [
        { date: '2026-09-16', hours: 1.5 },
        { date: '2026-09-18', hours: 2.0 },
        { date: '2026-09-23', hours: 1.0 },
        { date: '2026-09-25', hours: 2.0 }
      ];
      const clusters = clusterCustomDates(list);
      expect(clusters).toHaveLength(4);
      expect(clusters[0]).toEqual({
        startDateStr: '2026-09-16',
        endDateStr: '2026-09-16',
        hours: 1.5,
        dates: ['2026-09-16']
      });
      expect(clusters[1]).toEqual({
        startDateStr: '2026-09-18',
        endDateStr: '2026-09-18',
        hours: 2.0,
        dates: ['2026-09-18']
      });
      expect(clusters[2]).toEqual({
        startDateStr: '2026-09-23',
        endDateStr: '2026-09-23',
        hours: 1.0,
        dates: ['2026-09-23']
      });
      expect(clusters[3]).toEqual({
        startDateStr: '2026-09-25',
        endDateStr: '2026-09-25',
        hours: 2.0,
        dates: ['2026-09-25']
      });
    });

    it('groups contiguous consecutive calendar days into a single cluster', () => {
      const list = [
        { date: '2026-09-16', hours: 2.0 },
        { date: '2026-09-17', hours: 3.0 },
        { date: '2026-09-20', hours: 4.0 }
      ];
      const clusters = clusterCustomDates(list);
      expect(clusters).toHaveLength(2);
      expect(clusters[0]).toEqual({
        startDateStr: '2026-09-16',
        endDateStr: '2026-09-17',
        hours: 5.0,
        dates: ['2026-09-16', '2026-09-17']
      });
      expect(clusters[1]).toEqual({
        startDateStr: '2026-09-20',
        endDateStr: '2026-09-20',
        hours: 4.0,
        dates: ['2026-09-20']
      });
    });
  });
});
