import * as Location from 'expo-location';
import type { GeoFix } from './capture';

function within<T>(ms: number, p: Promise<T>): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

const round = (n: number) => Math.round(n * 1e5) / 1e5;

type Geocoded = Pick<Location.LocationGeocodedAddress, 'district' | 'subregion' | 'city' | 'region' | 'street' | 'streetNumber' | 'name' | 'formattedAddress'>;

/** 사직동, 사직1동, 을지로3가, 읍·면·리. Not a road (사직로) and not an apartment block (101동). */
const DONG = /^(?:[가-힣]+\d*(?:동|읍|면|리)|[가-힣]+\d+가)$/;

/** What the app shows: the 구 and the 동, e.g. "종로구 사직동". */
export function placeOf(p: Geocoded): string | null {
  const area = p.district ?? p.subregion ?? p.city ?? null;
  const dong = [p.street, ...(p.formattedAddress?.split(/\s+/) ?? [])].find((s) => s && s !== area && DONG.test(s)) ?? null;
  return [area, dong].filter(Boolean).join(' ') || null;
}

/** What the memo records: the full address down to the 번지, plus a building name the address leaves out. */
export function addressOf(p: Geocoded): string | null {
  const full = p.formattedAddress?.replace(/^대한민국\s+/, '').trim()
    || [p.region, p.district, p.street, p.streetNumber].filter(Boolean).join(' ');
  if (!full) return p.name ?? null;
  return p.name && !full.includes(p.name) ? `${full} (${p.name})` : full;
}

/** A photo's own GPS fix as place and address. Null on any failure: the gateway still has the coordinates. */
export async function geocode(lat: number, lon: number): Promise<{ place: string | null; address: string | null } | null> {
  const p = (await within(3_000, Location.reverseGeocodeAsync({ latitude: lat, longitude: lon })))?.[0];
  return p ? { place: placeOf(p), address: addressOf(p) } : null;
}

/** Last known position first, then a fresh fix if one arrives within ~3 s. Null without permission. */
export async function locate(): Promise<GeoFix | null> {
  const perm = await Location.getForegroundPermissionsAsync().catch(() => null);
  if (!perm?.granted) return null;
  const pos =
    (await within(1_000, Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 }))) ??
    (await within(3_000, Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })));
  if (!pos) return null;
  const { latitude, longitude } = pos.coords;
  const places = await within(2_000, Location.reverseGeocodeAsync({ latitude, longitude }));
  const p = places?.[0];
  return { lat: round(latitude), lon: round(longitude), place: p ? placeOf(p) : null, address: p ? addressOf(p) : null };
}
