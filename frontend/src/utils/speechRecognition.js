/**
 * Utility per il riconoscimento vocale streaming tramite Web Speech API nativa.
 * Supporta Chrome, Edge, Safari e browser Chromium.
 */

export function isSpeechRecognitionSupported() {
  return typeof window !== 'undefined' && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window);
}

export class SpeechTranscriber {
  constructor(options = {}) {
    this.lang = options.lang || 'it-IT';
    this.continuous = options.continuous !== false;
    this.interimResults = options.interimResults !== false;

    this.recognition = null;
    this.isListening = false;
    this.isPaused = false;
    this.finalTranscript = '';
    
    // Callbacks
    this.onInterim = options.onInterim || (() => {});
    this.onFinal = options.onFinal || (() => {});
    this.onResult = options.onResult || (() => {});
    this.onStateChange = options.onStateChange || (() => {});
    this.onError = options.onError || (() => {});
    this.onEnd = options.onEnd || (() => {});
  }

  start() {
    if (!isSpeechRecognitionSupported()) {
      const err = new Error('Il tuo browser non supporta il riconoscimento vocale Web Speech API. Usa Google Chrome, Microsoft Edge o Safari.');
      this.onError(err);
      return false;
    }

    if (this.isListening) return true;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRecognition();
    this.recognition.lang = this.lang;
    this.recognition.continuous = this.continuous;
    this.recognition.interimResults = this.interimResults;
    this.recognition.maxAlternatives = 1;

    this.isListening = true;
    this.isPaused = false;
    this.lastFinalizedIndex = -1;
    this.onStateChange({ isListening: true, isPaused: false });

    return this._initRecognition();
  }

  _initRecognition() {
    if (!isSpeechRecognitionSupported()) return false;
    
    // Ferma eventuale istanza precedente
    if (this.recognition) {
      try {
        this.recognition.onresult = null;
        this.recognition.onerror = null;
        this.recognition.onend = null;
        this.recognition.stop();
      } catch {}
      this.recognition = null;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRecognition();
    this.recognition.lang = this.lang;
    this.recognition.continuous = this.continuous;
    this.recognition.interimResults = this.interimResults;
    this.recognition.maxAlternatives = 1;
    this.lastFinalizedIndex = -1;

    this.recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const result = event.results[i];
        if (!result) continue;
        const text = result[0]?.transcript || '';
        const isFinal = Boolean(result.isFinal || !this.interimResults);

        if (isFinal) {
          if (i > this.lastFinalizedIndex) {
            this.lastFinalizedIndex = i;
            const chunk = text.trim();
            if (chunk) {
              this.finalTranscript += (this.finalTranscript ? ' ' : '') + chunk;
              this.onFinal(this.finalTranscript, chunk);
              this.onResult({
                transcript: chunk,
                fullTranscript: this.finalTranscript,
                isFinal: true
              });
            }
          }
        } else {
          interim += text;
        }
      }

      if (interim) {
        this.onInterim(interim);
        this.onResult({
          transcript: interim.trim(),
          fullTranscript: this.finalTranscript,
          interim: interim,
          isFinal: false
        });
      }
    };

    this.recognition.onerror = (event) => {
      const errCode = event?.error || 'unknown';
      // 'no-speech' e 'aborted' sono normali durante le pause silenziose
      if (errCode === 'no-speech' || errCode === 'aborted') {
        return;
      }
      console.warn('Speech recognition warning/error:', errCode);
      if (errCode === 'not-allowed' || errCode === 'audio-capture') {
        this.isListening = false;
        this.onStateChange({ isListening: false, isPaused: false });
        this.onError(errCode);
      }
    };

    this.recognition.onend = () => {
      // Se l'utente non ha premuto stop o pausa, riavviamo con una nuova istanza pulita
      // per superare il limite di silenzio (10s) di Google Chrome
      if (this.isListening && !this.isPaused) {
        try {
          this._initRecognition();
        } catch (e) {
          console.warn('SpeechRecognition restart error:', e);
        }
      } else if (!this.isPaused) {
        this.isListening = false;
        this.onStateChange({ isListening: false, isPaused: false });
        this.onEnd();
      }
    };

    try {
      this.recognition.start();
      return true;
    } catch (e) {
      console.warn('SpeechRecognition start error:', e);
      return false;
    }
  }

  pause() {
    if (!this.isListening || this.isPaused) return;
    this.isPaused = true;
    this.onStateChange({ isListening: true, isPaused: true });
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {}
    }
  }

  resume() {
    if (!this.isListening || !this.isPaused) return;
    this.isPaused = false;
    this.onStateChange({ isListening: true, isPaused: false });
    if (this.recognition) {
      try {
        this.recognition.start();
      } catch {}
    }
  }

  stop() {
    this.isListening = false;
    this.isPaused = false;
    this.onStateChange({ isListening: false, isPaused: false });
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {}
      this.recognition = null;
    }
    return this.finalTranscript;
  }

  reset() {
    this.finalTranscript = '';
  }
}
