/**
 * Gestione della cattura audio multi-sorgente:
 * - Microfono locale (la tua voce)
 * - Audio di sistema / scheda (voci dei colleghi e partecipanti su Google Meet, Microsoft Teams, Zoom)
 * - Miscelazione in tempo reale tramite Web Audio API (AudioContext)
 * - Monitoraggio dei livelli audio (VU meter)
 * - Registrazione compressa con MediaRecorder per trascrizione Groq Whisper
 */

export function isAudioCaptureSupported() {
  return typeof window !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function';
}

export function isDisplayAudioSupported() {
  return typeof window !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === 'function';
}

export function isSafariBrowser() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes('safari') && !ua.includes('chrome') && !ua.includes('chromium') && !ua.includes('edg') && !ua.includes('firefox');
}

function getSupportedMimeType() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4'
  ];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }
  return '';
}

export class MixedAudioRecorder {
  constructor(options = {}) {
    this.options = options;
    this.audioCtx = null;
    this.destination = null;
    this.mediaRecorder = null;
    this.micStream = null;
    this.displayStream = null;
    this.chunks = [];
    this.startTime = null;
    this.hasSystemAudio = false;
    this.volumeInterval = null;
    this.onVolumeChange = options.onVolumeChange || null;
    this.onSystemAudioEnded = options.onSystemAudioEnded || null;
  }

