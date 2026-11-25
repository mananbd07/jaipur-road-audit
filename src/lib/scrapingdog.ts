import type {
  ClaimCandidate,
  ClaimedStatus,
  Env,
  NewsSearchResult,
  ScrapingDogResponse,
  TenderSearchResult,
} from '../types';

type ApiResult = { status: number; text: string; durationMs: number };

type ZoneLocation = { label: string; pincode: string; lat: number; lng: number };

const JAIPUR_ZONES: ZoneLocation[] = [
  { label: 'Sitapura Industrial Area / Vidhani Road near JECRC University', pincode: '302022', lat: 26.7870, lng: 75.8227 },
  { label: 'Mahal Road, Zone-14', pincode: '302022', lat: 26.7969, lng: 75.8402 },
  { label: 'Malviya Nagar Wards 73-83', pincode: '302017', lat: 26.8547, lng: 75.8118 },
  { label: 'Tonk Road service lane, Gopalpura to Durgapura', pincode: '302018', lat: 26.8466, lng: 75.7983 },
  { label: 'Mansarovar Sector 7 and New Sanganer Road', pincode: '302020', lat: 26.8501, lng: 75.7630 },
  { label: 'Vidyadhar Nagar Sector 2 and Alankar Road', pincode: '302039', lat: 26.9615, lng: 75.7796 },
];

function configured(env: Env): boolean {
  return Boolean(env.SCRAPINGDOG_API_KEY?.trim());
}

function chooseZone(value?: string): ZoneLocation {
  const input = value?.toLowerCase() ?? '';
  return JAIPUR_ZONES.find((zone) => {
    const zoneText = `${zone.label} ${zone.pincode}`.toLowerCase();
    return input && (zoneText.includes(input) || input.includes(zone.pincode) || input.split(/\s+/).some((part) => part.length > 3 && zoneText.includes(part)));
  }) ?? JAIPUR_ZONES[0];
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseResponse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function endpointUrl(endpoint: string, params: Record<string, string>): string {
  const url = new URL(`https://api.scrapingdog.com/${endpoint}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

async function logRun(
  db: D1Database,
  endpoint: string,
  queryOrUrl: string,
  mode: 'live_scrapingdog' | 'demo_fallback',
  httpStatus: number,
  creditsEstimated: number,
  recordsFound: number,
  durationMs: number,
): Promise<void> {
  await db.prepare(
    `INSERT INTO scrape_runs
      (endpoint, query_or_url, mode, http_status, credits_estimated, records_found, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(endpoint, queryOrUrl, mode, httpStatus, creditsEstimated, recordsFound, durationMs).run();
}

async function requestWithRetry(url: string): Promise<ApiResult> {
  const started = Date.now();
  let lastStatus = 599;
  let lastText = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 25_000);
    try {
      const response = await fetch(url, { signal: abortController.signal, headers: { accept: 'application/json, text/plain;q=0.9' } });
      lastStatus = response.status;
      lastText = await response.text();
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) continue;
      return { status: lastStatus, text: lastText, durationMs: Date.now() - started };
    } catch {
      lastStatus = 599;
      lastText = '';
      if (attempt === 1) return { status: lastStatus, text: lastText, durationMs: Date.now() - started };
    } finally {
      clearTimeout(timeout);
    }
  }
  return { status: lastStatus, text: lastText, durationMs: Date.now() - started };
}

function getArray(payload: unknown, keys: string[]): Record<string, unknown>[] {
  const object = plainObject(payload);
  if (!object) return [];
  for (const key of keys) {
    if (Array.isArray(object[key])) return object[key].map(plainObject).filter((item): item is Record<string, unknown> => item !== null);
  }
  for (const value of Object.values(object)) {
    const nested = plainObject(value);
    if (nested) {
      const found = getArray(nested, keys);
      if (found.length) return found;
    }
  }
  return [];
}

