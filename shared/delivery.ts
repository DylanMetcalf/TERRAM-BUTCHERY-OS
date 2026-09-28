/**
 * Delivery fee: free within a radius of the shop, then a rate per kilometre for the
 * distance beyond it (e.g. free within 60 km, R5/km after that: 75 km → 15 km × R5 = R75).
 */
export function deliveryFeeCents(km: number | null | undefined, freeKm: number, ratePerKmCents: number): number | null {
  if (km == null || !Number.isFinite(km) || km < 0) return null;
  return Math.round(Math.max(0, km - freeKm) * ratePerKmCents);
}
