import api from './client';

const BASE = '/richieste-commerciali';

export async function getMyRole() {
  const res = await api.get(`${BASE}/my-role`);
  return res.data;
}

export async function listRichieste() {
  const res = await api.get(`${BASE}/`, { params: { _t: Date.now() } });
  return res.data;
}

export async function getRichiesta(id) {
  const res = await api.get(`${BASE}/${id}`, { params: { _t: Date.now() } });
  return res.data;
}

export async function createRichiesta(data) {
  const res = await api.post(`${BASE}/`, data);
  return res.data;
}

export async function updateRichiesta(id, data) {
  const res = await api.put(`${BASE}/${id}`, data);
  return res.data;
}

export async function deleteRichiesta(id) {
  const res = await api.delete(`${BASE}/${id}`);
  return res.data;
}

export async function getTrashRichieste() {
  const res = await api.get(`${BASE}/trash`, { params: { _t: Date.now() } });
  return res.data;
}

export async function restoreRichiesta(id) {
  const res = await api.post(`${BASE}/trash/${id}/restore`);
  return res.data;
}

export async function hardDeleteRichiesta(id) {
  const res = await api.delete(`${BASE}/trash/${id}`);
  return res.data;
}

export async function emptyTrashRichieste() {
  const res = await api.delete(`${BASE}/trash/empty`);
  return res.data;
}

export async function uploadAttachmentsRichiesta(richiestaId, files) {
  const formData = new FormData();
  files.forEach((f) => formData.append('files', f));
  const res = await api.post(`${BASE}/${richiestaId}/attachments`, formData);
  return res.data;
}

export async function prendiInCarico(id) {
  const res = await api.put(`${BASE}/${id}/prendi-in-carico`);
  return res.data;
}

export async function addArticolo(richiestaId, data) {
  const res = await api.post(`${BASE}/${richiestaId}/articoli`, data);
  return res.data;
}

export async function updateArticolo(richiestaId, articoloId, data) {
  const res = await api.put(`${BASE}/${richiestaId}/articoli/${articoloId}`, data);
  return res.data;
}

export async function deleteArticolo(richiestaId, articoloId) {
  const res = await api.delete(`${BASE}/${richiestaId}/articoli/${articoloId}`);
  return res.data;
}

export async function uploadAttachmentsArticolo(richiestaId, articoloId, files) {
  const formData = new FormData();
  files.forEach((f) => formData.append('files', f));
  const res = await api.post(`${BASE}/${richiestaId}/articoli/${articoloId}/attachments`, formData);
  return res.data;
}

export async function deleteAttachmentArticolo(richiestaId, articoloId, url) {
  const res = await api.delete(`${BASE}/${richiestaId}/articoli/${articoloId}/attachments`, {
    params: { url },
  });
  return res.data;
}

export async function deleteAttachmentRichiesta(richiestaId, url) {
  const res = await api.delete(`${BASE}/${richiestaId}/attachments`, {
    params: { url },
  });
  return res.data;
}

export async function inviaAdAdmin(id, data = {}) {
  const res = await api.put(`${BASE}/${id}/invia-a-admin`, data);
  return res.data;
}

export async function salvaArticoli(id, articoli, descrizione = null) {
  const payload = { articoli };
  if (descrizione !== null) payload.descrizione = descrizione;
  const res = await api.put(`${BASE}/${id}/articoli-bulk`, payload);
  return res.data;
}

export async function completaRichiesta(id, articoli, descrizione = null) {
  const payload = { articoli };
  if (descrizione !== null) payload.descrizione = descrizione;
  const res = await api.put(`${BASE}/${id}/completa`, payload);
  return res.data;
}

export async function getArticoliListino(params = {}) {
  const res = await api.get(`${BASE}/articoli-listino`, { params: { ...params, _t: Date.now() } });
  return res.data;
}

export async function exportArticoliListinoExcel(params = {}) {
  const res = await api.get(`${BASE}/articoli-listino/export/excel`, {
    params,
    responseType: 'blob',
  });
  return res;
}

// ── Settings RC ──────────────────────────────────────────────────────────────

export async function getRCUsers(group) {
  const res = await api.get(`/settings/richieste-commerciali/${group}-users`);
  return res.data;
}

export async function updateRCUsers(group, usernames) {
  const res = await api.post(`/settings/richieste-commerciali/${group}-users`, { usernames });
  return res.data;
}

export async function getRCEmailEnabled() {
  const res = await api.get('/settings/richieste-commerciali/email-enabled');
  return res.data;
}

export async function updateRCEmailEnabled(enabled) {
  const res = await api.put('/settings/richieste-commerciali/email-enabled', { enabled });
  return res.data;
}

export async function getRCDeptDefaults() {
  const res = await api.get('/settings/richieste-commerciali/dept-defaults');
  return res.data;
}

export async function updateRCDeptDefaults(data) {
  const res = await api.put('/settings/richieste-commerciali/dept-defaults', data);
  return res.data;
}
