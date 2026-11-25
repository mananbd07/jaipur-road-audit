import type { Context } from 'hono';
import {
  geocodeJaipurZone,
  scrapeTenderPage,
  searchJaipurRoadNews,
  searchJaipurTenders,
} from '../lib/scrapingdog';
import type { ClaimCandidate, Env, GovernmentClaim } from '../types';

type ApiContext = Context<{ Bindings: Env }>;

const claimColumns = `id, source_type, tender_ref, authority, zone_or_road, pincode, lat, lng,
  budget_inr, claimed_status, source_url, raw_snippet, published_date, scraped_at`;

function normalizedCandidate(candidate: ClaimCandidate): Required<Pick<ClaimCandidate,
  'source_type' | 'authority' | 'zone_or_road' | 'budget_inr' | 'claimed_status'>> & ClaimCandidate {
  return {
    ...candidate,
    source_type: candidate.source_type,
    authority: candidate.authority.trim() || 'JDA',
    zone_or_road: candidate.zone_or_road.trim() || 'Jaipur road location',
    budget_inr: Math.max(0, Math.round(candidate.budget_inr ?? 0)),
    claimed_status: candidate.claimed_status ?? 'sanctioned',
  };
}

export async function upsertClaim(db: D1Database, rawCandidate: ClaimCandidate): Promise<GovernmentClaim> {
  const candidate = normalizedCandidate(rawCandidate);
  const values = [
    candidate.source_type,
    candidate.tender_ref ?? null,
    candidate.authority,
    candidate.zone_or_road,
    candidate.pincode ?? null,
    candidate.lat ?? null,
    candidate.lng ?? null,
    candidate.budget_inr,
    candidate.claimed_status,
    candidate.source_url ?? null,
    candidate.raw_snippet ?? null,
    candidate.published_date ?? null,
  ];
  if (candidate.tender_ref) {
    await db.prepare(
      `INSERT INTO gov_claims
        (source_type, tender_ref, authority, zone_or_road, pincode, lat, lng, budget_inr, claimed_status, source_url, raw_snippet, published_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tender_ref) DO UPDATE SET
        source_type = excluded.source_type, authority = excluded.authority, zone_or_road = excluded.zone_or_road,
        pincode = excluded.pincode, lat = excluded.lat, lng = excluded.lng, budget_inr = excluded.budget_inr,
        claimed_status = excluded.claimed_status, source_url = excluded.source_url, raw_snippet = excluded.raw_snippet,
        published_date = excluded.published_date, scraped_at = datetime('now')`,
    ).bind(...values).run();
    const saved = await db.prepare(`SELECT ${claimColumns} FROM gov_claims WHERE tender_ref = ?`).bind(candidate.tender_ref).first<GovernmentClaim>();
    if (saved) return saved;
  } else if (candidate.source_url) {
    const existing = await db.prepare(`SELECT id FROM gov_claims WHERE source_url = ?`).bind(candidate.source_url).first<{ id: number }>();
    if (existing) {
      await db.prepare(
        `UPDATE gov_claims SET source_type = ?, authority = ?, zone_or_road = ?, pincode = ?, lat = ?, lng = ?,
          budget_inr = ?, claimed_status = ?, raw_snippet = ?, published_date = ?, scraped_at = datetime('now') WHERE id = ?`,
      ).bind(
        candidate.source_type, candidate.authority, candidate.zone_or_road, candidate.pincode ?? null, candidate.lat ?? null,
        candidate.lng ?? null, candidate.budget_inr, candidate.claimed_status, candidate.raw_snippet ?? null,
        candidate.published_date ?? null, existing.id,
      ).run();
      const saved = await db.prepare(`SELECT ${claimColumns} FROM gov_claims WHERE id = ?`).bind(existing.id).first<GovernmentClaim>();
      if (saved) return saved;
    }
  }
  await db.prepare(
    `INSERT INTO gov_claims
      (source_type, tender_ref, authority, zone_or_road, pincode, lat, lng, budget_inr, claimed_status, source_url, raw_snippet, published_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(...values).run();
  const saved = candidate.tender_ref
    ? await db.prepare(`SELECT ${claimColumns} FROM gov_claims WHERE tender_ref = ?`).bind(candidate.tender_ref).first<GovernmentClaim>()
    : await db.prepare(`SELECT ${claimColumns} FROM gov_claims ORDER BY id DESC LIMIT 1`).first<GovernmentClaim>();
  if (!saved) throw new Error('Claim upsert did not return a record');
  return saved;
}

export async function listClaims(c: ApiContext) {
  const authority = c.req.query('authority');
  const pincode = c.req.query('pincode');
  const status = c.req.query('status');
  const where: string[] = [];
  const values: string[] = [];
  if (authority) { where.push('authority = ?'); values.push(authority); }
  if (pincode) { where.push('pincode = ?'); values.push(pincode); }
  if (status) { where.push('claimed_status = ?'); values.push(status); }
  const sql = `SELECT ${claimColumns} FROM gov_claims${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY scraped_at DESC, id DESC`;
  const result = await c.env.DB.prepare(sql).bind(...values).all<GovernmentClaim>();
  return c.json({ ok: true, claims: result.results });
}

export async function scrapeSync(c: ApiContext) {
  let input: { zone?: unknown; max_scrape_pages?: unknown } = {};
  try {
    input = await c.req.json<typeof input>();
  } catch {
    // An empty request body intentionally uses the credit-safe defaults.
  }
  const zone = typeof input.zone === 'string' && input.zone.trim() ? input.zone.trim() : undefined;
  const requestedPages = Number(input.max_scrape_pages);
  const maxPages = Number.isFinite(requestedPages) && requestedPages >= 0
    ? Math.min(5, Math.floor(requestedPages))
    : 2;

  const tenderSearch = await searchJaipurTenders(c.env, c.env.DB, zone);
  const tenderCandidates: ClaimCandidate[] = [];
  const pages = tenderSearch.data.slice(0, maxPages);
  let scrapeCredits = 0;
  for (const result of pages) {
    const page = await scrapeTenderPage(c.env, c.env.DB, result.url);
    if (page.live_mode) scrapeCredits += 5;
    tenderCandidates.push(page.data ?? result.candidate ?? {
      source_type: 'tender', authority: 'JDA', zone_or_road: zone ?? 'Jaipur road repair location',
      tender_ref: null, source_url: result.url, raw_snippet: result.snippet,
    });
  }
  const news = await searchJaipurRoadNews(c.env, c.env.DB, zone);
  const geocodeTarget = zone ?? tenderCandidates[0]?.zone_or_road ?? 'Sitapura, Jaipur';
  const geocode = await geocodeJaipurZone(c.env, c.env.DB, geocodeTarget);
  const candidates = [...tenderCandidates, ...news.data].map((candidate) => ({
    ...candidate,
    lat: candidate.lat ?? geocode.data.lat,
    lng: candidate.lng ?? geocode.data.lng,
    pincode: candidate.pincode ?? geocode.data.pincode,
  }));
  const claims: GovernmentClaim[] = [];
  for (const candidate of candidates) claims.push(await upsertClaim(c.env.DB, candidate));
  const liveMode = tenderSearch.live_mode && news.live_mode && geocode.live_mode;
  const creditsEstimated = (tenderSearch.live_mode ? 1 : 0) + scrapeCredits + (news.live_mode ? 2 : 0) + (geocode.live_mode ? 1 : 0);
  return c.json({
    ok: true,
    mode: liveMode ? 'live_scrapingdog' : 'demo_fallback',
    synced_count: claims.length,
    credits_estimated: creditsEstimated,
    claims,
    note: liveMode ? undefined : 'Set SCRAPINGDOG_API_KEY to fetch live web data',
  });
}

export async function scrapeStats(c: ApiContext) {
  const totals = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total_calls,
      COALESCE(SUM(CASE WHEN mode = 'live_scrapingdog' THEN 1 ELSE 0 END), 0) AS live_calls,
      COALESCE(SUM(credits_estimated), 0) AS estimated_credits_used
     FROM scrape_runs`,
  ).first<{ total_calls: number; live_calls: number; estimated_credits_used: number }>();
  const byEndpoint = await c.env.DB.prepare(
    `SELECT endpoint, COUNT(*) AS calls, COALESCE(SUM(credits_estimated), 0) AS estimated_credits_used,
      COALESCE(SUM(records_found), 0) AS records_found
     FROM scrape_runs GROUP BY endpoint ORDER BY calls DESC, endpoint ASC`,
  ).all();
  const recentRuns = await c.env.DB.prepare(
    `SELECT id, endpoint, query_or_url, mode, http_status, credits_estimated, records_found, duration_ms, created_at
     FROM scrape_runs ORDER BY created_at DESC, id DESC LIMIT 25`,
  ).all();
  return c.json({ ok: true, ...(totals ?? { total_calls: 0, live_calls: 0, estimated_credits_used: 0 }), by_endpoint: byEndpoint.results, recent_runs: recentRuns.results });
}
