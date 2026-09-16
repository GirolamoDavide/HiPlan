import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  FileSpreadsheet,
  Download,
  Search,
  X,
  Layers,
  ArrowUpDown,
  Filter,
  ExternalLink,
  Coins,
  TrendingUp,
  Package,
  Calendar,
  User,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react';
import { getArticoliListino, exportArticoliListinoExcel } from '../../api/richiesteCommerciali';
import { useToast } from '../../context/ToastContext';
import './ArticoliListinoModal.css';

const TIPOLOGIA_OPTIONS = [
  { value: '', label: 'Tutte le tipologie' },
  { value: 'standard', label: 'Standard' },
  { value: 'atex', label: 'ATEX' },
  { value: 'alimentare', label: 'Alimentare' },
];

const FORNITURA_OPTIONS = [
  { value: '', label: 'Tutte le forniture' },
  { value: 'materie_prime', label: 'Materie Prime' },
  { value: 'mp_lavorazione', label: 'MP + Lavorazione' },
  { value: 'compravendita', label: 'Compravendita' },
];

const FORNITURA_LABELS = {
  materie_prime: 'Materie Prime',
  mp_lavorazione: 'MP + Lavorazione',
  compravendita: 'Compravendita',
};

function formatCurrency(val) {
  if (val == null || isNaN(val)) return '0,00 €';
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
  }).format(val);
}

function formatDate(isoStr) {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString('it-IT', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  } catch {
    return isoStr.slice(0, 10);
  }
}

