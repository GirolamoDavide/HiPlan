import { useEffect, useState, useRef } from 'react';
import { useToast } from '../context/ToastContext';

export default function useWebSocket(url, onMessage) {
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef(null);
  const toast = useToast();
  const onMessageRef = useRef(onMessage);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (!url) return;
    
    let isUnmounted = false;
    let reconnectTimeout = null;

    const connect = () => {
      if (isUnmounted) return;
      
      // Il token viene riletto a ogni (ri)connessione, così dopo un refresh si usa quello aggiornato
      let token = '';
      try { token = localStorage.getItem('access_token') || ''; } catch { }
      const ws = new WebSocket(`${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`);

      ws.onopen = () => {
        if (!isUnmounted) setIsConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (onMessageRef.current) {
            onMessageRef.current(data);
          }
        } catch (error) {
          console.error("Errore nel parsing del messaggio WebSocket", error);
        }
      };

      ws.onerror = (error) => {
        if (!isUnmounted) console.error("WebSocket error", error);
      };

      ws.onclose = () => {
        if (!isUnmounted) {
          setIsConnected(false);
          // Ritenta la connessione dopo 3 secondi
          reconnectTimeout = setTimeout(connect, 3000);
        }
      };

      wsRef.current = ws;
    };

    connect();

    return () => {
      isUnmounted = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (wsRef.current) {
        const ws = wsRef.current;
        ws.onclose = null;
        ws.onerror = null;
        if (ws.readyState === WebSocket.CONNECTING) {
           ws.onopen = () => ws.close();
        } else {
           ws.close();
        }
      }
    };
  }, [url]);

  return { isConnected };
}
