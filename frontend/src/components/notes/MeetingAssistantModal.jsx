import { useState, useEffect, useRef } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import AppIcon from '../ui/AppIcon';
import { isSpeechRecognitionSupported, SpeechTranscriber } from '../../utils/speechRecognition';
import { MixedAudioRecorder } from '../../utils/audioCapture';
import {
  Mic,
  Monitor,
  Pause,
  Play,
  Square,
  Sparkles,
  Copy,
  FilePlus,
  ArrowLeft,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Headphones
} from 'lucide-react';
import { isSafariBrowser } from '../../utils/audioCapture';
import './MeetingAssistantModal.css';

export default function MeetingAssistantModal({
  isOpen,
  onClose,
  activeNote,
  hasActiveNote,
  onInsertIntoActiveNote,
  onCreateNewNote
}) {
  const toast = useToast();
  const isSafari = isSafariBrowser();

  // Modal Settings
  const [meetingTitle, setMeetingTitle] = useState('');
  const [meetingType, setMeetingType] = useState('operativa');

  // Modalità: 'mixed' (Microfono + Audio PC) oppure 'mic' (Solo Microfono)
  const [audioMode, setAudioMode] = useState('mixed');

  // Audio / Speech State
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [interimText, setInterimText] = useState('');

  // Volume Levels & System Audio state
  const [micVolume, setMicVolume] = useState(0);
  const [sysVolume, setSysVolume] = useState(0);
  const [hasSystemAudio, setHasSystemAudio] = useState(true);
  const [recordedAudioBlob, setRecordedAudioBlob] = useState(null);

  // Loading States
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedMinutes, setGeneratedMinutes] = useState(null);

  // References
  const transcriberRef = useRef(null);
  const mixedRecorderRef = useRef(null);
  const timerRef = useRef(null);
  const textareaRef = useRef(null);

  const canInsert = hasActiveNote || !!activeNote;

  // Format seconds to mm:ss or hh:mm:ss
  function formatTime(totalSec) {
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (hrs > 0) {
      return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
    }
    return `${pad(mins)}:${pad(secs)}`;
  }

  // Reset when modal opens/closes
  useEffect(() => {
    if (!isOpen) {
      cleanupAllRecorders();
      return;
    }

    // Reset stati
    setMeetingTitle('');
    setTranscript('');
    setInterimText('');
    setSeconds(0);
    setIsRecording(false);
    setIsPaused(false);
    setRecordedAudioBlob(null);
    setGeneratedMinutes(null);
    setMicVolume(0);
    setSysVolume(0);
    setHasSystemAudio(true);

    return () => {
      cleanupAllRecorders();
    };
  }, [isOpen]);

  // Gestione Timer
  useEffect(() => {
    if (isRecording && !isPaused) {
      timerRef.current = setInterval(() => {
        setSeconds(s => s + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isRecording, isPaused]);

  // Auto-scroll textarea quando la trascrizione cresce
  useEffect(() => {
    if (textareaRef.current && isRecording) {
      textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
    }
  }, [transcript, interimText, isRecording]);

  function cleanupAllRecorders() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (transcriberRef.current) {
      try { transcriberRef.current.stop(); } catch (e) { /* ignore */ }
      transcriberRef.current = null;
    }
    if (mixedRecorderRef.current) {
      try { mixedRecorderRef.current.cleanup(); } catch (e) { /* ignore */ }
      mixedRecorderRef.current = null;
    }
  }

  // AVVIO REGISTRAZIONE
  const handleStartRecording = async () => {
    try {
      if (audioMode === 'mixed') {
        // Modalità: Microfono + Audio PC (Videochiamate, Google Meet, Teams, Zoom, YouTube)
        const recorder = new MixedAudioRecorder({
          onVolumeChange: ({ micLevel, sysLevel, hasSystemAudio: sysActive }) => {
            setMicVolume(micLevel);
            setSysVolume(sysLevel);
            setHasSystemAudio(sysActive);
          },
          onSystemAudioEnded: () => {
            toast.info("La condivisione dell'audio PC è terminata.");
            setHasSystemAudio(false);
          }
        });

        mixedRecorderRef.current = recorder;
        const res = await recorder.start({ includeMic: true, includeSystem: true });

        if (!res.hasSystemAudio) {
          setHasSystemAudio(false);
          toast.success("Registrazione Microfono + Audio PC avviata!");
        } else {
          setHasSystemAudio(true);
          toast.success("Registrazione Microfono + Audio PC avviata!");
        }

        // Live speech recognition per anteprima in tempo reale
        if (isSpeechRecognitionSupported()) {
          const transcriber = new SpeechTranscriber({
            lang: 'it-IT',
            onInterim: (text) => setInterimText(text),
            onFinal: (fullText) => {
              setTranscript(prev => (prev ? prev + ' ' + fullText : fullText));
              setInterimText('');
            }
          });
          transcriberRef.current = transcriber;
          transcriber.start();
        }

        setIsRecording(true);
        setIsPaused(false);

      } else {
        // Modalità: Solo Microfono
        const recorder = new MixedAudioRecorder({
          onVolumeChange: ({ micLevel }) => {
            setMicVolume(micLevel);
            setSysVolume(0);
          }
        });

        mixedRecorderRef.current = recorder;
        await recorder.start({ includeMic: true, includeSystem: false });

        if (isSpeechRecognitionSupported()) {
          const transcriber = new SpeechTranscriber({
            lang: 'it-IT',
            onInterim: (text) => setInterimText(text),
            onFinal: (fullText) => {
              setTranscript(prev => (prev ? prev + ' ' + fullText : fullText));
              setInterimText('');
            }
          });
          transcriberRef.current = transcriber;
          transcriber.start();
        }

        setIsRecording(true);
        setIsPaused(false);
        toast.success("Registrazione Microfono avviata!");
      }
    } catch (err) {
      if (err?.isCancelled) {
        toast.info("Condivisione annullata.");
        cleanupAllRecorders();
        setIsRecording(false);
        return;
      }
      console.error("Errore avvio registrazione:", err);
      toast.error(err.message || "Impossibile avviare la registrazione.");
      cleanupAllRecorders();
      setIsRecording(false);
    }
  };

  const handlePauseRecording = () => {
    if (mixedRecorderRef.current) {
      if (isPaused) {
        mixedRecorderRef.current.resume();
        if (transcriberRef.current) transcriberRef.current.resume();
        setIsPaused(false);
      } else {
        mixedRecorderRef.current.pause();
        if (transcriberRef.current) transcriberRef.current.pause();
        setIsPaused(true);
      }
    }
  };

  // Trascrizione Audio tramite Groq Whisper
  const handleTranscribeAudio = async (audioBlob) => {
    const fileToUpload = audioBlob || recordedAudioBlob;
    if (!fileToUpload) return null;

    setIsTranscribing(true);
    const formData = new FormData();
    const fileName = `meeting_${Date.now()}.webm`;
    formData.append('file', fileToUpload, fileName);
    formData.append('language', 'it');
    formData.append('include_timestamps', 'true');

    try {
      const { data } = await api.post('/notes/transcribe-audio', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });

      if (data.transcript) {
        setTranscript(data.transcript);
        toast.success("Audio trascritto con successo tramite AI!");
        return data.transcript;
      } else {
        toast.warning("Nessun parlato rilevato nell'audio.");
        return null;
      }
    } catch (err) {
      console.error("Errore trascrizione audio:", err);
      toast.error(err.response?.data?.detail || "Errore durante la trascrizione audio.");
      return null;
    } finally {
      setIsTranscribing(false);
    }
  };

  const handleStopRecording = async () => {
    if (mixedRecorderRef.current) {
      try {
        const { blob } = await mixedRecorderRef.current.stop();
        setRecordedAudioBlob(blob);
        if (transcriberRef.current) {
          transcriberRef.current.stop();
          transcriberRef.current = null;
        }
        setIsRecording(false);
        setIsPaused(false);

        // Trascrivi automaticamente subito dopo lo stop!
        if (blob) {
          await handleTranscribeAudio(blob);
        }
        return blob;
      } catch (err) {
        console.error("Errore stop registrazione:", err);
      }
    }
    return null;
  };

  // Generazione Minuta AI
  const handleGenerateMinutes = async () => {
    let currentText = (transcript + (interimText ? ' ' + interimText : '')).trim();

    if (isRecording) {
      const blob = await handleStopRecording();
      if (blob) {
        const transcribed = await handleTranscribeAudio(blob);
        if (transcribed) {
          currentText = transcribed.trim();
        }
      }
    } else if (recordedAudioBlob && (!currentText || currentText.length < 15)) {
      const transcribed = await handleTranscribeAudio(recordedAudioBlob);
      if (transcribed) {
        currentText = transcribed.trim();
      }
    }

    if (!currentText || currentText.length < 15) {
      toast.warning('Testo insufficiente per generare una minuta. Assicurati che vi sia del parlato registrato.');
      return;
    }

    setIsGenerating(true);

    try {
      const { data } = await api.post('/notes/meeting-minutes', {
        transcript: currentText,
        meeting_type: meetingType,
        context_title: meetingTitle || undefined
      });

      setGeneratedMinutes(data);
      toast.success('Minuta AI generata con successo!');
    } catch (err) {
      console.error('Errore generazione minuta AI:', err);
      toast.error(err.response?.data?.detail || 'Errore nella generazione della minuta AI.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopyMinutes = () => {
    if (!generatedMinutes) return;
    const textToCopy = generatedMinutes.summary_markdown || generatedMinutes.title;
    navigator.clipboard.writeText(textToCopy);
    toast.success('Minuta copiata negli appunti!');
  };

  const handleInsertActive = () => {
    if (!generatedMinutes?.summary_html) return;
    if (typeof onInsertIntoActiveNote === 'function') {
      onInsertIntoActiveNote(generatedMinutes.summary_html, generatedMinutes.title);
      onClose();
    }
  };

  const handleCreateNew = () => {
    if (!generatedMinutes) return;
    if (typeof onCreateNewNote === 'function') {
      onCreateNewNote(generatedMinutes);
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="meeting-modal-overlay" onClick={onClose}>
      <div className="meeting-modal-container" onClick={(e) => e.stopPropagation()}>

        {/* HEADER */}
        <div className="meeting-modal-header">
          <div className="meeting-header-left">
            <span className="meeting-icon-badge">
              <Sparkles size={22} />
            </span>
            <div>
              <h3 className="meeting-modal-title">
                Assistente Riunioni & Minuta AI
              </h3>
              <p className="meeting-modal-subtitle">
                Registrazione del parlato, trascrizione automatica e generazione sintesi con intelligenza artificiale
              </p>
            </div>
          </div>
          <button className="meeting-close-btn" onClick={onClose} title="Chiudi finestra">
            <AppIcon name="close" size={20} />
          </button>
        </div>

        {/* SELECTOR MODALITÀ (2 sole opzioni) */}
        {!generatedMinutes && (
          <>
            <div className="meeting-source-tabs">
              <button
                type="button"
                className={`meeting-tab-btn ${audioMode === 'mic' ? 'active' : ''}`}
                onClick={() => { if (!isRecording) setAudioMode('mic'); }}
                disabled={isRecording}
                title="Registra solo la voce dal microfono (riunioni in presenza o dettatura)"
              >
                <Mic size={16} />
                <span>Microfono</span>
              </button>

              <button
                type="button"
                className={`meeting-tab-btn ${audioMode === 'mixed' ? 'active' : ''}`}
                onClick={() => { if (!isRecording) setAudioMode('mixed'); }}
                disabled={isRecording}
                title="Registra contemporaneamente la tua voce e l'audio del computer (Google Meet, Teams, Zoom, YouTube)"
              >
                <Monitor size={16} />
                <span>Microfono + Audio PC</span>
              </button>
            </div>

            {isSafari && audioMode === 'mixed' && !isRecording && (
              <div className="meeting-safari-audio-tip">
                <Headphones size={15} style={{ flexShrink: 0, marginTop: 1, color: '#4f46e5' }} />
                <span>
                  <strong>Uso con Cuffie vs Altoparlanti:</strong> Con <strong>Google Chrome</strong> (già presente sul tuo Mac) puoi catturare l'audio digitale limpido della scheda (YouTube/Meet) direttamente anche con le cuffie collegate o a volume zero. Su <strong>Safari</strong> l'audio del computer deve essere emesso dagli altoparlanti del Mac.
                </span>
              </div>
            )}
          </>
        )}



        {/* MODAL BODY */}
        <div className="meeting-modal-body">
          {!generatedMinutes ? (
            <>
              {/* GUIDA SNELLA & INDICATORI LIVE VU METER */}
              <div className="meeting-instruction-card">
                <div className="instruction-header">
                  {audioMode === 'mixed' ? <Monitor size={16} /> : <Mic size={16} />}
                  <strong>
                    {audioMode === 'mixed'
                      ? 'Modalità Microfono + Audio PC (Videochiamate):'
                      : 'Modalità Microfono (Riunioni in presenza):'}
                  </strong>
                </div>
                <p className="instruction-text">
                  {audioMode === 'mixed'
                    ? "Il sistema acquisisce simultaneamente la tua voce e l'audio riprodotto dal computer (videochiamate, YouTube o altoparlanti). Al termine, l'intera conversazione viene trascritta ed elaborata con l'AI."
                    : "Il sistema registra direttamente la tua voce tramite il microfono del computer o auricolari, per appunti personali o riunioni dal vivo."}
                </p>

                {isRecording && (
                  <div className="meeting-vu-container">
                    <div className="vu-meter-group">
                      <div className="vu-label">
                        <Mic size={13} />
                        <span>Livello Microfono:</span>
                      </div>
                      <div className="vu-track">
                        <div className="vu-bar vu-bar--mic" style={{ width: `${Math.max(6, micVolume)}%` }} />
                      </div>
                    </div>

                    {audioMode === 'mixed' && (
                      <div className="vu-meter-group">
                        <div className="vu-label">
                          <Monitor size={13} />
                          <span>Livello Audio PC:</span>
                        </div>
                        <div className="vu-track">
                          <div
                            className="vu-bar vu-bar--sys"
                            style={{ width: `${Math.max(6, sysVolume)}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Titolo Riunione Opzionale */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                  Oggetto / Titolo Riunione (Opzionale)
                </label>
                <input
                  type="text"
                  className="meeting-title-input"
                  placeholder="Titolo riunione"
                  value={meetingTitle}
                  onChange={(e) => setMeetingTitle(e.target.value)}
                />
              </div>

              {/* Trascrizione Ampia a tutta pagina */}
              <div className="meeting-transcript-section">
                <div className="meeting-transcript-label">
                  <span>Trascrizione Conversazione</span>
                  <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)', textTransform: 'none', fontWeight: 400 }}>
                    Puoi modificare o aggiungere testo liberamente in qualsiasi momento
                  </span>
                </div>

                {isRecording && (
                  <div className="meeting-recording-live-banner">
                    <div className="meeting-sound-wave">
                      <span /><span /><span /><span /><span />
                    </div>
                    <span>
                      Registrazione in corso. L'audio viene acquisito ad alta fedeltà. Clicca <strong>"Termina Registrazione"</strong> o <strong>"Genera Minuta AI"</strong> per trascriverlo automaticamente con AI.
                    </span>
                  </div>
                )}

                {isTranscribing && (
                  <div className="meeting-transcribing-banner">
                    <Sparkles size={16} className="spin-icon" />
                    <span>Trascrizione audio in corso con AI...</span>
                  </div>
                )}

                <textarea
                  ref={textareaRef}
                  className="meeting-transcript-box"
                  placeholder={
                    audioMode === 'mixed'
                      ? 'Premi "Avvia Registrazione". Quanto detto da te e dai partecipanti durante la videochiamata o dal video verrà registrato e trascritto automaticamente...'
                      : 'Premi "Avvia Registrazione" e parla al microfono. Il parlato apparirà qui in tempo reale...'
                  }
                  value={transcript}
                  onChange={(e) => setTranscript(e.target.value)}
                />

                {interimText && (
                  <div className="meeting-interim-preview">
                    <span>{interimText}</span>
                  </div>
                )}
              </div>
            </>
          ) : (
            /* RISULTATO: ANTEPRIMA MINUTA AI GENERATA */
            <div className="meeting-result-view">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h4 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {generatedMinutes.title}
                </h4>
                <span className="badge badge-success" style={{ fontSize: '0.8rem', padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <CheckCircle2 size={14} /> Minuta Pronta
                </span>
              </div>

              <div
                className="meeting-result-preview"
                dangerouslySetInnerHTML={{ __html: generatedMinutes.summary_html }}
              />
            </div>
          )}
        </div>

        {/* FOOTER ACTIONS */}
        <div className="meeting-modal-footer">
          {!generatedMinutes ? (
            <>
              <div className="meeting-footer-left">
                {!isRecording ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm btn-rec-start"
                    disabled={isTranscribing}
                    onClick={handleStartRecording}
                  >
                    <Play size={15} />
                    <span>
                      {audioMode === 'mixed' ? 'Avvia Registrazione (Mic + Audio PC)' : 'Avvia Registrazione Microfono'}
                    </span>
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={handlePauseRecording}
                    >
                      {isPaused ? <Play size={14} /> : <Pause size={14} />}
                      <span>{isPaused ? 'Riprendi' : 'Pausa'}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={handleStopRecording}
                    >
                      <Square size={14} />
                      <span>Termina Registrazione</span>
                    </button>
                    <div className="meeting-timer" style={{ marginLeft: 6 }}>{formatTime(seconds)}</div>
                  </>
                )}

                {/* RESET BUTTON */}
                {(transcript || seconds > 0 || recordedAudioBlob) && !isRecording && !isTranscribing && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      if (window.confirm('Cancellare la registrazione e trascrizione corrente?')) {
                        setTranscript('');
                        setInterimText('');
                        setSeconds(0);
                        setRecordedAudioBlob(null);
                        if (transcriberRef.current) transcriberRef.current.reset();
                      }
                    }}
                  >
                    <RotateCcw size={14} /> Reset
                  </button>
                )}
              </div>

              <div className="meeting-footer-right">
                <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={isTranscribing || isGenerating}>
                  Annulla
                </button>
                <button
                  type="button"
                  className="btn btn-meeting-ai"
                  disabled={
                    isGenerating ||
                    isTranscribing ||
                    (!transcript && !recordedAudioBlob && !isRecording)
                  }
                  onClick={handleGenerateMinutes}
                >
                  <Sparkles size={16} />
                  <span>
                    {isGenerating
                      ? 'Generazione Minuta AI...'
                      : isTranscribing
                        ? 'Trascrizione in corso...'
                        : 'Genera Minuta AI'}
                  </span>
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="meeting-footer-left">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setGeneratedMinutes(null)}
                >
                  <ArrowLeft size={14} /> Modifica Trascrizione
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleCopyMinutes}
                >
                  <Copy size={14} /> Copia Minuta
                </button>
              </div>

              <div className="meeting-footer-right">
                {canInsert && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={handleInsertActive}
                  >
                    Inserisci nella Nota Attiva
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={handleCreateNew}
                >
                  <FilePlus size={15} /> Crea Nuova Nota Riunione
                </button>
              </div>
            </>
          )}
        </div>

      </div>
    </div>
  );
}