  async start({ includeMic = true, includeSystem = true, disableEchoCancellation = false }) {
    this.chunks = [];
    this.hasSystemAudio = false;

    // Se il browser è Safari o non supporta la cattura audio da displayMedia,
    // evitiamo getDisplayMedia (che chiederebbe la condivisione dello schermo senza fornire alcuna traccia audio)
    const isSafari = isSafariBrowser();
    const canAttemptDisplayAudio = includeSystem && !isSafari && isDisplayAudioSupported();

    if (canAttemptDisplayAudio) {
      try {
        try {
          this.displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
            systemAudio: 'include',
            surfaceSwitching: 'include'
          });
        } catch (specErr) {
          if (specErr.name === 'NotAllowedError' || specErr.name === 'PermissionDeniedError' || specErr.name === 'AbortError') {
            console.log("Condivisione scheda non avviata, fallback su microfono ad alta sensibilità per altoparlanti");
          } else {
            try {
              this.displayStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true
              });
            } catch (e) {
              console.log("Fallback displayMedia non riuscito:", e);
            }
          }
        }

        if (this.displayStream) {
          const tracks = this.displayStream.getAudioTracks();
          this.hasSystemAudio = tracks.length > 0;
          // Disabilita i frame video per risparmiare risorse CPU/GPU mantenendo attivo l'audio digitale
          this.displayStream.getVideoTracks().forEach(t => { t.enabled = false; });
        }
      } catch (err) {
        console.warn("getDisplayMedia non disponibile, fallback su microfono altoparlanti:", err);
      }
    }

    // 2. Cattura microfono locale
    // Se non abbiamo audio diretto di sistema (es. Safari, o altoparlanti esterni), DISABILITIAMO l'echoCancellation
    // in modo che il microfono possa captare le voci dei partecipanti che escono dagli altoparlanti del computer!
    if (includeMic) {
      const shouldDisableEcho = disableEchoCancellation || (includeSystem && !this.hasSystemAudio);

      const micConstraints = {
        audio: {
          echoCancellation: !shouldDisableEcho,
          noiseSuppression: !shouldDisableEcho,
          autoGainControl: true
        },
        video: false
      };

      try {
        this.micStream = await navigator.mediaDevices.getUserMedia(micConstraints);
      } catch (err) {
        console.warn("Impossibile accedere al microfono con vincoli personalizzati, riprovo con audio base:", err);
        try {
          this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        } catch (fallbackErr) {
          if (!includeSystem || !this.displayStream) {
            this.cleanup();
            throw new Error("Accesso al microfono rifiutato o non disponibile: " + (fallbackErr.message || fallbackErr.name));
          }
        }
      }
    }

    // 3. Inizializzazione Web Audio API e miscelazione flussi
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      this.cleanup();
      throw new Error("Il tuo browser non supporta la Web Audio API necessaria per combinare l'audio.");
    }

    this.audioCtx = new AudioContextClass();
    if (this.audioCtx.state === 'suspended') {
      try {
        await this.audioCtx.resume();
      } catch (e) {
        // ignore
      }
    }
    this.destination = this.audioCtx.createMediaStreamDestination();

    let micAnalyser = null;
    let sysAnalyser = null;

    if (this.micStream) {
      const micSource = this.audioCtx.createMediaStreamSource(this.micStream);
      micAnalyser = this.audioCtx.createAnalyser();
      micAnalyser.fftSize = 64;
      micSource.connect(micAnalyser);
      micSource.connect(this.destination);
    }

    if (this.displayStream) {
      const audioTracks = this.displayStream.getAudioTracks();
      if (audioTracks.length > 0) {
        this.hasSystemAudio = true;
        const sysSource = this.audioCtx.createMediaStreamSource(this.displayStream);
        sysAnalyser = this.audioCtx.createAnalyser();
        sysAnalyser.fftSize = 64;
        sysSource.connect(sysAnalyser);
        sysSource.connect(this.destination);

        // Se l'utente interrompe la condivisione dello schermo/scheda dal banner nativo del browser
        audioTracks[0].addEventListener('ended', () => {
          this.hasSystemAudio = false;
          if (typeof this.onSystemAudioEnded === 'function') {
            this.onSystemAudioEnded();
          }
        });
      } else {
        this.hasSystemAudio = false;
      }
    }


    // Verifica che almeno un flusso sia connesso
    const mixedTracks = this.destination.stream.getAudioTracks();
    if (mixedTracks.length === 0) {
      this.cleanup();
      throw new Error("Nessuna sorgente audio attiva trovata (né microfono né audio PC).");
    }

    // 3. Monitoraggio livelli di volume per l'equalizzatore grafico
    if (this.onVolumeChange && (micAnalyser || sysAnalyser)) {
      const micData = micAnalyser ? new Uint8Array(micAnalyser.frequencyBinCount) : null;
      const sysData = sysAnalyser ? new Uint8Array(sysAnalyser.frequencyBinCount) : null;

      this.volumeInterval = setInterval(() => {
        let micLevel = 0;
        let sysLevel = 0;

        if (micAnalyser && micData) {
          micAnalyser.getByteFrequencyData(micData);
          let sum = 0;
          for (let i = 0; i < micData.length; i++) sum += micData[i];
          micLevel = Math.min(100, Math.round((sum / micData.length / 128) * 100));
        }

        if (sysAnalyser && sysData) {
          sysAnalyser.getByteFrequencyData(sysData);
          let sum = 0;
          for (let i = 0; i < sysData.length; i++) sum += sysData[i];
          sysLevel = Math.min(100, Math.round((sum / sysData.length / 128) * 100));
        } else if (includeSystem) {
          // Quando l'audio PC è captato a viva voce dagli altoparlanti,
          // applichiamo un boost di sensibilità dinamico (x2.5) per rappresentare fedelmente il suono percepito
          sysLevel = Math.min(100, Math.round(micLevel * 2.5));
        }

        this.onVolumeChange({ micLevel, sysLevel, hasSystemAudio: this.hasSystemAudio });
      }, 100);
    }

    // 4. Avvio MediaRecorder sul flusso miscelato
    const mimeType = getSupportedMimeType();
    const recorderOptions = mimeType ? { mimeType } : {};
    this.mediaRecorder = new MediaRecorder(this.destination.stream, recorderOptions);

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };

    this.startTime = Date.now();
    this.mediaRecorder.start(1000); // chunk ogni 1 secondo

    return {
      hasSystemAudio: this.hasSystemAudio,
      mimeType: this.mediaRecorder.mimeType || mimeType || 'audio/webm'
    };
  }

  pause() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.pause();
    }
  }

  resume() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'paused') {
      this.mediaRecorder.resume();
    }
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        const result = this._finalize();
        resolve(result);
        return;
      }

      this.mediaRecorder.onstop = () => {
        const result = this._finalize();
        resolve(result);
      };

      try {
        this.mediaRecorder.stop();
      } catch (e) {
        console.warn("Errore stop mediaRecorder:", e);
        resolve(this._finalize());
      }
    });
  }

  _finalize() {
    if (this.volumeInterval) {
      clearInterval(this.volumeInterval);
      this.volumeInterval = null;
    }

    const durationSeconds = this.startTime ? Math.round((Date.now() - this.startTime) / 1000) : 0;
    const mimeType = this.mediaRecorder ? this.mediaRecorder.mimeType || 'audio/webm' : 'audio/webm';
    const blob = new Blob(this.chunks, { type: mimeType });

    this.cleanup();

    return {
      blob,
      durationSeconds,
      hasSystemAudio: this.hasSystemAudio,
      mimeType
    };
  }

  cleanup() {
    if (this.volumeInterval) {
      clearInterval(this.volumeInterval);
      this.volumeInterval = null;
    }

    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }

    if (this.displayStream) {
      this.displayStream.getTracks().forEach((track) => track.stop());
      this.displayStream = null;
    }

    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      try {
        this.audioCtx.close();
      } catch (e) {
        // ignore
      }
      this.audioCtx = null;
    }
  }
}
