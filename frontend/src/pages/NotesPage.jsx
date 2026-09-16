import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import AppIcon from '../components/ui/AppIcon';
import AssigneeInput from '../components/ui/AssigneeInput';
import { Type, Heading1, Heading2, Bold, Italic, List, ListTodo, Quote, Code, Eraser, Calendar, ArrowUpDown, ChevronDown } from 'lucide-react';
import './NotesPage.css';

const BACKEND_URL = import.meta.env.VITE_API_URL
  ? import.meta.env.VITE_API_URL.replace(/\/api\/?$/, '')
  : `http://${window.location.hostname}:8000`;

const NOTES_ORDER_KEY = 'hiplan_notes_order';

function loadSavedOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(NOTES_ORDER_KEY) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

export default function NotesPage() {
  const { user } = useAuth();
  const toast = useToast();

  // Elenco note e filtri
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('all'); // 'all' | 'private' | 'shared'

  // Nota attiva per la visualizzazione / modifica
  const [activeNoteId, setActiveNoteId] = useState(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [visibility, setVisibility] = useState('private');
  const [sharedWith, setSharedWith] = useState([]);

  // Stato UI editor
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);
  const [showVisibilityMenu, setShowVisibilityMenu] = useState(false);

  // Modale Nuova Nota
  const [showNewModal, setShowNewModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newVisibility, setNewVisibility] = useState('private');
  const [newSharedWith, setNewSharedWith] = useState([]);

  const [users, setUsers] = useState([]);

  // Cestino
  const [showTrashModal, setShowTrashModal] = useState(false);
  const [trashNotes, setTrashNotes] = useState([]);
  const [trashLoading, setTrashLoading] = useState(false);

  // Ordinamento e riordino personalizzato (drag & drop) delle note
  const [sortMode, setSortMode] = useState(() => (loadSavedOrder().length ? 'custom' : 'created'));
  const [customOrder, setCustomOrder] = useState(loadSavedOrder);
  const [dragId, setDragId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null); // { id, pos: 'before' | 'after' }

  // Ref per l'editor visuale contentEditable e timeout autocalcolato
  const editorRef = useRef(null);
  const saveTimeoutRef = useRef(null);
  const uploadingAttachmentsRef = useRef(false);

  // Formati attivi nella selezione corrente per evidenziare i tasti della barra
  const [activeFormats, setActiveFormats] = useState({
    bold: false,
    italic: false,
    bullet: false,
    h1: false,
    h2: false,
    quote: false,
    todo: false,
    code: false,
  });

  const loadTrash = useCallback(async () => {
    setTrashLoading(true);
    try {
      const { data } = await api.get('/notes/trash');
      setTrashNotes(Array.isArray(data) ? data : []);
    } catch {
      /* ignore */
    } finally {
      setTrashLoading(false);
    }
  }, []);

  useEffect(() => {
    async function loadUsers() {
      try {
        const { data } = await api.get('/users');
        setUsers(data);
      } catch (err) {
        console.error('Failed to load users', err);
      }
    }
    loadUsers();
  }, []);

  useEffect(() => {
    // Aggiungi classe full-height-page al main-body per occupare tutta l'altezza
    const mainBody = document.querySelector('.main-body');
    if (mainBody) mainBody.classList.add('full-height-page');
    return () => {
      if (mainBody) mainBody.classList.remove('full-height-page');
    };
  }, []);

  useEffect(() => {
    loadNotes();
    loadTrash();
  }, [loadTrash]);

  const location = useLocation();
  const navigate = useNavigate();

  async function loadNotes() {
    setLoading(true);
    try {
      const { data } = await api.get('/notes');
      setNotes(data);
      // Tieni l'ordine personalizzato allineato con tutte le note esistenti
      setCustomOrder(prev => {
        const allIds = data.map(n => n.id);
        const merged = [...prev.filter(id => allIds.includes(id)), ...allIds.filter(id => !prev.includes(id))];
        return merged;
      });
    } catch {
      toast.error('Errore durante il caricamento dei blocchi note');
    } finally {
      setLoading(false);
    }
  }

  async function handleRestoreNote(note) {
    try {
      await api.post(`/notes/trash/${note.id}/restore`);
      toast.success('Nota ripristinata con successo');
      await loadNotes();
      await loadTrash();
    } catch {
      toast.error('Errore durante il ripristino della nota');
    }
  }

  async function handleHardDeleteNote(note) {
    if (!window.confirm(`Eliminare definitivamente la nota "${note.title}"?\nL'operazione è irreversibile.`)) return;
    try {
      await api.delete(`/notes/trash/${note.id}`);
      toast.success('Nota eliminata definitivamente');
      await loadTrash();
    } catch {
      toast.error('Errore durante l\'eliminazione definitiva');
    }
  }

  async function handleEmptyTrash() {
    if (trashNotes.length === 0) return;
    if (!window.confirm(`Svuotare il cestino delle note?\nTutte le ${trashNotes.length} note presenti verranno eliminate in modo irreversibile.`)) return;
    try {
      await api.delete('/notes/trash/empty');
      toast.success('Cestino svuotato');
      await loadTrash();
    } catch {
      toast.error('Errore durante lo svuotamento del cestino');
    }
  }

  useEffect(() => {
    if (notes.length > 0) {
      const params = new URLSearchParams(location.search);
      const urlNoteId = params.get('noteId');
      if (urlNoteId) {
        const targetNote = notes.find(n => n.id === urlNoteId);
        if (targetNote) {
          selectNote(targetNote);
        }
        params.delete('noteId');
        navigate({ search: params.toString() }, { replace: true });
      } else if (!activeNoteId) {
        selectNote(notes[0]);
      }
    }
  }, [location.search, notes]);

  function selectNote(note) {
    if (!note) {
      setActiveNoteId(null);
      if (editorRef.current) editorRef.current.innerHTML = '';
      return;
    }
    setActiveNoteId(note.id);
    setTitle(note.title || '');
    setVisibility(note.visibility || 'private');
    setSharedWith(note.shared_with || []);
    const cleanHtml = convertMarkdownToHtml(note.content || '');
    setContent(cleanHtml);
    if (editorRef.current) {
      editorRef.current.innerHTML = cleanHtml;
    }
    setLastSaved(null);
    setShowVisibilityMenu(false);
  }

  useEffect(() => {
    if (editorRef.current && activeNoteId) {
      if (editorRef.current.innerHTML !== content && !saving) {
        editorRef.current.innerHTML = convertMarkdownToHtml(content || '');
      }
    }
  }, [activeNoteId]);

  const activeNote = useMemo(() => {
    return notes.find(n => n.id === activeNoteId) || null;
  }, [notes, activeNoteId]);

  // Salvataggio su backend (manuale o debounced)
  const saveNoteToBackend = useCallback(async (noteId, newTitle, newContent) => {
    if (!noteId) return;
    setSaving(true);
    try {
      const { data } = await api.patch(`/notes/${noteId}`, {
        title: newTitle,
        content: newContent
      });
      setNotes(prev => prev.map(n => n.id === noteId ? data : n));
      setLastSaved(new Date());
    } catch {
      toast.error('Errore durante il salvataggio automatico');
    } finally {
      setSaving(false);
    }
  }, [toast]);

  // Modifica Titolo
  function handleTitleChange(e) {
    const val = e.target.value;
    setTitle(val);
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveNoteToBackend(activeNoteId, val, content);
    }, 1000);
  }

  // Conversione da markdown grezzo / testo o HTML esistente per visualizzazione pulita
  function convertMarkdownToHtml(raw) {
    if (!raw || typeof raw !== 'string') return '';
    if (/<(h[1-6]|p|div|ul|ol|li|blockquote|pre|strong|em|br)[^>]*>/i.test(raw)) {
      return raw;
    }
    const lines = raw.split('\n');
    let html = '';
    let inCode = false;
    let codeBuffer = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('```')) {
        if (inCode) {
          html += `<pre class="note-code-block"><code>${codeBuffer.join('\n')}</code></pre>`;
          codeBuffer = [];
          inCode = false;
        } else {
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        codeBuffer.push(line);
        continue;
      }
      if (line.startsWith('# ')) {
        html += `<h1 class="note-h1">${formatInline(line.substring(2))}</h1>`;
        continue;
      }
      if (line.startsWith('## ')) {
        html += `<h2 class="note-h2">${formatInline(line.substring(3))}</h2>`;
        continue;
      }
      if (line.startsWith('### ')) {
        html += `<h3 class="note-h3">${formatInline(line.substring(4))}</h3>`;
        continue;
      }
      if (line.trim().startsWith('[ ] ') || line.trim().startsWith('[x] ')) {
        const isChecked = line.trim().startsWith('[x] ');
        const text = line.trim().substring(4);
        html += `<div class="note-checklist-item" contenteditable="false"><input type="checkbox" class="note-checkbox" ${isChecked ? 'checked' : ''} /> <span contenteditable="true" class="checklist-text">${formatInline(text)}</span></div>`;
        continue;
      }
      if (line.trim().startsWith('- ') || (line.trim().startsWith('* ') && !line.trim().startsWith('* *'))) {
        html += `<ul><li>${formatInline(line.trim().substring(2))}</li></ul>`;
        continue;
      }
      if (line.trim().startsWith('> ')) {
        html += `<blockquote>${formatInline(line.trim().substring(2))}</blockquote>`;
        continue;
      }
      if (!line.trim()) {
        html += `<p><br></p>`;
      } else {
        html += `<p>${formatInline(line)}</p>`;
      }
    }
    if (inCode && codeBuffer.length > 0) {
      html += `<pre class="note-code-block"><code>${codeBuffer.join('\n')}</code></pre>`;
    }
    return html || '<p><br></p>';
  }

  function formatInline(str) {
    return str
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>');
  }

  // Modifica Contenuto da editor visuale
  function handleEditorInput() {
    if (!editorRef.current || !activeNoteId) return;
    const newHtml = editorRef.current.innerHTML;
    setContent(newHtml);
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveNoteToBackend(activeNoteId, title, newHtml);
    }, 1000);
  }

  // ─── Supporto e Gestione Avanzata Checklist ──────────────────────────────

  function getSelectionClosest(selector) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    let node = sel.anchorNode;
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    return (node && node.closest) ? node.closest(selector) : null;
  }

  function selectionIsInside(selector) {
    return !!getSelectionClosest(selector);
  }

  function getSelectedChecklistItems() {
    if (!editorRef.current) return [];
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return [];
    const range = sel.getRangeAt(0);

    const allItems = Array.from(editorRef.current.querySelectorAll('.note-checklist-item'));
    if (allItems.length === 0) return [];

    const matched = allItems.filter(item => {
      if (item.contains(range.startContainer) || item.contains(range.endContainer)) {
        return true;
      }
      try {
        return range.intersectsNode(item);
      } catch {
        return false;
      }
    });

    if (matched.length > 0) return matched;

    let aNode = sel.anchorNode;
    if (aNode && aNode.nodeType === Node.TEXT_NODE) aNode = aNode.parentElement;
    const aItem = aNode ? aNode.closest('.note-checklist-item') : null;
    if (aItem && editorRef.current.contains(aItem)) return [aItem];

    let fNode = sel.focusNode;
    if (fNode && fNode.nodeType === Node.TEXT_NODE) fNode = fNode.parentElement;
    const fItem = fNode ? fNode.closest('.note-checklist-item') : null;
    if (fItem && editorRef.current.contains(fItem)) return [fItem];

    return [];
  }

  function placeCaretAt(node, atEnd = false) {
    if (!node) return;
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();

    if (node.nodeType === Node.TEXT_NODE) {
      const offset = atEnd ? node.textContent.length : 0;
      range.setStart(node, offset);
    } else {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
      let targetTextNode = null;
      let textNode = null;
      while ((textNode = walker.nextNode())) {
        if (!targetTextNode || atEnd) {
          targetTextNode = textNode;
        }
      }
      if (targetTextNode) {
        const offset = atEnd ? targetTextNode.textContent.length : 0;
        range.setStart(targetTextNode, offset);
      } else {
        range.setStart(node, atEnd ? node.childNodes.length : 0);
      }
    }
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function createChecklistElement(text = '') {
    const item = document.createElement('div');
    item.className = 'note-checklist-item';
    item.setAttribute('contenteditable', 'false');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'note-checkbox';

    const span = document.createElement('span');
    span.className = 'checklist-text';
    span.setAttribute('contenteditable', 'true');
    if (text) {
      span.textContent = text;
    } else {
      span.innerHTML = '<br>';
    }

    item.appendChild(checkbox);
    item.appendChild(document.createTextNode(' '));
    item.appendChild(span);
    return item;
  }

  function unwrapChecklistItem(item) {
    const textEl = item.querySelector('.checklist-text');
    const text = textEl ? textEl.textContent : item.textContent;
    const p = document.createElement('p');
    if (text && text.trim()) {
      p.textContent = text;
    } else {
      p.innerHTML = '<br>';
    }
    if (item.parentNode) {
      item.parentNode.replaceChild(p, item);
    }
    placeCaretAt(p, true);
    handleEditorInput();
  }

  // Supporto interattivo per click sulle checkbox e sul blocco checklist
  function handleEditorClick(e) {
    if (e.target && e.target.classList.contains('note-checkbox')) {
      if (e.target.checked) {
        e.target.setAttribute('checked', 'checked');
      } else {
        e.target.removeAttribute('checked');
      }
      handleEditorInput();
      return;
    }
    if (e.target && e.target.classList.contains('note-checklist-item')) {
      const span = e.target.querySelector('.checklist-text');
      if (span) {
        placeCaretAt(span, true);
      }
    }
  }

  // Supporto da tastiera per checklist (Invio, Doppio Invio, Backspace, Delete, Markdown)
  function handleEditorKeyDown(e) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    let node = sel.anchorNode;
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const checklistItem = node ? node.closest('.note-checklist-item') : null;

    if (checklistItem) {
      const textEl = checklistItem.querySelector('.checklist-text');
      if (!textEl) return;

      const fullText = (textEl.textContent || '').replace(/\u200B/g, '');
      const range = sel.getRangeAt(0);

      // --- INVIO (Enter) ---
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();

        // 1. Doppio Invio: elemento checklist vuoto -> torna a formattazione normale
        if (fullText.trim() === '') {
          const p = document.createElement('p');
          p.innerHTML = '<br>';
          if (checklistItem.parentNode) {
            checklistItem.parentNode.replaceChild(p, checklistItem);
          }
          placeCaretAt(p, false);
          handleEditorInput();
          return;
        }

        // 2. Creazione nuovo elemento checklist successivo
        const preRange = document.createRange();
        preRange.selectNodeContents(textEl);
        preRange.setEnd(range.startContainer, range.startOffset);
        const textBefore = preRange.toString();

        const postRange = document.createRange();
        postRange.selectNodeContents(textEl);
        postRange.setStart(range.endContainer, range.endOffset);
        const textAfter = postRange.toString();

        // Aggiorna l'elemento corrente con la parte prima del cursore
        if (textBefore) {
          textEl.textContent = textBefore;
        } else {
          textEl.innerHTML = '<br>';
        }

        // Crea il nuovo elemento con l'eventuale parte residua
        const newItem = createChecklistElement(textAfter);

        if (checklistItem.nextSibling) {
          checklistItem.parentNode.insertBefore(newItem, checklistItem.nextSibling);
        } else {
          checklistItem.parentNode.appendChild(newItem);
        }

        const newSpan = newItem.querySelector('.checklist-text');
        placeCaretAt(newSpan, false);
        handleEditorInput();
        return;
      }

      // --- BACKSPACE (Eliminazione) ---
      if (e.key === 'Backspace' && range.collapsed) {
        const preRange = document.createRange();
        preRange.selectNodeContents(textEl);
        preRange.setEnd(range.startContainer, range.startOffset);
        const isAtStart = preRange.toString().length === 0;

        // Se l'elemento è completamente vuoto
        if (fullText.trim() === '') {
          e.preventDefault();
          const prev = checklistItem.previousElementSibling;
          const next = checklistItem.nextElementSibling;
          checklistItem.remove();

          if (prev) {
            if (prev.classList.contains('note-checklist-item')) {
              const prevText = prev.querySelector('.checklist-text');
              placeCaretAt(prevText, true);
            } else {
              placeCaretAt(prev, true);
            }
          } else if (next) {
            if (next.classList.contains('note-checklist-item')) {
              const nextText = next.querySelector('.checklist-text');
              placeCaretAt(nextText, false);
            } else {
              placeCaretAt(next, false);
            }
          } else if (editorRef.current) {
            const p = document.createElement('p');
            p.innerHTML = '<br>';
            editorRef.current.appendChild(p);
            placeCaretAt(p, false);
          }
          handleEditorInput();
          return;
        }

        // Se il cursore è all'inizio del testo di questo elemento
        if (isAtStart) {
          e.preventDefault();
          const prev = checklistItem.previousElementSibling;
          if (prev && prev.classList.contains('note-checklist-item')) {
            const prevTextEl = prev.querySelector('.checklist-text');
            if (prevTextEl) {
              const prevLen = (prevTextEl.textContent || '').length;
              prevTextEl.textContent = (prevTextEl.textContent || '') + fullText;
              checklistItem.remove();
              if (prevTextEl.firstChild) {
                const newRange = document.createRange();
                newRange.setStart(prevTextEl.firstChild, Math.min(prevLen, prevTextEl.firstChild.textContent.length));
                newRange.collapse(true);
                sel.removeAllRanges();
                sel.addRange(newRange);
              } else {
                placeCaretAt(prevTextEl, true);
              }
            }
          } else {
            // Nessun elemento checklist precedente: converti questo in paragrafo normale
            const p = document.createElement('p');
            p.textContent = fullText;
            if (checklistItem.parentNode) {
              checklistItem.parentNode.replaceChild(p, checklistItem);
            }
            placeCaretAt(p.firstChild || p, false);
          }
          handleEditorInput();
          return;
        }
      }

      // --- DELETE / CANC (Eliminazione in avanti) ---
      if (e.key === 'Delete' && range.collapsed) {
        const postRange = document.createRange();
        postRange.selectNodeContents(textEl);
        postRange.setStart(range.endContainer, range.endOffset);
        const isAtEnd = postRange.toString().length === 0;

        if (isAtEnd) {
          const next = checklistItem.nextElementSibling;
          if (next && next.classList.contains('note-checklist-item')) {
            e.preventDefault();
            const nextTextEl = next.querySelector('.checklist-text');
            const nextText = (nextTextEl?.textContent || '').replace(/\u200B/g, '');
            if (nextText.trim() === '') {
              next.remove();
            } else {
              textEl.textContent = fullText + nextText;
              next.remove();
              if (textEl.firstChild) {
                const newRange = document.createRange();
                newRange.setStart(textEl.firstChild, fullText.length);
                newRange.collapse(true);
                sel.removeAllRanges();
                sel.addRange(newRange);
              }
            }
            handleEditorInput();
            return;
          }
        }
      }
    }

    // --- SHORTCUT MARKDOWN: digitando "[]" o "[ ]" o "- [ ]" seguito da spazio ---
    if (e.key === ' ' && !checklistItem) {
      let n = sel.anchorNode;
      if (n && n.nodeType === Node.TEXT_NODE) {
        const text = n.textContent;
        const offset = sel.anchorOffset;
        const textBefore = text.slice(0, offset);
        if (textBefore === '[]' || textBefore === '[ ]' || textBefore === '- [ ]' || textBefore === '- []') {
          e.preventDefault();
          const block = n.parentElement?.closest('p, div, h1, h2, h3, li');
          if (block && editorRef.current?.contains(block)) {
            const rest = text.slice(offset);
            const newItem = createChecklistElement(rest);
            block.parentNode.replaceChild(newItem, block);
            const newSpan = newItem.querySelector('.checklist-text');
            placeCaretAt(newSpan, false);
            handleEditorInput();
            return;
          }
        }
      }
    }
  }

  // Cambio Visibilità
  async function handleToggleVisibility(targetVisibility, targetSharedWith = sharedWith) {
    if (!activeNoteId) {
      setShowVisibilityMenu(false);
      return;
    }
    try {
      const { data } = await api.patch(`/notes/${activeNoteId}`, {
        visibility: targetVisibility,
        shared_with: targetSharedWith
      });
      setVisibility(data.visibility);
      setSharedWith(data.shared_with);
      setNotes(prev => prev.map(n => n.id === activeNoteId ? data : n));
      // Only close the menu if we are clicking a major option, not while editing the user list
      if (targetVisibility !== 'selected' || targetSharedWith === sharedWith) {
        // Do not auto-close if we are just updating the sharedWith list interactively
      }
      toast.success('Visibilità blocco note aggiornata!');
    } catch {
      toast.error("Errore nell'aggiornamento della visibilità");
    }
  }

  // Creazione Nuova Nota dal modal
  async function handleCreateNote(e) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    try {
      const { data } = await api.post('/notes', {
        title: newTitle.trim(),
        content: '',
        visibility: newVisibility,
        shared_with: newSharedWith,
        is_shared: newVisibility === 'team'
      });
      setNotes(prev => [data, ...prev]);
      selectNote(data);
      setShowNewModal(false);
      setNewTitle('');
      setNewVisibility('private');
      setNewSharedWith([]);
      toast.success('Nuovo blocco note creato!');
    } catch {
      toast.error('Errore nella creazione della nota');
    }
  }

  // Eliminazione Nota
  async function handleDeleteNote() {
    if (!activeNoteId) return;
    if (!window.confirm(`Spostare la nota "${title}" nel cestino?\nVerrà conservata per 90 giorni prima dell'eliminazione definitiva.`)) return;
    try {
      await api.delete(`/notes/${activeNoteId}`);
      toast.success('Nota spostata nel cestino');
      const updated = notes.filter(n => n.id !== activeNoteId);
      setNotes(updated);
      if (updated.length > 0) {
        selectNote(updated[0]);
      } else {
        selectNote(null);
      }
      loadTrash();
    } catch {
      toast.error('Errore durante lo spostamento nel cestino');
    }
  }

  async function handleUploadAttachment(e) {
    if (!activeNoteId) {
      toast.error('Salva la nota prima di aggiungere allegati');
      return;
    }
    if (!e.target.files || e.target.files.length === 0) return;
    await uploadFiles(e.target.files);
    e.target.value = '';
  }

  async function handleDropAttachment(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!activeNoteId) {
      toast.error('Salva la nota prima di aggiungere allegati');
      return;
    }
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await uploadFiles(e.dataTransfer.files);
    }
  }

  async function uploadFiles(files) {
    if (!activeNoteId || uploadingAttachmentsRef.current) return;
    uploadingAttachmentsRef.current = true;
    try {
      const fileArr = Array.from(files || []);
      const seen = new Set();
      const uniqueFiles = fileArr.filter(f => {
        const key = `${f.name}_${f.size}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      for (const file of uniqueFiles) {
        const fd = new FormData();
        fd.append('file', file);
        await api.post(`/notes/${activeNoteId}/attachments`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      }
      toast.success('Allegati caricati!');
      loadNotes();
    } catch (err) {
      toast.error('Errore durante il caricamento');
    } finally {
      uploadingAttachmentsRef.current = false;
    }
  }

  async function handleDeleteAttachment(filename) {
    if (!activeNoteId) return;
    if (!window.confirm('Eliminare questo allegato?')) return;
    try {
      await api.delete(`/notes/${activeNoteId}/attachments/${encodeURIComponent(filename)}`);
      toast.success('Allegato eliminato');
      loadNotes();
    } catch (err) {
      toast.error('Errore durante l\'eliminazione');
    }
  }

  const handleDownloadDoc = () => {
    if (!activeNoteId || !editorRef.current) return;
    const header = "<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'><title>" + (title || 'Nota') + "</title><style>body { font-family: sans-serif; } .note-code-block { background: #f4f4f4; padding: 10px; border-radius: 4px; } .note-checklist-item { margin-bottom: 5px; list-style-type: none; } h1, h2, h3 { color: #1f2937; margin-bottom: 16px; }</style></head><body>";
    const footer = "</body></html>";
    const htmlContent = editorRef.current.innerHTML;
    const html = header + `<h1>${title || 'Senza Titolo'}</h1><hr>` + htmlContent + footer;

    const blob = new Blob(['\ufeff', html], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${title || 'Nota'}.doc`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Formattazione visuale istantanea stile Notion (H1, H2, Bold, Check-list, ecc.)
  function escapeHtmlText(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function getCurrentBlock() {
    try {
      return (document.queryCommandValue('formatBlock') || '').toLowerCase();
    } catch {
      return '';
    }
  }

  const updateActiveFormats = useCallback(() => {
    if (!editorRef.current) return;
    try {
      const isBold = Boolean(document.queryCommandState('bold'));
      const isItalic = Boolean(document.queryCommandState('italic'));
      const isBullet = Boolean(document.queryCommandState('insertUnorderedList'));
      const block = (document.queryCommandValue('formatBlock') || '').toLowerCase();
      const isTodo = selectionIsInside('.note-checklist-item');
      const isCode = selectionIsInside('.note-code-block');
      const isQuote = block.includes('blockquote') || selectionIsInside('blockquote');
      const isH1 = block.includes('h1') || selectionIsInside('h1');
      const isH2 = block.includes('h2') || selectionIsInside('h2');
      setActiveFormats({
        bold: isBold,
        italic: isItalic,
        bullet: isBullet,
        h1: isH1,
        h2: isH2,
        quote: isQuote,
        todo: isTodo,
        code: isCode,
      });
    } catch {
      // noop
    }
  }, []);

  function applyFormatting(formatType) {
    if (!editorRef.current) return;
    if (!editorRef.current.contains(document.activeElement)) {
      editorRef.current.focus();
    }

    switch (formatType) {
      case 'h1': {
        const selectedChecklist = getSelectedChecklistItems();
        if (selectedChecklist.length > 0) {
          let lastH = null;
          selectedChecklist.forEach(item => {
            const text = item.querySelector('.checklist-text')?.textContent || item.textContent;
            const h = document.createElement('h1');
            h.className = 'note-h1';
            h.textContent = text.trim() || '';
            if (!text.trim()) h.innerHTML = '<br>';
            if (item.parentNode) {
              item.parentNode.replaceChild(h, item);
              lastH = h;
            }
          });
          if (lastH) placeCaretAt(lastH, true);
          break;
        }
        document.execCommand('formatBlock', false, getCurrentBlock() === 'h1' ? '<p>' : '<h1>');
        break;
      }
      case 'h2': {
        const selectedChecklist = getSelectedChecklistItems();
        if (selectedChecklist.length > 0) {
          let lastH = null;
          selectedChecklist.forEach(item => {
            const text = item.querySelector('.checklist-text')?.textContent || item.textContent;
            const h = document.createElement('h2');
            h.className = 'note-h2';
            h.textContent = text.trim() || '';
            if (!text.trim()) h.innerHTML = '<br>';
            if (item.parentNode) {
              item.parentNode.replaceChild(h, item);
              lastH = h;
            }
          });
          if (lastH) placeCaretAt(lastH, true);
          break;
        }
        document.execCommand('formatBlock', false, getCurrentBlock() === 'h2' ? '<p>' : '<h2>');
        break;
      }
      case 'bold':
        document.execCommand('bold', false, null);
        break;
      case 'italic':
        document.execCommand('italic', false, null);
        break;
      case 'bullet':
        document.execCommand('insertUnorderedList', false, null);
        break;
      case 'todo': {
        // Se la selezione interseca una o più check-list, le rimuove tutte (toggle off a paragrafo normale)
        const selectedItems = getSelectedChecklistItems();
        if (selectedItems.length > 0) {
          let lastP = null;
          selectedItems.forEach(item => {
            const textEl = item.querySelector('.checklist-text');
            const text = textEl ? textEl.textContent : item.textContent;
            const p = document.createElement('p');
            if (text && text.trim()) {
              p.textContent = text;
            } else {
              p.innerHTML = '<br>';
            }
            if (item.parentNode) {
              item.parentNode.replaceChild(p, item);
              lastP = p;
            }
          });
          if (lastP) {
            placeCaretAt(lastP, true);
          }
          break;
        }

        // Altrimenti trasforma i blocchi/paragrafi selezionati in checklist
        const sel = window.getSelection();
        let blocks = [];
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          const allBlocks = Array.from(editorRef.current.querySelectorAll('p, h1, h2, h3, blockquote'));
          blocks = allBlocks.filter(b => {
            if (b.contains(range.startContainer) || b.contains(range.endContainer)) return true;
            try { return range.intersectsNode(b); } catch { return false; }
          });
          if (blocks.length === 0 && range.startContainer) {
            let n = range.startContainer;
            if (n.nodeType === Node.TEXT_NODE) n = n.parentElement;
            const singleBlock = n ? n.closest('p, h1, h2, h3, blockquote') : null;
            if (singleBlock && editorRef.current.contains(singleBlock)) {
              blocks = [singleBlock];
            }
          }
        }

        if (blocks.length > 0) {
          let lastItem = null;
          blocks.forEach(block => {
            const text = block.textContent.trim();
            const newItem = createChecklistElement(text);
            block.parentNode.replaceChild(newItem, block);
            lastItem = newItem;
          });
          if (lastItem) {
            const span = lastItem.querySelector('.checklist-text');
            placeCaretAt(span, true);
          }
        } else {
          const text = sel && sel.toString().trim() ? sel.toString() : '';
          const newItem = createChecklistElement(text);
          document.execCommand('insertHTML', false, newItem.outerHTML);
          const inserted = editorRef.current.querySelector('.note-checklist-item:last-of-type') || getSelectionClosest('.note-checklist-item');
          if (inserted) {
            const s = inserted.querySelector('.checklist-text');
            placeCaretAt(s, false);
          }
        }
        break;
      }
      case 'quote':
        document.execCommand('formatBlock', false, getCurrentBlock() === 'blockquote' ? '<p>' : 'blockquote');
        break;
      case 'code':
        if (selectionIsInside('.note-code-block')) return;
        {
          const sel = window.getSelection();
          const text = sel && sel.toString() ? sel.toString() : 'inserisci qui il codice';
          document.execCommand('insertHTML', false, `<pre class="note-code-block"><code>${escapeHtmlText(text)}</code></pre><p><br></p>`);
        }
        break;
      case 'normal': {
        // Se la selezione interseca una o più checklist, le rimuove tutte convertendole in <p>
        const selectedChecklist = getSelectedChecklistItems();
        if (selectedChecklist.length > 0) {
          let lastP = null;
          selectedChecklist.forEach(item => {
            const textEl = item.querySelector('.checklist-text');
            const text = textEl ? textEl.textContent : item.textContent;
            const p = document.createElement('p');
            if (text && text.trim()) {
              p.textContent = text;
            } else {
              p.innerHTML = '<br>';
            }
            if (item.parentNode) {
              item.parentNode.replaceChild(p, item);
              lastP = p;
            }
          });
          if (lastP) {
            placeCaretAt(lastP, true);
          }
        }

        // Se siamo dentro un blocco di codice, lo rimuoviamo
        const codeBlock = getSelectionClosest('.note-code-block');
        if (codeBlock) {
          const p = document.createElement('p');
          p.textContent = codeBlock.textContent;
          if (codeBlock.parentNode) codeBlock.parentNode.replaceChild(p, codeBlock);
          placeCaretAt(p, true);
        }

        // Reset standard formattazione
        document.execCommand('formatBlock', false, '<p>');
        document.execCommand('removeFormat', false, null);
        if (document.queryCommandState('insertUnorderedList')) document.execCommand('insertUnorderedList');
        if (document.queryCommandState('insertOrderedList')) document.execCommand('insertOrderedList');
        break;
      }
      default:
        return;
    }
    handleEditorInput();
    setTimeout(updateActiveFormats, 10);
  }

  // Filtra note per tab e ricerca
  const filteredNotes = useMemo(() => {
    return notes.filter(n => {
      const isActuallyShared = n.is_shared || n.visibility === 'team' || n.visibility === 'selected';
      if (!isActuallyShared && n.owner_id !== user?.id) return false;
      if (activeTab === 'private' && isActuallyShared) return false;
      if (activeTab === 'shared' && !isActuallyShared) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesTitle = n.title?.toLowerCase().includes(q);
        const matchesContent = n.content?.toLowerCase().includes(q);
        return matchesTitle || matchesContent;
      }
      return true;
    });
  }, [notes, activeTab, searchQuery, user]);

  // Note ordinate in base al criterio selezionato (data / alfabetico / personalizzato)
  const displayedNotes = useMemo(() => {
    const list = [...filteredNotes];
    if (sortMode === 'alpha') {
      list.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'it', { sensitivity: 'base' }));
    } else if (sortMode === 'created') {
      list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    } else {
      // Ordine personalizzato (drag & drop): note non ancora ordinate in fondo
      list.sort((a, b) => {
        const ia = customOrder.indexOf(a.id);
        const ib = customOrder.indexOf(b.id);
        if (ia === -1 && ib === -1) return 0;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });
    }
    return list;
  }, [filteredNotes, sortMode, customOrder]);

  // Gestione drag & drop per riordino personalizzato
  function handleDragStart(e, id) {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', id); } catch { /* noop */ }
  }

  function handleDragOver(e, targetId) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    setDropTarget({ id: targetId, pos: before ? 'before' : 'after' });
  }

  function handleDragEnd() {
    setDragId(null);
    setDropTarget(null);
  }

  function handleDrop(e, targetId) {
    e.preventDefault();
    e.stopPropagation();
    const srcId = dragId || e.dataTransfer.getData('text/plain');
    const rect = e.currentTarget.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    setDragId(null);
    setDropTarget(null);
    if (!srcId || srcId === targetId) return;
    setCustomOrder(prev => {
      const order = [...prev];
      const allIds = notes.map(n => n.id);
      for (const id of allIds) if (!order.includes(id)) order.push(id);
      const from = order.indexOf(srcId);
      let to = order.indexOf(targetId);
      if (from === -1 || to === -1) return prev;
      order.splice(from, 1);
      if (from < to) to -= 1;
      if (!before) to += 1;
      order.splice(to, 0, srcId);
      localStorage.setItem(NOTES_ORDER_KEY, JSON.stringify(order));
      return order;
    });
    setSortMode('custom');
  }

  // Formatta data in modo compatto
  function formatRelativeDate(dateStr) {
    if (!dateStr) return '';
    // Append 'Z' to treat the date as UTC if it lacks timezone info
    let safeDateStr = dateStr;
    if (typeof safeDateStr === 'string' && !safeDateStr.endsWith('Z') && !safeDateStr.includes('+')) {
      if (!safeDateStr.includes('T')) safeDateStr = safeDateStr.replace(' ', 'T');
      safeDateStr += 'Z';
    }
    const date = new Date(safeDateStr);
    const now = new Date();
    const diffHours = Math.round((now - date) / (1000 * 60 * 60));
    if (diffHours < 1) return 'Adesso';
    if (diffHours < 24) return `${diffHours}h fa`;
    return date.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
  }

  // Formatta data per l'intestazione della nota
  function formatNoteDate(dateStr) {
    if (!dateStr) return '';
    let safeDateStr = dateStr;
    if (typeof safeDateStr === 'string' && !safeDateStr.endsWith('Z') && !safeDateStr.includes('+')) {
      if (!safeDateStr.includes('T')) safeDateStr = safeDateStr.replace(' ', 'T');
      safeDateStr += 'Z';
    }
    const date = new Date(safeDateStr);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;

  return (
    <div className="notes-page-container animate-fadeIn">
      {/* SIDEBAR SINISTRA */}
      <aside className="notes-sidebar">
        {/* CAMPO DI RICERCA (SOPRA I FILTRI) */}
        <div className="notes-search-wrapper" style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <img
            src="/hiway-icon.png"
            alt="HiWay"
            title="Cerca in HiWay GanttFlow"
            className="notes-search-icon"
            style={{ position: 'absolute', left: 12, width: 18, height: 18, objectFit: 'contain', pointerEvents: 'none' }}
          />
          <input
            type="text"
            className="notes-search-input"
            style={{ paddingLeft: 38 }}
            placeholder="Cerca tra gli appunti..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label="Cancella ricerca"
              style={{ position: 'absolute', right: 12, background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 13 }}
            >
              <AppIcon name="close" size={14} />
            </button>
          )}
        </div>

        {/* ORDINAMENTO E NUOVA NOTA */}
        <div className="notes-sidebar-top">
          <div className="notes-sort-container">
            <ArrowUpDown size={13} className="notes-sort-icon-left" />
            <select
              className="notes-sort-select"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value)}
              aria-label="Ordina note"
            >
              <option value="created">Data di creazione</option>
              <option value="alpha">Alfabetico (A-Z)</option>
              <option value="custom">Personalizzato (trascina)</option>
            </select>
            <ChevronDown size={13} className="notes-sort-icon-right" />
          </div>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              setNewTitle('');
              setNewVisibility('private');
              setNewSharedWith([]);
              setShowNewModal(true);
            }}
          >
            <AppIcon name="plus" size={15} />
            Nuova
          </button>
        </div>

        {/* TABS FILTRO */}
        <div className="notes-tabs">
          <button
            className={`notes-tab-btn notes-tab-btn--all ${activeTab === 'all' ? 'active' : ''}`}
            onClick={() => setActiveTab('all')}
          >
            Tutte ({notes.length})
          </button>
          <button
            className={`notes-tab-btn notes-tab-btn--private ${activeTab === 'private' ? 'active' : ''}`}
            onClick={() => setActiveTab('private')}
          >
            <AppIcon name="lock" size={14} />
            Private
          </button>
          <button
            className={`notes-tab-btn notes-tab-btn--shared ${activeTab === 'shared' ? 'active' : ''}`}
            onClick={() => setActiveTab('shared')}
          >
            <AppIcon name="users" size={14} />
            Condivise
          </button>
        </div>

        {/* LISTA SCHEDE NOTE */}
        <div className={`notes-list notes-list--${activeTab}`}>
          {displayedNotes.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8125rem', padding: '32px 12px' }}>
              Nessun blocco note trovato.
            </div>
          ) : (
            displayedNotes.map(note => {
              const isSelected = note.id === activeNoteId;
              const isMine = note.owner_id === user?.id;
              const showBefore = sortMode === 'custom' && dragId && dragId !== note.id && dropTarget?.id === note.id && dropTarget.pos === 'before';
              const showAfter = sortMode === 'custom' && dragId && dragId !== note.id && dropTarget?.id === note.id && dropTarget.pos === 'after';
              return (
                <Fragment key={note.id}>
                  {showBefore && <div className="note-drop-indicator" />}
                  <div
                    className={`note-card ${isSelected ? 'active' : ''} ${dragId === note.id ? 'dragging' : ''}`}
                    draggable={sortMode === 'custom'}
                    onDragStart={(e) => handleDragStart(e, note.id)}
                    onDragOver={sortMode === 'custom' ? (e) => handleDragOver(e, note.id) : undefined}
                    onDrop={sortMode === 'custom' ? (e) => handleDrop(e, note.id) : undefined}
                    onDragEnd={handleDragEnd}
                    onClick={() => selectNote(note)}
                  >
                    {sortMode === 'custom' && (
                      <span className="note-drag-handle" title="Trascina per riordinare">
                        <AppIcon name="grip" size={14} />
                      </span>
                    )}
                    <div className="note-card-header">
                      <span className="note-card-title">{note.title || 'Senza Titolo'}</span>
                      <span
                        className={`note-visibility-badge ${note.visibility === 'team' ? 'badge-shared' : note.visibility === 'selected' ? 'badge-selected' : 'badge-private'}`}
                        title={note.visibility === 'team' ? 'Condiviso' : note.visibility === 'selected' ? 'Utenti Selezionati' : 'Privato'}
                        style={{ padding: '4px 6px' }}
                      >
                        <AppIcon name={note.visibility === 'team' ? 'users' : note.visibility === 'selected' ? 'user-check' : 'lock'} size={14} />
                      </span>
                    </div>
                  </div>
                  {showAfter && <div className="note-drop-indicator" />}
                </Fragment>
              );
            })
          )}
        </div>

        <div style={{ marginTop: 'auto', paddingTop: 12, borderTop: '1px solid var(--border-subtle)', flexShrink: 0 }}>
          <button
            className="notes-trash-btn"
            onClick={() => { setShowTrashModal(true); loadTrash(); }}
            title="Cestino Note (conservate per 90 giorni)"
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid var(--border-subtle)',
              background: 'var(--bg-tertiary)',
              cursor: 'pointer',
              fontSize: '0.82rem',
              fontWeight: 600,
              color: 'var(--text-secondary)',
              transition: 'all 0.15s ease'
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <AppIcon name="trash" size={15} /> Cestino
            </span>
            {trashNotes.length > 0 && (
              <span
                style={{
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  padding: '1px 6px',
                  borderRadius: 999,
                  background: 'rgba(239, 68, 68, 0.15)',
                  color: 'var(--danger, #ef4444)'
                }}
              >
                {trashNotes.length}
              </span>
            )}
          </button>
        </div>
      </aside>

      {/* AREA EDITOR CENTRALE (NOTION STYLE) */}
      <main className="notes-editor-container">
        {!activeNote ? (
          <div className="notes-empty-selection">
            <span className="empty-state-icon"><AppIcon name="notes" size={28} /></span>
            <h3 style={{ fontSize: '1.25rem', color: 'var(--text-primary)', marginBottom: '8px' }}>Seleziona o crea un blocco note</h3>
            <p style={{ maxWidth: 400, marginBottom: '24px', lineHeight: 1.5 }}>
              Scrivi appunti, specifiche di commessa o check-list. Puoi decidere in qualsiasi momento se mantenere il file privato o condividerlo con il resto del team.
            </p>
            <button
              className="btn btn-primary"
              onClick={() => {
                setNewTitle('');
                setNewVisibility('private');
                setNewSharedWith([]);
                setShowNewModal(true);
              }}
            >
              <AppIcon name="plus" />
              Crea il primo blocco note
            </button>
          </div>
        ) : (
          <>
            {/* TOOLBAR TOP (OWNER, VISIBILITÀ, AZIONI) — FISSA, NON SCROLLA */}
            <div className="notes-editor-toolbar-top">
              <div className="note-owner-info">
                <span className="sidebar-avatar" style={{ width: 26, height: 26, fontSize: '0.7rem' }}>
                  {activeNote.owner?.username?.[0]?.toUpperCase() || 'U'}
                </span>
                <span>
                  Autore: <strong>{activeNote.owner?.full_name || activeNote.owner?.username || (activeNote.owner_id === user?.id ? 'Tu' : 'Utente')}</strong>
                </span>
                {activeNote.created_at && (
                  <span className="note-header-date" title={new Date(activeNote.created_at).toLocaleString('it-IT')}>
                    <span className="note-header-date-sep">•</span>
                    <Calendar size={13} style={{ opacity: 0.7 }} />
                    <span>{formatNoteDate(activeNote.created_at)}</span>
                  </span>
                )}
                {saving && <span className="note-save-state">Salvataggio…</span>}
                {!saving && lastSaved && <span className="note-save-state saved"><AppIcon name="check" size={13} />Salvato {lastSaved.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</span>}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {/* MENU TOGGLE MODIFICA VISIBILITÀ */}
                <div className="visibility-toggle-dropdown">
                  <button
                    type="button"
                    className={`visibility-btn-interactive ${visibility === 'team' ? 'badge-shared' : visibility === 'selected' ? 'badge-selected' : 'badge-private'}`}
                    onClick={() => {
                      if (activeNote.owner_id === user?.id || visibility === 'selected' || visibility === 'team') {
                        setShowVisibilityMenu(!showVisibilityMenu);
                      }
                    }}
                    title={activeNote.owner_id === user?.id ? "Clicca per modificare la visibilità del blocco note" : "Clicca per vedere chi ha accesso"}
                    style={{ cursor: (activeNote.owner_id === user?.id || visibility === 'selected' || visibility === 'team') ? 'pointer' : 'default', opacity: activeNote.owner_id === user?.id ? 1 : 0.8 }}
                  >
                    <AppIcon name={visibility === 'team' ? 'users' : visibility === 'selected' ? 'user-check' : 'lock'} size={14} />
                    {visibility === 'team' ? 'Condiviso' : visibility === 'selected' ? 'Utenti Selezionati' : 'Privato'}
                    {(activeNote.owner_id === user?.id || visibility === 'selected' || visibility === 'team') && <AppIcon name="chevronDown" size={12} />}
                  </button>

                  {showVisibilityMenu && (
                    <div className="visibility-menu-popup">
                      {activeNote.owner_id === user?.id ? (
                        <>
                          <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: 8 }}>
                            IMPOSTAZIONI VISIBILITÀ
                          </div>
                          <div
                            className={`visibility-option ${visibility === 'private' ? 'selected' : ''}`}
                            onClick={() => handleToggleVisibility('private')}
                          >
                            <AppIcon name="lock" size={18} />
                            <div>
                              <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>File Privato</div>
                              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Visibile solo al tuo account personale</div>
                            </div>
                          </div>
                          <div
                            className={`visibility-option ${visibility === 'team' ? 'selected' : ''}`}
                            onClick={() => handleToggleVisibility('team')}
                            style={{ marginTop: 6 }}
                          >
                            <AppIcon name="users" size={18} />
                            <div>
                              <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>In Condivisione</div>
                              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Accessibile in lettura a tutto il team</div>
                            </div>
                          </div>
                          <div
                            className={`visibility-option ${visibility === 'selected' ? 'selected' : ''}`}
                            onClick={() => handleToggleVisibility('selected', sharedWith)}
                            style={{ marginTop: 6 }}
                          >
                            <AppIcon name="user-check" size={18} />
                            <div>
                              <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>Utenti Selezionati</div>
                              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Solo gli utenti scelti possono leggere</div>
                            </div>
                          </div>
                          {visibility === 'selected' && (
                            <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border-subtle)', marginTop: 8 }}>
                              <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>SELEZIONA UTENTI</div>
                              <AssigneeInput
                                selected={sharedWith}
                                onChange={(newShared) => {
                                  setSharedWith(newShared);
                                  handleToggleVisibility('selected', newShared);
                                }}
                                users={users}
                              />
                            </div>
                          )}
                        </>
                      ) : (
                        <div style={{ padding: '8px 12px' }}>
                          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 10 }}>CONDIVISO CON</div>
                          {visibility === 'team' ? (
                            <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <AppIcon name="users" size={14} /> Tutto il team
                            </div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                              {sharedWith.length > 0 ? sharedWith.map(u => {
                                const matchedUser = users.find(userObj => userObj.username === u);
                                return (
                                  <div key={u} style={{ fontSize: '0.85rem', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <AppIcon name="user" size={14} />
                                    {matchedUser ? (matchedUser.full_name || matchedUser.username) : u}
                                  </div>
                                );
                              }) : (
                                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Nessun utente specifico</div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* PULSANTE DOWNLOAD DOC */}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={handleDownloadDoc}
                  title="Scarica in formato Word (.doc)"
                >
                  <AppIcon name="download" size={15} />
                </button>

                {/* PULSANTE ELIMINA */}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={handleDeleteNote}
                  style={{ color: '#f87171' }}
                  title="Elimina nota"
                >
                  <AppIcon name="trash" size={15} />
                  Elimina
                </button>
              </div>
            </div>

            {/* AREA SCROLLABILE CON SUPPORTO DRAG & DROP GLOBALE */}
            <div
              className="notes-editor-scroll"
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onDrop={handleDropAttachment}
            >
              {/* TOOLBAR DI FORMATTAZIONE STYLE NOTION (A TUTTA LARGHEZZA) */}
              <div className="notion-formatting-bar">
                {/* Sezione Sinistra: Strumenti di Formattazione */}
                <div className="format-toolbar-left">
                  {/* Gruppo 1: Intestazioni e Testo */}
                  <div className="format-group">
                    <button
                      type="button"
                      className={`format-btn ${!activeFormats.h1 && !activeFormats.h2 && !activeFormats.quote && !activeFormats.todo && !activeFormats.code ? 'active' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyFormatting('normal')}
                      title="Testo normale (Paragrafo)"
                      aria-label="Testo normale"
                    >
                      <Type size={14} />
                      <span>Testo</span>
                    </button>
                    <button
                      type="button"
                      className={`format-btn ${activeFormats.h1 ? 'active' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyFormatting('h1')}
                      title="Titolo principale (H1)"
                      aria-label="Titolo principale (H1)"
                    >
                      <Heading1 size={14} />
                      <span>Titolo</span>
                    </button>
                    <button
                      type="button"
                      className={`format-btn ${activeFormats.h2 ? 'active' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyFormatting('h2')}
                      title="Sottotitolo (H2)"
                      aria-label="Sottotitolo (H2)"
                    >
                      <Heading2 size={14} />
                      <span>Sottotitolo</span>
                    </button>
                  </div>

                  <div className="format-divider" />

                  {/* Gruppo 2: Inline Styles */}
                  <div className="format-group">
                    <button
                      type="button"
                      className={`format-btn format-btn--icon ${activeFormats.bold ? 'active' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyFormatting('bold')}
                      title="Grassetto (Ctrl+B)"
                      aria-label="Grassetto"
                    >
                      <Bold size={14} strokeWidth={2.4} />
                    </button>
                    <button
                      type="button"
                      className={`format-btn format-btn--icon ${activeFormats.italic ? 'active' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyFormatting('italic')}
                      title="Corsivo (Ctrl+I)"
                      aria-label="Corsivo"
                    >
                      <Italic size={14} strokeWidth={2.4} />
                    </button>
                  </div>

                  <div className="format-divider" />

                  {/* Gruppo 3: Elenchi e Blocchi */}
                  <div className="format-group">
                    <button
                      type="button"
                      className={`format-btn ${activeFormats.bullet ? 'active' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyFormatting('bullet')}
                      title="Elenco puntato"
                      aria-label="Elenco puntato"
                    >
                      <List size={14} />
                      <span>Elenco</span>
                    </button>
                    <button
                      type="button"
                      className={`format-btn ${activeFormats.todo ? 'active' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyFormatting('todo')}
                      title="Check-list interattiva"
                      aria-label="Check-list interattiva"
                    >
                      <ListTodo size={14} />
                      <span>Check-list</span>
                    </button>
                    <button
                      type="button"
                      className={`format-btn ${activeFormats.quote ? 'active' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyFormatting('quote')}
                      title="Citazione"
                      aria-label="Citazione"
                    >
                      <Quote size={13} />
                      <span className="fmt-label-optional">Citazione</span>
                    </button>
                    <button
                      type="button"
                      className={`format-btn ${activeFormats.code ? 'active' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyFormatting('code')}
                      title="Blocco di codice"
                      aria-label="Blocco di codice"
                    >
                      <Code size={14} />
                      <span className="fmt-label-optional">Codice</span>
                    </button>
                  </div>
                </div>

                {/* Sezione Destra: Reset Formattazione */}
                <div className="format-toolbar-right">
                  <button
                    type="button"
                    className="format-btn format-btn--clear"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyFormatting('normal')}
                    title="Rimuovi ogni formattazione"
                    aria-label="Rimuovi ogni formattazione"
                  >
                    <Eraser size={14} />
                    <span>Pulisci</span>
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '32px', minHeight: '100%' }}>

                {/* COLONNA SINISTRA: EDITOR TESTUALE */}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  {/* CAMPO TITOLO */}
                  <input
                    type="text"
                    className="note-title-input"
                    value={title}
                    onChange={handleTitleChange}
                    placeholder="Titolo del Blocco Note..."
                  />

                  {/* AREA TESTO VISUALE WYSIWYG CENTRALE */}
                  <div
                    ref={editorRef}
                    contentEditable
                    className="note-content-area"
                    onInput={handleEditorInput}
                    onClick={(e) => {
                      handleEditorClick(e);
                      setTimeout(updateActiveFormats, 10);
                    }}
                    onKeyUp={() => setTimeout(updateActiveFormats, 10)}
                    onKeyDown={handleEditorKeyDown}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleDropAttachment(e);
                    }}
                    placeholder="Scrivi qui i tuoi appunti... Usa i pulsanti sopra per formattare con titoli, check-list e citazioni."
                    suppressContentEditableWarning
                  />
                </div>

                {/* COLONNA DESTRA: ALLEGATI */}
                {activeNote && (
                  <div style={{ width: '280px', flexShrink: 0, borderLeft: '1px solid var(--border-default)', paddingLeft: '24px', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                      <h4 style={{ margin: 0, fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)' }}>
                        Allegati
                      </h4>
                      <div>
                        <input
                          type="file"
                          id="note-attachment-upload"
                          multiple
                          style={{ display: 'none' }}
                          onChange={handleUploadAttachment}
                        />
                        <label htmlFor="note-attachment-upload" className="btn btn-secondary btn-sm" style={{ cursor: 'pointer', padding: '4px 8px', fontSize: '0.75rem' }}>
                          + Aggiungi
                        </label>
                      </div>
                    </div>

                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 16 }}>
                      Puoi anche trascinare i file ovunque in questa pagina per allegarli.
                    </div>

                    {Array.isArray(activeNote.attachments) && activeNote.attachments.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {activeNote.attachments.map((att, idx) => (
                          <div key={idx} style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            padding: '8px 12px', background: 'var(--bg-secondary)',
                            border: '1px solid var(--border-subtle)', borderRadius: '8px', fontSize: '0.8rem'
                          }}>
                            <a className="inline-detail-row" href={`${BACKEND_URL}/${att.path}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-500)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '8px' }} title={att.name}>
                              <AppIcon name="paperclip" size={13} style={{ flexShrink: 0 }} />
                              <span style={{ marginLeft: 4 }}>{att.name}</span>
                            </a>
                            <button
                              onClick={() => handleDeleteAttachment(att.name)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', padding: '2px', fontSize: 14, flexShrink: 0 }}
                              title="Elimina allegato"
                              aria-label="Elimina allegato"
                            >
                              <AppIcon name="close" size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic', background: 'var(--bg-tertiary)', padding: '16px', borderRadius: '8px', textAlign: 'center', border: '1px dashed var(--border-subtle)' }}>
                        Nessun allegato presente
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      {/* MODALE NUOVA NOTA */}
      {showNewModal && (
        <div className="note-modal-overlay animate-fadeIn">
          <div className="note-modal-box" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                Nuovo blocco note
              </h3>
              <button
                type="button"
                className="btn-ghost btn-icon"
                onClick={() => setShowNewModal(false)}
                aria-label="Chiudi"
              >
                <AppIcon name="close" />
              </button>
            </div>

            <form onSubmit={handleCreateNote}>
              <div className="input-group">
                <label>Titolo del Blocco Note *</label>
                <input
                  type="text"
                  className="input"
                  placeholder="Es. Check-list collaudo o Appunti di riunione..."
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  required
                  autoFocus
                />
              </div>

              <div className="input-group" style={{ marginTop: 20 }}>
                <label>Visibilità Iniziale del File</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 12,
                      padding: 14,
                      borderRadius: 10,
                      background: newVisibility === 'private' ? 'rgba(56, 189, 248, 0.1)' : 'rgba(255, 255, 255, 0.03)',
                      border: `1px solid ${newVisibility === 'private' ? '#38bdf8' : 'var(--border-subtle)'}`,
                      cursor: 'pointer'
                    }}
                  >
                    <input
                      type="radio"
                      name="visibility"
                      checked={newVisibility === 'private'}
                      onChange={() => setNewVisibility('private')}
                      style={{ marginTop: 3 }}
                    />
                    <div>
                      <div className="inline-heading" style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}><AppIcon name="lock" size={15} />File privato</div>
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                        Visibile solo a te. Potrai comunque renderlo condiviso in qualsiasi momento una volta aperto.
                      </div>
                    </div>
                  </label>

                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 12,
                      padding: 14,
                      borderRadius: 10,
                      background: newVisibility === 'team' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(255, 255, 255, 0.03)',
                      border: `1px solid ${newVisibility === 'team' ? '#34d399' : 'var(--border-subtle)'}`,
                      cursor: 'pointer'
                    }}
                  >
                    <input
                      type="radio"
                      name="visibility"
                      checked={newVisibility === 'team'}
                      onChange={() => setNewVisibility('team')}
                      style={{ marginTop: 3 }}
                    />
                    <div>
                      <div className="inline-heading" style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}><AppIcon name="users" size={15} />Condiviso con il team</div>
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                        Accessibile a tutto il personale per la consultazione e la collaborazione comune.
                      </div>
                    </div>
                  </label>

                  <div style={{
                    borderRadius: 10,
                    background: newVisibility === 'selected' ? 'rgba(245, 158, 11, 0.1)' : 'rgba(255, 255, 255, 0.03)',
                    border: `1px solid ${newVisibility === 'selected' ? '#f59e0b' : 'var(--border-subtle)'}`,
                    display: 'flex',
                    flexDirection: 'column'
                  }}>
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 12,
                        padding: 14,
                        cursor: 'pointer'
                      }}
                    >
                      <input
                        type="radio"
                        name="visibility"
                        checked={newVisibility === 'selected'}
                        onChange={() => setNewVisibility('selected')}
                        style={{ marginTop: 3 }}
                      />
                      <div>
                        <div className="inline-heading" style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}><AppIcon name="user-check" size={15} />Utenti selezionati</div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                          Scegli manualmente quali utenti possono leggere questo blocco note.
                        </div>
                      </div>
                    </label>
                    {newVisibility === 'selected' && (
                      <div style={{ padding: '0 14px 14px 44px' }}>
                        <AssigneeInput
                          selected={newSharedWith}
                          onChange={setNewSharedWith}
                          users={users}
                          placeholder="Cerca utente per aggiungerlo..."
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 28 }}>
                <button type="button" className="btn btn-secondary" onClick={() => setShowNewModal(false)}>
                  Annulla
                </button>
                <button type="submit" className="btn btn-primary">
                  Crea e Apri Blocco Note →
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODALE CESTINO NOTE */}
      {showTrashModal && (
        <div className="modal-overlay" onClick={() => setShowTrashModal(false)}>
          <div
            className="modal trash-modal animate-scaleIn"
            style={{
              maxWidth: 780,
              width: '94%',
              maxHeight: '85vh',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--bg-card, #ffffff)',
              backgroundColor: 'var(--bg-card, #ffffff)',
              borderRadius: 16,
              padding: '24px',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.35)',
              border: '1px solid var(--border-default)',
              zIndex: 1001,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header del Cestino */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 16, borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 12,
                  background: 'rgba(239, 68, 68, 0.12)', color: 'var(--danger, #ef4444)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
                }}>
                  <AppIcon name="trash" size={24} />
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>Cestino Note</h2>
                    <span style={{
                      fontSize: '0.75rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                      background: 'rgba(148, 163, 184, 0.16)', color: 'var(--text-secondary)'
                    }}>
                      {trashNotes.length} {trashNotes.length === 1 ? 'elemento' : 'elementi'}
                    </span>
                  </div>
                  <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: 'var(--text-tertiary)' }}>
                    {user?.role === 'admin'
                      ? "Mostra le note create da te e quelle condivise con il team. Gli elementi vengono conservati per 90 giorni prima dell'eliminazione definitiva automatica."
                      : "Mostra solo le note create da te. Gli elementi vengono conservati per 90 giorni prima dell'eliminazione definitiva automatica."}
                  </p>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {trashNotes.length > 0 && (
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={handleEmptyTrash}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', padding: '6px 12px' }}
                  >
                    <AppIcon name="trash" size={14} />
                    Svuota Cestino
                  </button>
                )}
                <button
                  type="button"
                  className="btn-ghost btn-icon"
                  onClick={() => setShowTrashModal(false)}
                  aria-label="Chiudi"
                  style={{ width: 34, height: 34, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <AppIcon name="close" size={18} />
                </button>
              </div>
            </div>

            {/* Lista delle Note nel Cestino */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 0', minHeight: 220 }}>
              {trashLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '60px 0' }}>
                  <div className="spinner" />
                </div>
              ) : trashNotes.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '50px 20px', color: 'var(--text-tertiary)' }}>
                  <div style={{
                    width: 54, height: 54, borderRadius: '50%',
                    background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center',
                    justifyContent: 'center', margin: '0 auto 16px', color: 'var(--text-muted)'
                  }}>
                    <AppIcon name="trash" size={26} />
                  </div>
                  <h3 style={{ fontSize: '0.98rem', fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 6px' }}>
                    Il cestino è vuoto
                  </h3>
                  <p style={{ fontSize: '0.84rem', margin: 0 }}>
                    Nessuna nota presente nel cestino.
                  </p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {trashNotes.map((n) => (
                    <div
                      key={n.id}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '12px 16px', borderRadius: 10,
                        border: '1px solid var(--border-default)', background: 'var(--bg-card)',
                        gap: 16
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.92rem', marginBottom: 4 }}>
                          {n.title || 'Senza Titolo'}
                        </div>
                        {n.content && (
                          <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {n.content.replace(/<[^>]*>/g, '').slice(0, 100)}
                          </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                          <span>
                            {n.owner_id === user?.id
                              ? 'Creata da te'
                              : `Creata da: ${n.owner?.full_name || n.owner?.username || 'Utente'} (Team)`}
                          </span>
                          <span>•</span>
                          <span>Eliminata il {n.deleted_at ? new Date(n.deleted_at).toLocaleDateString('it-IT') : 'N/D'}</span>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                        <span
                          style={{
                            fontSize: '0.75rem', fontWeight: 650, padding: '4px 10px', borderRadius: 999,
                            background: n.days_left <= 7 ? 'rgba(239, 68, 68, 0.12)' : (n.days_left <= 30 ? 'rgba(245, 158, 11, 0.12)' : 'var(--bg-tertiary)'),
                            color: n.days_left <= 7 ? 'var(--danger, #ef4444)' : (n.days_left <= 30 ? '#d97706' : 'var(--text-secondary)'),
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {n.days_left <= 0 ? 'Eliminazione oggi' : `Tra ${n.days_left} giorni`}
                        </span>

                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleRestoreNote(n)}
                          title="Ripristina Nota"
                          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', padding: '6px 12px' }}
                        >
                          <AppIcon name="undo" size={14} />
                          Ripristina
                        </button>

                        <button
                          className="btn btn-icon btn-sm"
                          onClick={() => handleHardDeleteNote(n)}
                          title="Elimina definitivamente"
                          style={{ color: 'var(--danger, #ef4444)', borderColor: 'rgba(239, 68, 68, 0.3)' }}
                        >
                          <AppIcon name="trash" size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
