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
 * Resolves the display name of a project's responsible.
 */
export function getProjectResponsible(proj, systemUsers = []) {
  if (!proj) return '-';
  if (proj.responsible_name) return proj.responsible_name;
  if (proj.responsible_username) return proj.responsible_username;
  if (proj.responsible_id && Array.isArray(systemUsers)) {
    const u = systemUsers.find(user => String(user.id) === String(proj.responsible_id));
    if (u) return u.full_name || u.username;
  }
  if (proj.owner_id && Array.isArray(systemUsers)) {
    const u = systemUsers.find(user => String(user.id) === String(proj.owner_id));
    if (u) return u.full_name || u.username;
  }
  return '-';
}

/**
 * Checks if a project matches the selected responsible filter.
 *
 * @param {Object} project - The project object
 * @param {string} respFilter - User username, user id, '__none__', or 'all'
 * @param {Array} systemUsers - List of user objects from /users API
 * @returns {boolean}
 */
export function projectMatchesResponsible(project, respFilter, systemUsers = []) {
  if (!respFilter || respFilter === 'all') return true;
  if (!project) return false;

  // Filtro per commesse senza responsabile assegnato
  if (respFilter === '__none__') {
    const resp = getProjectResponsible(project, systemUsers);
    return !resp || resp === '-';
  }

  const targetUser = systemUsers.find(
    u => u.username === respFilter || String(u.id) === String(respFilter)
  );
  const targetUsername = clean(targetUser?.username || respFilter);
  const targetFullName = clean(targetUser?.full_name);
  const targetBaseName = stripBadge(targetUser?.full_name);
  const targetId = targetUser?.id !== undefined ? String(targetUser.id) : String(respFilter);

  // 1. Check responsible_id
  if (project.responsible_id && (String(project.responsible_id) === targetId || String(project.responsible_id) === clean(respFilter))) {
    return true;
  }

  // 2. Fallback check owner_id if no responsible_id
  if (!project.responsible_id && project.owner_id && (String(project.owner_id) === targetId || String(project.owner_id) === clean(respFilter))) {
    return true;
  }

  // 3. Check responsible_username
  if (project.responsible_username) {
    const rUserClean = clean(project.responsible_username);
    if (rUserClean === targetUsername) return true;
  }

  // 4. Check responsible_name
  if (project.responsible_name) {
    const rNameClean = clean(project.responsible_name);
    const rNameBase = stripBadge(project.responsible_name);
    if (rNameClean === targetUsername) return true;
    if (targetFullName && rNameClean === targetFullName) return true;
    if (targetBaseName && rNameBase && targetBaseName === rNameBase) return true;
  }

  // 5. Check via getProjectResponsible resolution
  const resolved = getProjectResponsible(project, systemUsers);
  if (resolved && resolved !== '-') {
    const resClean = clean(resolved);
    const resBase = stripBadge(resolved);
    if (resClean === targetUsername) return true;
    if (targetFullName && resClean === targetFullName) return true;
    if (targetBaseName && resBase && targetBaseName === resBase) return true;
  }

  return false;
}

/**
 * Checks if a vacation entry matches active filters.
 */
export function vacationMatchesFilters(vacation, filters, systemUsers = []) {
  const { filterWorker = 'all', filterDepartment = 'all', filterStatus = 'all', filterStatuses, filterResponsible = 'all', searchQuery = '' } = filters || {};

  // Vacations don't have project status or project responsible, hide if a project status or responsible is selected
  if (filterStatus && filterStatus !== 'all') return false;
  if (Array.isArray(filterStatuses)) {
    const isDefaultStatuses = filterStatuses.length === 3 &&
      filterStatuses.includes('planning') &&
      filterStatuses.includes('active') &&
      filterStatuses.includes('completed');
    if (!isDefaultStatuses && filterStatuses.length < 3) {
      return false;
    }
  }
  if (filterResponsible && filterResponsible !== 'all') return false;

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

