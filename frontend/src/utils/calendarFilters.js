/**
 * Utility functions for filtering tasks, projects and vacations
 * in CalendarPage and TimelineView.
 */

export const DEPARTMENT_OPTIONS = [
  { value: 'all', label: 'Tutti i reparti' },
  { value: 'ufficio_tecnico', label: 'Ufficio Tecnico' },
  { value: 'produzione', label: 'Produzione' },
  { value: 'acquisti', label: 'Acquisti' },
  { value: 'amministrazione', label: 'Amministrazione' },
  { value: 'commerciale', label: 'Commerciale' },
];

/**
 * Normalizes text by removing surrounding whitespace and lowercase.
 */
function clean(str) {
  return (str || '').toString().trim().toLowerCase();
}

/**
 * Removes parentheses badge from name, e.g. "Marco (UT)" -> "marco"
 */
function stripBadge(str) {
  return clean(str).replace(/\s*\([^)]*\)/g, '').trim();
}

/**
 * Checks if a task matches the selected worker filter.
 *
 * @param {Object} task - The task or phase object
 * @param {string} workerFilter - Username or 'all'
 * @param {Array} systemUsers - List of user objects from /users API
 * @returns {boolean}
 */
export function taskMatchesWorker(task, workerFilter, systemUsers = []) {
  if (!workerFilter || workerFilter === 'all') return true;
  if (!task) return false;

  const targetUser = systemUsers.find(
    u => u.username === workerFilter || u.id === workerFilter
  );
  const targetUsername = clean(targetUser?.username || workerFilter);
  const targetFullName = clean(targetUser?.full_name);
  const targetBaseName = stripBadge(targetUser?.full_name);
  const targetId = targetUser?.id;

  // 1. Check assigned_to if present
  if (task.assigned_to) {
    if (targetId && task.assigned_to === targetId) return true;
    const aClean = clean(task.assigned_to);
    if (aClean === targetUsername || (targetFullName && aClean === targetFullName)) return true;
  }

  // 2. Check workers array
  if (Array.isArray(task.workers)) {
    return task.workers.some(w => {
      if (!w) return false;
      const wClean = clean(w);
      const wBase = stripBadge(w);

      if (wClean === targetUsername) return true;
      if (targetFullName && wClean === targetFullName) return true;
      if (targetBaseName && wBase && targetBaseName === wBase) return true;
      return false;
    });
  }

  return false;
}

/**
 * Checks if a task matches the selected department filter.
 *
 * @param {Object} task - The task or phase object
 * @param {string} deptFilter - Department slug or 'all'
 * @param {Array} systemUsers - List of user objects from /users API
 * @returns {boolean}
 */
export function taskMatchesDepartment(task, deptFilter, systemUsers = []) {
  if (!deptFilter || deptFilter === 'all') return true;
  if (!task) return false;

  const targetDept = clean(deptFilter);

  // 1. Direct task.department match
  if (task.department) {
    const tDept = clean(task.department);
    if (tDept === targetDept) return true;
    if (tDept === 'condivisa' || tDept === 'tutti') return true;
  }

  // 2. Fallback: if task has no department set, check if any assigned worker belongs to target department
  if (!task.department && Array.isArray(task.workers) && task.workers.length > 0) {
    return task.workers.some(w => {
      if (!w) return false;
      const wClean = clean(w);
      const wBase = stripBadge(w);

      const user = systemUsers.find(u => {
        const uUsername = clean(u.username);
        const uFull = clean(u.full_name);
        const uBase = stripBadge(u.full_name);
        return uUsername === wClean || uFull === wClean || (uBase && wBase && uBase === wBase);
      });

      return user && user.department && clean(user.department) === targetDept;
    });
  }

  return false;
}

/**
 * Checks if a vacation entry matches active filters.
 */
export function vacationMatchesFilters(vacation, filters, systemUsers = []) {
  const { filterWorker = 'all', filterDepartment = 'all', filterStatus = 'all', searchQuery = '' } = filters || {};

  // Vacations don't have project status, hide if a project status is selected
  if (filterStatus !== 'all') return false;

  // Check worker filter
  if (filterWorker !== 'all') {
    if (!taskMatchesWorker({ workers: [vacation.username] }, filterWorker, systemUsers)) {
      return false;
    }
  }

  // Check department filter
  if (filterDepartment !== 'all') {
    const dept = vacation.department ? clean(vacation.department) : null;
    const user = systemUsers.find(u => clean(u.username) === clean(vacation.username));
    const userDept = user?.department ? clean(user.department) : null;
    const effectiveDept = dept || userDept;
    if (effectiveDept !== clean(filterDepartment)) {
      return false;
    }
  }

  // Check search query
  if (searchQuery && searchQuery.trim()) {
    const sq = clean(searchQuery);
    const user = systemUsers.find(u => clean(u.username) === clean(vacation.username));
    const uFull = clean(user?.full_name);
    const vUser = clean(vacation.username);
    const vReason = clean(vacation.reason);

    const matchesSearch = vUser.includes(sq) || uFull.includes(sq) || vReason.includes(sq) || 'ferie'.includes(sq);
    if (!matchesSearch) return false;
  }

  return true;
}