export default function ArticoliListinoModal({ isOpen, onClose, onOpenRichiesta }) {
  const { showToast } = useToast();

  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [data, setData] = useState({ articoli: [], stats: null });
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTipologia, setFilterTipologia] = useState('');
  const [filterFornitura, setFilterFornitura] = useState('');
  const [sortBy, setSortBy] = useState('date_desc');
  const [expandedDescriptions, setExpandedDescriptions] = useState({});

  const loadData = useCallback(async () => {
    if (!isOpen) return;
    setLoading(true);
    try {
      const res = await getArticoliListino({
        q: searchQuery,
        tipologia: filterTipologia,
        tipo_fornitura: filterFornitura,
      });
      setData(res);
    } catch (err) {
      showToast('Errore nel caricamento del listino articoli', 'error');
    } finally {
      setLoading(false);
    }
  }, [isOpen, searchQuery, filterTipologia, filterFornitura, showToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Gestione Export Excel
  const handleExportExcel = async () => {
    setExporting(true);
    try {
      const res = await exportArticoliListinoExcel({
        q: searchQuery,
        tipologia: filterTipologia,
        tipo_fornitura: filterFornitura,
      });

      let filename = 'articoli_listino.xlsx';
      const disposition = res.headers?.['content-disposition'] || res.headers?.['Content-Disposition'];
      if (disposition && disposition.includes('filename=')) {
        const match = disposition.match(/filename="?([^";]+)"?/);
        if (match && match[1]) filename = match[1];
      }

      const blob = new Blob([res.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);

      showToast('File Excel scaricato con successo!', 'success');
    } catch (err) {
      showToast('Impossibile esportare il file Excel', 'error');
    } finally {
      setExporting(false);
    }
  };

  const toggleDescription = (id) => {
    setExpandedDescriptions((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  // Ordinamento locale client-side
  const sortedArticoli = useMemo(() => {
    const list = [...(data.articoli || [])];
    switch (sortBy) {
      case 'date_desc':
        return list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      case 'date_asc':
        return list.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
      case 'listino_desc':
        return list.sort((a, b) => (b.prezzo_listino || 0) - (a.prezzo_listino || 0));
      case 'listino_asc':
        return list.sort((a, b) => (a.prezzo_listino || 0) - (b.prezzo_listino || 0));
      case 'costo_desc':
        return list.sort((a, b) => (b.costo || 0) - (a.costo || 0));
      case 'costo_asc':
        return list.sort((a, b) => (a.costo || 0) - (b.costo || 0));
      case 'margine_desc':
        return list.sort((a, b) => (b.margine || 0) - (a.margine || 0));
      default:
        return list;
    }
  }, [data.articoli, sortBy]);

  if (!isOpen) return null;

  const stats = data.stats || {
    totale_articoli: 0,
    totale_costo: 0,
    totale_listino: 0,
    totale_margine: 0,
    margine_medio_percentuale: 0,
  };

  return (
    <div className="art-listino-overlay" onClick={onClose}>
      <div className="art-listino-card" onClick={(e) => e.stopPropagation()}>
        {/* Header Modal */}
        <div className="art-listino-header">
          <div className="art-listino-header-left">
            <div className="art-listino-title-icon">
              <FileSpreadsheet size={22} />
            </div>
            <div>
              <div className="art-listino-title-row">
                <h2>Archivio Articoli a Listino</h2>
                <span className="art-listino-badge-count">
                  {stats.totale_articoli} {stats.totale_articoli === 1 ? 'articolo' : 'articoli'}
                </span>
              </div>
              <p className="art-listino-subtitle">
                Consultazione di tutti gli articoli completati con prezzi di listino, dettagli tecnici e tracciabilità.
              </p>
            </div>
          </div>

          <div className="art-listino-header-actions">
            <button
              type="button"
              className="btn btn-primary art-btn-excel"
              onClick={handleExportExcel}
              disabled={exporting || stats.totale_articoli === 0}
              title="Esporta tutti gli articoli in formato Microsoft Excel (.xlsx)"
            >
              <Download size={15} className={exporting ? 'spin' : ''} />
              <span>{exporting ? 'Esportazione...' : 'Scarica Excel'}</span>
            </button>
            <button
              type="button"
              className="art-listino-close-btn"
              onClick={onClose}
              aria-label="Chiudi finestra"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* KPI Cards di Sintesi Economica */}
        <div className="art-listino-kpi-grid">
          <div className="art-kpi-card">
            <div className="art-kpi-icon art-kpi-icon--items">
              <Package size={20} />
            </div>
            <div className="art-kpi-content">
              <span className="art-kpi-label">Articoli Completati</span>
              <strong className="art-kpi-val">{stats.totale_articoli}</strong>
            </div>
          </div>

          <div className="art-kpi-card">
            <div className="art-kpi-icon art-kpi-icon--listino">
              <Coins size={20} />
            </div>
            <div className="art-kpi-content">
              <span className="art-kpi-label">Totale Prezzo Listino</span>
              <strong className="art-kpi-val text-primary-val">{formatCurrency(stats.totale_listino)}</strong>
            </div>
          </div>

          <div className="art-kpi-card">
            <div className="art-kpi-icon art-kpi-icon--costo">
              <Coins size={20} />
            </div>
            <div className="art-kpi-content">
              <span className="art-kpi-label">Totale Costo Acquisti</span>
              <strong className="art-kpi-val text-secondary-val">{formatCurrency(stats.totale_costo)}</strong>
            </div>
          </div>

          <div className="art-kpi-card">
            <div className="art-kpi-icon art-kpi-icon--margin">
              <TrendingUp size={20} />
            </div>
            <div className="art-kpi-content">
              <span className="art-kpi-label">Margine Totale (Medio)</span>
              <div className="art-kpi-margin-row">
                <strong className="art-kpi-val text-success-val">{formatCurrency(stats.totale_margine)}</strong>
                <span className="art-kpi-pill">+{stats.margine_medio_percentuale}%</span>
              </div>
            </div>
          </div>
        </div>

        {/* Command Bar: Ricerca, Filtri Tipologia/Fornitura e Ordinamento */}
        <div className="art-listino-controls">
          <div className="art-search-wrapper">
            <Search size={15} className="art-search-icon" />
            <input
              type="text"
              className="art-search-input"
              placeholder="Cerca per articolo, descrizione, cliente, offerta o autore..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="art-search-clear"
                onClick={() => setSearchQuery('')}
                aria-label="Cancella ricerca"
              >
                <X size={13} />
              </button>
            )}
          </div>

          <div className="art-filter-selects">
            <div className="art-select-group">
              <Filter size={13} className="art-select-icon" />
              <select
                value={filterTipologia}
                onChange={(e) => setFilterTipologia(e.target.value)}
                className="art-select"
                title="Filtra per tipologia prodotto"
              >
                {TIPOLOGIA_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="art-select-group">
              <Layers size={13} className="art-select-icon" />
              <select
                value={filterFornitura}
                onChange={(e) => setFilterFornitura(e.target.value)}
                className="art-select"
                title="Filtra per tipo di fornitura"
              >
                {FORNITURA_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="art-select-group">
              <ArrowUpDown size={13} className="art-select-icon" />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="art-select"
                title="Ordina tabella"
              >
                <option value="date_desc">Più recenti</option>
                <option value="date_asc">Meno recenti</option>
                <option value="listino_desc">Listino più alto</option>
                <option value="listino_asc">Listino più basso</option>
                <option value="costo_desc">Costo più alto</option>
                <option value="costo_asc">Costo più basso</option>
                <option value="margine_desc">Margine più alto</option>
              </select>
            </div>

            <button
              type="button"
              className="btn-icon btn-ghost art-refresh-btn"
              onClick={loadData}
              disabled={loading}
              title="Ricarica elenco articoli"
            >
              <RefreshCw size={15} className={loading ? 'spin' : ''} />
            </button>
          </div>
        </div>

        {/* Tabella Dati */}
        <div className="art-table-container">
          {loading ? (
            <div className="art-table-loading">
              <div className="rc-spinner" />
              <span>Caricamento articoli a listino...</span>
            </div>
          ) : sortedArticoli.length === 0 ? (
            <div className="art-table-empty">
              <Package size={36} />
              <h4>Nessun articolo a listino trovato</h4>
              <p>
                {searchQuery || filterTipologia || filterFornitura
                  ? 'Nessun articolo corrisponde ai filtri impostati. Prova a modificare i criteri di ricerca.'
                  : 'Gli articoli compariranno qui non appena un amministratore completerà una richiesta con i prezzi di listino.'}
              </p>
            </div>
          ) : (
            <table className="art-data-table">
              <thead>
                <tr>
                  <th style={{ width: '24%' }}>Articolo</th>
                  <th style={{ width: '18%' }}>Cliente & Richiesta</th>
                  <th style={{ width: '14%' }}>Tipologia & Fornitura</th>
                  <th style={{ width: '10%', textAlign: 'right' }}>Costo</th>
                  <th style={{ width: '11%', textAlign: 'right' }}>Prezzo Listino</th>
                  <th style={{ width: '11%', textAlign: 'right' }}>Margine</th>
                  <th style={{ width: '12%' }}>Inserito & Listino</th>
                </tr>
              </thead>
              <tbody>
                {sortedArticoli.map((art) => {
                  const isExpanded = !!expandedDescriptions[art.id];
                  const hasLongDesc = art.descrizione && art.descrizione.length > 90;

                  return (
                    <tr key={art.id} className="art-table-row">
                      {/* 1. Titolo e Descrizione */}
                      <td>
                        <div className="art-cell-main">
                          <strong className="art-item-title">{art.titolo}</strong>
                          {art.descrizione && (
                            <div className="art-item-desc-wrapper">
                              <p className={`art-item-desc ${isExpanded ? 'is-expanded' : ''}`}>
                                {art.descrizione}
                              </p>
                              {hasLongDesc && (
                                <button
                                  type="button"
                                  className="art-desc-toggle-btn"
                                  onClick={() => toggleDescription(art.id)}
                                >
                                  {isExpanded ? 'Mostra meno' : 'Mostra tutto'}
                                </button>
                              )}
                            </div>
                          )}
                          {art.note_admin && (
                            <div className="art-item-note-admin" title="Nota interna amministratore">
                              <span className="art-note-tag">Nota Admin:</span> {art.note_admin}
                            </div>
                          )}
                        </div>
                      </td>

                      {/* 2. Cliente & Richiesta correlata */}
                      <td>
                        <div className="art-cell-client">
                          <strong className="art-client-name">{art.cliente}</strong>
                          <div className="art-request-row">
                            <span className="art-request-title" title={art.richiesta_titolo}>
                              {art.numero_offerta ? `Off: ${art.numero_offerta}` : art.richiesta_titolo}
                            </span>
                            {onOpenRichiesta && (
                              <button
                                type="button"
                                className="art-link-richiesta-btn"
                                onClick={() => onOpenRichiesta(art.richiesta_id)}
                                title="Apri scheda richiesta commerciale"
                              >
                                <ExternalLink size={12} />
                              </button>
                            )}
                          </div>
                          {art.commerciale && (
                            <span className="art-comm-referente">Comm: {art.commerciale}</span>
                          )}
                        </div>
                      </td>

                      {/* 3. Tipologia & Fornitura */}
                      <td>
                        <div className="art-cell-tags">
                          <div className="art-tags-row">
                            {art.is_atex && <span className="art-tag art-tag--atex">ATEX</span>}
                            {art.is_alimentare && <span className="art-tag art-tag--alim">Alim</span>}
                            {(art.is_standard || (!art.is_atex && !art.is_alimentare)) && (
                              <span className="art-tag art-tag--std">Standard</span>
                            )}
                          </div>
                          {art.tipo_fornitura && (
                            <span className="art-fornitura-tag">
                              {FORNITURA_LABELS[art.tipo_fornitura] || art.tipo_fornitura}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* 4. Costo */}
                      <td style={{ textAlign: 'right' }}>
                        <span className="art-costo-val">{formatCurrency(art.costo)}</span>
                      </td>

                      {/* 5. Prezzo Listino */}
                      <td style={{ textAlign: 'right' }}>
                        <strong className="art-listino-val">{formatCurrency(art.prezzo_listino)}</strong>
                      </td>

                      {/* 6. Margine & Ricarico */}
                      <td style={{ textAlign: 'right' }}>
                        <div className="art-cell-margin">
                          <span className="art-margin-euro">{formatCurrency(art.margine)}</span>
                          <span className="art-margin-pill">+{art.ricarico_percentuale}%</span>
                        </div>
                      </td>

                      {/* 7. Tracciabilità autore e data */}
                      <td>
                        <div className="art-cell-trace">
                          <div className="art-trace-item" title={`Articolo creato da ${art.inserito_da} il ${formatDate(art.created_at)}`}>
                            <User size={11} className="art-trace-icon" />
                            <span>{art.inserito_da}</span>
                            <span className="art-trace-date">{formatDate(art.created_at)}</span>
                          </div>
                          {art.listino_inserito_da && (
                            <div className="art-trace-item art-trace-item--admin" title={`Listino completato da ${art.listino_inserito_da} il ${formatDate(art.listino_inserted_at)}`}>
                              <ShieldCheck size={11} className="art-trace-icon text-accent" />
                              <span>{art.listino_inserito_da}</span>
                              <span className="art-trace-date">{formatDate(art.listino_inserted_at)}</span>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer Modal */}
        <div className="art-listino-footer">
          <div className="art-footer-hint">
            <span>💡 Gli articoli vengono archiviati automaticamente non appena una richiesta passa a stato <strong>Completata</strong> con prezzo di listino.</span>
          </div>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
}
