/**
 * In-process change bus. Every committed change publishes a topic; connected
 * devices receive it over Server-Sent Events and refresh what they show.
 * (Single-process deployment. For multiple instances, back this with Redis/Postgres NOTIFY.)
 */
export type Topic = 'orders' | 'exceptions' | 'customers' | 'products' | 'imports' | 'settings' | 'intelligence' | 'stock';

export interface ChangeEvent {
  topics: Topic[];
  orderId?: string;
  summary?: string;
  at: string;
}

type Listener = (e: ChangeEvent) => void;
const listeners = new Set<Listener>();
let pending: { topics: Set<Topic>; orderIds: Set<string>; summary?: string } | null = null;

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Coalesces bursts (e.g. a 50-order import) into one event per tick. */
export function publish(topics: Topic[], opts: { orderId?: string; summary?: string } = {}) {
  if (!pending) {
    pending = { topics: new Set(), orderIds: new Set() };
    setTimeout(flush, 30);
  }
  topics.forEach((t) => pending!.topics.add(t));
  if (opts.orderId) pending.orderIds.add(opts.orderId);
  if (opts.summary) pending.summary = opts.summary;
}

function flush() {
  if (!pending) return;
  const p = pending;
  pending = null;
  const e: ChangeEvent = {
    topics: [...p.topics],
    orderId: p.orderIds.size === 1 ? [...p.orderIds][0] : undefined,
    summary: p.summary,
    at: new Date().toISOString(),
  };
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      /* a broken listener must never affect others */
    }
  }
}

export function listenerCount() {
  return listeners.size;
}
