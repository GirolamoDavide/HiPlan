import { describe, it, expect, beforeEach } from 'vitest';
import {
  taskMatchesWorker,
  taskMatchesDepartment,
  vacationMatchesFilters,
  projectMatchesResponsible,
} from '../../src/utils/calendarFilters';
import { CALENDAR_FILTERS_STORAGE_KEY, loadSavedFilters, sortProjects, SORT_OPTIONS } from '../../src/pages/CalendarPage';

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

  describe('projectMatchesResponsible', () => {
    it('returns true when filter is "all" or empty', () => {
      const proj = { responsible_id: 'u1' };
      expect(projectMatchesResponsible(proj, 'all', mockUsers)).toBe(true);
      expect(projectMatchesResponsible(proj, '', mockUsers)).toBe(true);
    });

    it('matches project by responsible_id', () => {
      const proj = { responsible_id: 'u1' };
      expect(projectMatchesResponsible(proj, 'marco_uff', mockUsers)).toBe(true);
      expect(projectMatchesResponsible(proj, 'laura_acq', mockUsers)).toBe(false);
    });

    it('matches project by fallback owner_id when responsible_id is missing', () => {
      const proj = { owner_id: 'u2' };
      expect(projectMatchesResponsible(proj, 'laura_acq', mockUsers)).toBe(true);
      expect(projectMatchesResponsible(proj, 'marco_uff', mockUsers)).toBe(false);
    });

    it('matches project by responsible_username', () => {
      const proj = { responsible_username: 'franco_pro' };
      expect(projectMatchesResponsible(proj, 'franco_pro', mockUsers)).toBe(true);
      expect(projectMatchesResponsible(proj, 'marco_uff', mockUsers)).toBe(false);
    });

    it('matches project by responsible_name', () => {
      const proj = { responsible_name: 'Marco (UT)' };
      expect(projectMatchesResponsible(proj, 'marco_uff', mockUsers)).toBe(true);
      expect(projectMatchesResponsible(proj, 'topolino', mockUsers)).toBe(false);
    });

    it('matches unassigned projects when filter is "__none__"', () => {
      const unassignedProj = {};
      const assignedProj = { responsible_id: 'u1' };
      expect(projectMatchesResponsible(unassignedProj, '__none__', mockUsers)).toBe(true);
      expect(projectMatchesResponsible(assignedProj, '__none__', mockUsers)).toBe(false);
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
      expect(vacationMatchesFilters(mockVacation, { filterStatuses: ['active'] }, mockUsers)).toBe(false);
      expect(vacationMatchesFilters(mockVacation, { filterStatuses: ['planning', 'active', 'completed'] }, mockUsers)).toBe(true);
    });

    it('hides vacations if project responsible filter is active', () => {
      expect(vacationMatchesFilters(mockVacation, { filterResponsible: 'marco_uff' }, mockUsers)).toBe(false);
      expect(vacationMatchesFilters(mockVacation, { filterResponsible: 'all' }, mockUsers)).toBe(true);
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
        statuses: ['planning', 'active', 'completed'],
        department: 'all',
        worker: 'all',
        responsible: 'all',
        search: '',
        sortKey: 'none',
        sortDirection: 'asc',
      });

      localStorage.setItem(CALENDAR_FILTERS_STORAGE_KEY, 'invalid-json');
      expect(loadSavedFilters()).toEqual({
        statuses: ['planning', 'active', 'completed'],
        department: 'all',
        worker: 'all',
        responsible: 'all',
        search: '',
        sortKey: 'none',
        sortDirection: 'asc',
      });
    });

    it('loads saved filters from localStorage including sort settings and responsible', () => {
      const saved = {
        statuses: ['planning', 'active'],
        department: 'produzione',
        worker: 'admin',
        responsible: 'marco_uff',
        search: 'robot',
        sortKey: 'start_date',
        sortDirection: 'desc',
      };
      localStorage.setItem(CALENDAR_FILTERS_STORAGE_KEY, JSON.stringify(saved));
      expect(loadSavedFilters()).toEqual(saved);

      localStorage.removeItem(CALENDAR_FILTERS_STORAGE_KEY);
    });

    it('backward-compatibility: migrates legacy status string to statuses array', () => {
      const legacy = {
        status: 'completed',
        department: 'acquisti',
        worker: 'all',
        responsible: 'all',
        search: '',
        sortKey: 'none',
        sortDirection: 'asc',
      };
      localStorage.setItem(CALENDAR_FILTERS_STORAGE_KEY, JSON.stringify(legacy));
      expect(loadSavedFilters()).toEqual({
        statuses: ['completed'],
        department: 'acquisti',
        worker: 'all',
        responsible: 'all',
        search: '',
        sortKey: 'none',
        sortDirection: 'asc',
      });
    });
  });

  describe('sortProjects', () => {
    const testProjects = [
      {
        id: 'p1',
        code: 'PRJ-10',
        name: 'Zeta Project',
        client: 'Beta Srl',
        status: 'active',
        start_date: '2026-09-10',
        end_date: '2026-09-20',
        responsible_username: 'marco_uff',
      },
      {
        id: 'p2',
        code: 'PRJ-2',
        name: 'Alpha Project',
        client: 'Acme Corp',
        status: 'planning',
        start_date: '2026-09-01',
        end_date: '2026-09-30',
        responsible_id: 'u2', // Laura (Acq)
      },
      {
        id: 'p3',
        code: 'PRJ-1',
        name: 'Gamma Project',
        client: 'Omega Spa',
        status: 'completed',
        start_date: '2026-09-05',
        end_date: '2026-09-15',
        owner_id: 'u3', // Franco (Prod)
      },
      {
        id: 'p4',
        code: 'PRJ-0',
        name: 'No Dates Project',
        client: '',
        status: 'archived',
        start_date: null,
        end_date: null,
      },
    ];

    it('sorts by start_date ascending placing empty dates last', () => {
      const sorted = sortProjects(testProjects, { key: 'start_date', direction: 'asc' }, mockUsers);
      expect(sorted.map(p => p.id)).toEqual(['p2', 'p3', 'p1', 'p4']);
    });

    it('sorts by start_date descending placing empty dates last', () => {
      const sorted = sortProjects(testProjects, { key: 'start_date', direction: 'desc' }, mockUsers);
      expect(sorted.map(p => p.id)).toEqual(['p1', 'p3', 'p2', 'p4']);
    });

    it('sorts by end_date ascending', () => {
      const sorted = sortProjects(testProjects, { key: 'end_date', direction: 'asc' }, mockUsers);
      expect(sorted.map(p => p.id)).toEqual(['p3', 'p1', 'p2', 'p4']);
    });

    it('sorts by end_date descending', () => {
      const sorted = sortProjects(testProjects, { key: 'end_date', direction: 'desc' }, mockUsers);
      expect(sorted.map(p => p.id)).toEqual(['p2', 'p1', 'p3', 'p4']);
    });

    it('sorts by responsible / referente ascending', () => {
      // Franco (p3), Laura (p2), Marco (p1), none '-' (p4)
      const sorted = sortProjects(testProjects, { key: 'responsible', direction: 'asc' }, mockUsers);
      expect(sorted.map(p => p.id)).toEqual(['p3', 'p2', 'p1', 'p4']);
    });

    it('sorts by responsible / referente descending', () => {
      const sorted = sortProjects(testProjects, { key: 'responsible', direction: 'desc' }, mockUsers);
      expect(sorted.map(p => p.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    });

    it('sorts by code numerically', () => {
      // Natural order: PRJ-0, PRJ-1, PRJ-2, PRJ-10
      const sorted = sortProjects(testProjects, { key: 'code', direction: 'asc' }, mockUsers);
      expect(sorted.map(p => p.id)).toEqual(['p4', 'p3', 'p2', 'p1']);
    });

    it('sorts by name ascending and descending', () => {
      const asc = sortProjects(testProjects, { key: 'name', direction: 'asc' }, mockUsers);
      expect(asc.map(p => p.name)).toEqual(['Alpha Project', 'Gamma Project', 'No Dates Project', 'Zeta Project']);

      const desc = sortProjects(testProjects, { key: 'name', direction: 'desc' }, mockUsers);
      expect(desc.map(p => p.name)).toEqual(['Zeta Project', 'No Dates Project', 'Gamma Project', 'Alpha Project']);
    });

    it('sorts by client with empty clients last', () => {
      const asc = sortProjects(testProjects, { key: 'client', direction: 'asc' }, mockUsers);
      expect(asc.map(p => p.id)).toEqual(['p2', 'p1', 'p3', 'p4']);
    });

    it('returns unchanged list if sort key is none', () => {
      const res = sortProjects(testProjects, { key: 'none', direction: 'asc' }, mockUsers);
      expect(res).toEqual(testProjects);
    });
  });
});

