import { useEffect, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';

/**
 * Live updates: the server pushes a topic list whenever data changes and
 * every device refreshes the affected screens. Falls back to polling-by-focus
 * if the stream drops, and reports connection state for the status dot.
 */
type ConnState = 'connecting' | 'live' | 'offline';
let state: ConnState = 'connecting';
const listeners = new Set<(s: ConnState) => void>();
const setState = (s: ConnState) => {
  state = s;
  listeners.forEach((l) => l(s));
};

const TOPIC_KEYS: Record<string, string[][]> = {
  orders: [['orders'], ['order'], ['dashboard'], ['cutting'], ['packing'], ['fulfilment'], ['customer'], ['reports']],
  exceptions: [['exceptions'], ['dashboard'], ['order'], ['intelligence']],
  customers: [['customers'], ['customer']],
  products: [['products'], ['catalogue']],
  imports: [['imports'], ['import']],
  settings: [['settings'], ['me']],
  intelligence: [['intelligence']],
};

export function startRealtime(qc: QueryClient): () => void {
  let es: EventSource | null = null;
  let retry = 1000;
  let stopped = false;
  let timer: number | undefined;
  const connect = () => {
    if (stopped) return;
    setState('connecting');
    es = new EventSource('/api/events');
    es.addEventListener('hello', () => {
      setState('live');
      retry = 1000;
      qc.invalidateQueries(); // catch up on anything missed while disconnected
    });
    es.addEventListener('change', (ev) => {
      try {
        const e = JSON.parse((ev as MessageEvent).data) as { topics: string[] };
        const keys = new Set<string>();
        for (const t of e.topics) for (const k of TOPIC_KEYS[t] ?? []) keys.add(JSON.stringify(k));
        for (const k of keys) qc.invalidateQueries({ queryKey: JSON.parse(k) });
      } catch {
        /* ignore malformed */
      }
    });
    es.onerror = () => {
      es?.close();
      setState(navigator.onLine ? 'connecting' : 'offline');
      timer = window.setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30_000);
    };
  };
  const online = () => {
    retry = 1000;
    window.clearTimeout(timer);
    es?.close();
    connect();
  };
  const offline = () => setState('offline');
  window.addEventListener('online', online);
  window.addEventListener('offline', offline);
  connect();
  return () => {
    stopped = true;
    es?.close();
    window.clearTimeout(timer);
    window.removeEventListener('online', online);
    window.removeEventListener('offline', offline);
  };
}

export function useConnection(): ConnState {
  const [s, set] = useState(state);
  useEffect(() => {
    listeners.add(set);
    return () => void listeners.delete(set);
  }, []);
  return s;
}

export function useOnline(): boolean {
  const [on, setOn] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const a = () => setOn(true);
    const b = () => setOn(false);
    window.addEventListener('online', a);
    window.addEventListener('offline', b);
    return () => {
      window.removeEventListener('online', a);
      window.removeEventListener('offline', b);
    };
  }, []);
  return on;
}
