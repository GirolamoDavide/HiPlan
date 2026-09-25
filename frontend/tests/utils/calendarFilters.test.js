import { describe, it, expect, beforeEach } from 'vitest';
import {
  taskMatchesWorker,
  taskMatchesDepartment,
  vacationMatchesFilters,
} from '../../src/utils/calendarFilters';
import { CALENDAR_FILTERS_STORAGE_KEY, loadSavedFilters } from '../../src/pages/CalendarPage';

describe('calendarFilters', () => {
  const mockUsers = [
    { id: 'u1', username: 'marco_uff', full_name: 'Marco (UT)', department: 'ufficio_tecnico' },
    { id: 'u2', username: 'laura_acq', full_name: 'Laura (Acq)', department: 'acquisti' },
    { id: 'u3', username: 'franco_pro', full_name: 'Franco (Prod)', department: 'produzione' },
    { id: 'u4', username: 'topolino', full_name: 'topolino', department: 'commerciale' },
  ];

  describe('taskMatchesWorker', () => {
    it('returns true when filterWorker is "all"', () => {
      const task = { workers: ['Marco (UT)'] };
      expect(taskMatchesWorker(task, 'all', mockUsers)).toBe(true);
      expect(taskMatchesWorker(task, '', mockUsers)).toBe(true);
    });

    it('matches task worker by user full_name with department tag', () => {
      const task = { workers: ['Marco (UT)'] };
      expect(taskMatchesWorker(task, 'marco_uff', mockUsers)).toBe(true);
      expect(taskMatchesWorker(task, 'laura_acq', mockUsers)).toBe(false);
    });

    it('matches task worker by username or stripped full_name', () => {
      const taskWithUsername = { workers: ['marco_uff'] };
      expect(taskMatchesWorker(taskWithUsername, 'marco_uff', mockUsers)).toBe(true);

      const taskWithCleanName = { workers: ['Marco'] };
      expect(taskMatchesWorker(taskWithCleanName, 'marco_uff', mockUsers)).toBe(true);
    });

    it('matches task assigned_to user id or username', () => {
      const task = { assigned_to: 'u2', workers: [] };
      expect(taskMatchesWorker(task, 'laura_acq', mockUsers)).toBe(true);
      expect(taskMatchesWorker(task, 'marco_uff', mockUsers)).toBe(false);
    });
  });

  describe('taskMatchesDepartment', () => {
    it('returns true when filterDepartment is "all"', () => {
      const task = { department: 'produzione' };
      expect(taskMatchesDepartment(task, 'all', mockUsers)).toBe(true);
    });

    it('matches task department directly', () => {
      const task = { department: 'acquisti' };
      expect(taskMatchesDepartment(task, 'acquisti', mockUsers)).toBe(true);
      expect(taskMatchesDepartment(task, 'amministrazione', mockUsers)).toBe(false);
    });

    it('allows "condivisa" or "tutti" for any department', () => {
      const taskShared = { department: 'condivisa' };
      expect(taskMatchesDepartment(taskShared, 'ufficio_tecnico', mockUsers)).toBe(true);
    });

    it('falls back to assigned worker department if task.department is missing', () => {
      const taskNoDept = { department: null, workers: ['Franco (Prod)'] };
      expect(taskMatchesDepartment(taskNoDept, 'produzione', mockUsers)).toBe(true);
      expect(taskMatchesDepartment(taskNoDept, 'ufficio_tecnico', mockUsers)).toBe(false);
    });
  });

  describe('vacationMatchesFilters', () => {
    const mockVacation = {
      id: 'v1',
      username: 'marco_uff',
      reason: 'Ferie estive',
      start_date: '2026-09-01',
      end_date: '2026-09-10',
    };

    it('hides vacations if project status filter is active', () => {
      expect(vacationMatchesFilters(mockVacation, { filterStatus: 'active' }, mockUsers)).toBe(false);
      expect(vacationMatchesFilters(mockVacation, { filterStatus: 'all' }, mockUsers)).toBe(true);
    });

    it('filters vacations by worker', () => {
      expect(vacationMatchesFilters(mockVacation, { filterWorker: 'marco_uff' }, mockUsers)).toBe(true);
      expect(vacationMatchesFilters(mockVacation, { filterWorker: 'laura_acq' }, mockUsers)).toBe(false);
    });

    it('filters vacations by department', () => {
      expect(vacationMatchesFilters(mockVacation, { filterDepartment: 'ufficio_tecnico' }, mockUsers)).toBe(true);
      expect(vacationMatchesFilters(mockVacation, { filterDepartment: 'amministrazione' }, mockUsers)).toBe(false);
    });

    it('filters vacations by search query', () => {
      expect(vacationMatchesFilters(mockVacation, { searchQuery: 'estive' }, mockUsers)).toBe(true);
      expect(vacationMatchesFilters(mockVacation, { searchQuery: 'Marco' }, mockUsers)).toBe(true);
      expect(vacationMatchesFilters(mockVacation, { searchQuery: 'robot' }, mockUsers)).toBe(false);
    });
  });

  describe('CalendarPage cached filters', () => {
    let mockStore = {};
    beforeEach(() => {
      mockStore = {};
      globalThis.localStorage = {
        getItem: (k) => mockStore[k] || null,
        setItem: (k, v) => { mockStore[k] = String(v); },
        removeItem: (k) => { delete mockStore[k]; },
        clear: () => { mockStore = {}; }
      };
    });

    it('returns default filters if localStorage is empty or invalid', () => {
      localStorage.removeItem(CALENDAR_FILTERS_STORAGE_KEY);
      expect(loadSavedFilters()).toEqual({
        status: 'all',
        department: 'all',
        worker: 'all',
        search: '',
      });

      localStorage.setItem(CALENDAR_FILTERS_STORAGE_KEY, 'invalid-json');
      expect(loadSavedFilters()).toEqual({
        status: 'all',
        department: 'all',
        worker: 'all',
        search: '',
      });
    });

    it('loads saved filters from localStorage', () => {
      const saved = {
        status: 'planning',
        department: 'produzione',
        worker: 'admin',
        search: 'robot',
      };
      localStorage.setItem(CALENDAR_FILTERS_STORAGE_KEY, JSON.stringify(saved));
      expect(loadSavedFilters()).toEqual(saved);

      localStorage.removeItem(CALENDAR_FILTERS_STORAGE_KEY);
    });
  });
});