function findProperty(payload: unknown, keys: string[]): unknown {
  const object = plainObject(payload);
  if (!object) return undefined;
  for (const key of keys) if (object[key] !== undefined) return object[key];
  for (const value of Object.values(object)) {
    const nested = findProperty(value, keys);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function stableReference(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `WEB-${(hash >>> 0).toString(16).toUpperCase()}`;
}

export function parseInr(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const text = String(value ?? '').replace(/,/g, '').toLowerCase();
  const crore = text.match(/(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i);
  if (crore) return Math.round(Number(crore[1]) * 10_000_000);
  const lakh = text.match(/(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(?:lakh|lac\b)/i);
  if (lakh) return Math.round(Number(lakh[1]) * 100_000);
  const raw = text.match(/(?:₹|rs\.?|inr)\s*(\d{5,})/i) ?? text.match(/\b(\d{6,})\b/);
  return raw ? Math.round(Number(raw[1])) : 0;
}

function findAuthority(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('nagar nigam') || lower.includes('jaipur municipal')) return 'Jaipur Nagar Nigam';
  if (lower.includes('pwd') || lower.includes('public works')) return 'Rajasthan PWD';
  return 'JDA';
}

function findStatus(text: string): ClaimedStatus {
  const lower = text.toLowerCase();
  if (/claimed fixed|repaired|completed|work completed|restored/.test(lower)) return 'claimed_fixed';
  if (/in progress|ongoing|underway|work order/.test(lower)) return 'in_progress';
  return 'sanctioned';
}

function findPincode(text: string, fallback: string): string {
  return text.match(/\b3020\d{2}\b/)?.[0] ?? fallback;
}

function findTenderReference(text: string, fallback: string): string {
  const match = text.match(/(?:tender(?:\s*(?:id|ref(?:erence)?|no\.?))?|nit(?:\s*(?:no\.?)?)?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_-]{3,})/i);
  return match?.[1]?.toUpperCase() ?? stableReference(fallback);
}

function coerceCandidate(
  payload: unknown,
  sourceUrl: string,
  sourceType: ClaimCandidate['source_type'],
  zoneHint?: string,
): ClaimCandidate {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const extractedBudget = findProperty(payload, ['budget_inr', 'budget', 'sanctioned_budget', 'amount']);
  const extractedRef = stringValue(findProperty(payload, ['tender_ref', 'tender_id', 'nit_number', 'nit']));
  const extractedAuthority = stringValue(findProperty(payload, ['authority', 'department']));
  const extractedRoad = stringValue(findProperty(payload, ['zone_or_road', 'road', 'zone', 'location']));
  const extractedStatus = stringValue(findProperty(payload, ['claimed_status', 'status']));
  const zone = chooseZone(extractedRoad ?? zoneHint ?? serialized);
  const status = extractedStatus && ['sanctioned', 'in_progress', 'claimed_fixed'].includes(extractedStatus)
    ? extractedStatus as ClaimedStatus
    : findStatus(serialized);
  return {
    source_type: sourceType,
    tender_ref: extractedRef ?? findTenderReference(serialized, sourceUrl),
    authority: extractedAuthority ?? findAuthority(serialized),
    zone_or_road: extractedRoad ?? zone.label,
    pincode: findPincode(serialized, zone.pincode),
    lat: zone.lat,
    lng: zone.lng,
    budget_inr: parseInr(extractedBudget) || parseInr(serialized),
    claimed_status: status,
    source_url: sourceUrl,
    raw_snippet: serialized.slice(0, 1800),
  };
}

function demoTenderResults(zoneFilter?: string): TenderSearchResult[] {
  const primary = chooseZone(zoneFilter);
  const mahal = JAIPUR_ZONES[1];
  const primaryIsMahal = primary.pincode === mahal.pincode && primary.label === mahal.label;
  const first = primaryIsMahal
    ? {
        tender_ref: 'JNN-MAHAL-2025-088', authority: 'Jaipur Nagar Nigam', zone_or_road: mahal.label, pincode: mahal.pincode,
        lat: mahal.lat, lng: mahal.lng, budget_inr: 9000000, claimed_status: 'claimed_fixed' as ClaimedStatus,
        source_url: 'https://jaipurmc.org/tenders/mahal-road-2025-088', raw_snippet: 'Mahal Road Zone-14 pothole rectification and patchwork.',
      }
    : {
        tender_ref: 'JDA-SITAPURA-2025-144', authority: 'JDA', zone_or_road: primary.label, pincode: primary.pincode,
        lat: primary.lat, lng: primary.lng, budget_inr: 14700000, claimed_status: 'in_progress' as ClaimedStatus,
        source_url: 'https://jda.rajasthan.gov.in/tenders/sitapura-2025-144', raw_snippet: 'Sitapura-Vidhani road patch repair near JECRC University.',
      };
  return [first, {
    tender_ref: 'JNN-MAHAL-2025-088', authority: 'Jaipur Nagar Nigam', zone_or_road: mahal.label, pincode: mahal.pincode,
    lat: mahal.lat, lng: mahal.lng, budget_inr: 9000000, claimed_status: 'claimed_fixed' as ClaimedStatus,
    source_url: 'https://jaipurmc.org/tenders/mahal-road-2025-088', raw_snippet: 'Mahal Road Zone-14 pothole rectification and patchwork.',
  }].map((candidate) => ({
    url: candidate.source_url as string,
    title: candidate.tender_ref,
    snippet: candidate.raw_snippet as string,
    candidate: { source_type: 'tender', ...candidate },
  }));
}

export async function searchJaipurTenders(
  env: Env,
  db: D1Database,
  zoneFilter?: string,
): Promise<ScrapingDogResponse<TenderSearchResult[]>> {
  const query = `Jaipur "${zoneFilter || 'Sitapura OR Malviya Nagar OR Mahal Road'}" pothole OR "patch repair" OR "road repair" tender JDA OR PWD`;
  if (!configured(env)) {
    const data = demoTenderResults(zoneFilter);
    await logRun(db, 'google', query, 'demo_fallback', 200, 0, data.length, 0);
    return { live_mode: false, data };
  }
  const url = endpointUrl('google', {
    api_key: env.SCRAPINGDOG_API_KEY as string, query, country: 'in', domain: 'google.co.in', location: 'Jaipur', page: '0',
  });
  const result = await requestWithRetry(url);
  const payload = parseResponse(result.text);
  const data = result.status >= 200 && result.status < 300
    ? getArray(payload, ['organic_results', 'organicResults']).map((item) => {
        const targetUrl = stringValue(item.link) ?? stringValue(item.url) ?? '';
        const title = stringValue(item.title) ?? 'Jaipur road repair tender';
        const snippet = stringValue(item.snippet) ?? stringValue(item.description) ?? '';
        return { url: targetUrl, title, snippet, candidate: coerceCandidate(`${title} ${snippet}`, targetUrl || title, 'tender', zoneFilter) };
      }).filter((item) => item.url)
    : [];
  await logRun(db, 'google', query, 'live_scrapingdog', result.status, 1, data.length, result.durationMs);
  return { live_mode: true, data };
}

export async function scrapeTenderPage(
  env: Env,
  db: D1Database,
  targetUrl: string,
): Promise<ScrapingDogResponse<ClaimCandidate | null>> {
  if (!configured(env)) {
    const match = demoTenderResults(targetUrl).find((result) => targetUrl.includes(result.url) || result.url.includes(targetUrl)) ?? demoTenderResults(targetUrl)[0];
    const data = match.candidate ?? null;
    await logRun(db, 'scrape', targetUrl, 'demo_fallback', 200, 0, data ? 1 : 0, 0);
    return { live_mode: false, data };
  }
  const extractionRules = JSON.stringify({
    tender_ref: 'Tender ID or NIT number', authority: 'JDA, Jaipur Nagar Nigam, or Rajasthan PWD',
    zone_or_road: 'Road name or Jaipur zone', budget_inr: 'Sanctioned budget amount in INR',
    claimed_status: 'sanctioned, in_progress, or claimed_fixed',
  });
  const url = endpointUrl('scrape', {
    api_key: env.SCRAPINGDOG_API_KEY as string, url: targetUrl, dynamic: 'false', formats: 'markdown', ai_extract_rules: extractionRules,
  });
  const result = await requestWithRetry(url);
  const payload = parseResponse(result.text);
  const data = result.status >= 200 && result.status < 300 ? coerceCandidate(payload, targetUrl, 'tender') : null;
  await logRun(db, 'scrape', targetUrl, 'live_scrapingdog', result.status, 5, data ? 1 : 0, result.durationMs);
  return { live_mode: true, data };
}

export async function searchJaipurRoadNews(
  env: Env,
  db: D1Database,
  zoneFilter?: string,
): Promise<ScrapingDogResponse<NewsSearchResult[]>> {
  const query = `Jaipur road repair OR pothole JDA OR PWD ${zoneFilter ?? ''}`.trim();
  if (!configured(env)) {
    const zone = chooseZone(zoneFilter);
    const data: NewsSearchResult[] = [{
      source_type: 'news', headline: `Residents report post-monsoon potholes near ${zone.label}`,
      authority: zone.pincode === '302022' ? 'JDA' : 'Jaipur Nagar Nigam', zone_or_road: zone.label, pincode: zone.pincode,
      lat: zone.lat, lng: zone.lng, budget_inr: 0, claimed_status: 'sanctioned',
      source_url: `https://example.invalid/jaipur-road-audit/${zone.pincode}`, raw_snippet: 'Demo news fallback: officials said repair work was planned.',
      published_date: '2025-11-12',
    }];
    await logRun(db, 'google_news/v2', query, 'demo_fallback', 200, 0, data.length, 0);
    return { live_mode: false, data };
  }
  const url = endpointUrl('google_news/v2', { api_key: env.SCRAPINGDOG_API_KEY as string, query, country: 'in' });
  const result = await requestWithRetry(url);
  const payload = parseResponse(result.text);
  const data = result.status >= 200 && result.status < 300
    ? getArray(payload, ['news_results', 'articles', 'news']).map((item) => {
        const headline = stringValue(item.title) ?? stringValue(item.headline) ?? 'Jaipur road update';
        const sourceUrl = stringValue(item.link) ?? stringValue(item.url) ?? '';
        const snippet = stringValue(item.snippet) ?? stringValue(item.description) ?? headline;
        const candidate = coerceCandidate(`${headline} ${snippet}`, sourceUrl || headline, 'news', zoneFilter);
        return { ...candidate, tender_ref: null, headline, published_date: stringValue(item.date) ?? stringValue(item.published_date) ?? null };
      }).filter((item) => item.source_url)
    : [];
  await logRun(db, 'google_news/v2', query, 'live_scrapingdog', result.status, 2, data.length, result.durationMs);
  return { live_mode: true, data };
}

export async function geocodeJaipurZone(
  env: Env,
  db: D1Database,
  zoneName: string,
): Promise<ScrapingDogResponse<ZoneLocation>> {
  const fallback = chooseZone(zoneName);
  const query = `${zoneName}, Jaipur, Rajasthan`;
  if (!configured(env)) {
    await logRun(db, 'google_maps', query, 'demo_fallback', 200, 0, 1, 0);
    return { live_mode: false, data: fallback };
  }
  const url = endpointUrl('google_maps', {
    api_key: env.SCRAPINGDOG_API_KEY as string, query, ll: '@26.9124,75.7873,12z', country: 'in', domain: 'google.co.in',
  });
  const result = await requestWithRetry(url);
  const payload = parseResponse(result.text);
  const coordinates = findProperty(payload, ['gps_coordinates', 'coordinates']);
  const coordinateObject = plainObject(coordinates);
  const latitude = numberValue(coordinateObject?.latitude ?? coordinateObject?.lat);
  const longitude = numberValue(coordinateObject?.longitude ?? coordinateObject?.lng ?? coordinateObject?.longitude);
  const data = latitude !== null && longitude !== null ? { ...fallback, lat: latitude, lng: longitude } : fallback;
  await logRun(db, 'google_maps', query, 'live_scrapingdog', result.status, 1, 1, result.durationMs);
  return { live_mode: true, data };
}
