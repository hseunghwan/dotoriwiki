const TAPS_TO_FIRE = 3;
const TAP_WINDOW_MS = 1000;

/** Adds a tap at `now`. Fires when TAPS_TO_FIRE taps land within TAP_WINDOW_MS, then starts over. */
export function addTap(taps: readonly number[], now: number): { taps: number[]; fired: boolean } {
  const recent = [...taps.filter((t) => now - t < TAP_WINDOW_MS), now];
  return recent.length >= TAPS_TO_FIRE ? { taps: [], fired: true } : { taps: recent, fired: false };
}
