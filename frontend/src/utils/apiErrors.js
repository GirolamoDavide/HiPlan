// FastAPI restituisce `detail` come stringa (HTTPException) o come lista di errori (422 di validazione):
// il toast deve ricevere sempre una stringa, altrimenti React va in errore renderizzando un oggetto.
export function getApiErrorMessage(err, fallback = 'Si è verificato un errore') {
  const detail = err?.response?.data?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail) && detail.length > 0) {
    return detail
      .map(d => {
        const field = Array.isArray(d?.loc) ? d.loc.filter(p => p !== 'body').join('.') : '';
        return field ? `${field}: ${d?.msg}` : d?.msg;
      })
      .filter(Boolean)
      .join('; ') || fallback;
  }
  return fallback;
}
