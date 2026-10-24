/** A reorder from the order page waits here until the order form opens. */
export const REORDER_KEY = 'terram:reorder-draft';

/** Orders placed on this device, so the customer can find them again without signing in. */
const MY_ORDERS = 'terram:my-orders';
export interface DeviceOrder { number: number; url: string; at: string }

export function rememberOrder(o: DeviceOrder) {
  try {
    const list = deviceOrders().filter((x) => x.number !== o.number);
    localStorage.setItem(MY_ORDERS, JSON.stringify([o, ...list].slice(0, 25)));
  } catch {
    /* storage unavailable */
  }
}

export function deviceOrders(): DeviceOrder[] {
  try {
    const v = JSON.parse(localStorage.getItem(MY_ORDERS) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.number === 'number' && typeof x.url === 'string' && x.url.startsWith('/o/')) : [];
  } catch {
    return [];
  }
}
