// Gli addetti di commessa (assigned_workers) possono essere salvati sia come username
// (selezione da UI) sia come nome completo (dati importati/seed): vanno riconosciuti entrambi.

function workerKeys(user) {
  return [user?.username, user?.full_name].filter(Boolean);
}

export function isProjectWorkerSelected(assignedWorkers, user) {
  const keys = workerKeys(user);
  return (assignedWorkers || []).some(w => keys.includes(w));
}

export function toggleProjectWorker(assignedWorkers, user) {
  const current = assignedWorkers || [];
  if (isProjectWorkerSelected(current, user)) {
    const keys = workerKeys(user);
    return current.filter(w => !keys.includes(w));
  }
  return [...current, user.username];
}
