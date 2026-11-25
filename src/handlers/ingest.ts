import type { Context } from 'hono';
import { evaluateDetectionAgainstClaims } from '../lib/auditor';
import type { Env, GovernmentClaim, RoverDetection, Severity } from '../types';

type ApiContext = Context<{ Bindings: Env }>;
type Input = Record<string, unknown>;

const severities = new Set<Severity>(['none', 'low', 'medium', 'critical']);
const imageTypes: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function inputString(input: Input, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function inputNumber(input: Input, key: string, fallback?: number): number | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function safeTelemetry(value: unknown): string {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value)); } catch { return JSON.stringify({ raw: value }); }
  }
  return JSON.stringify(value ?? {});
}

function asObject(value: unknown): Input {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Input : {};
}

async function parseInput(c: ApiContext): Promise<{ input: Input; snapshot: File | null }> {
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const metadataValue = form.get('metadata');
    let metadata: Input = {};
    if (typeof metadataValue === 'string' && metadataValue.trim()) {
      try { metadata = asObject(JSON.parse(metadataValue)); } catch { throw new Error('metadata must be valid JSON'); }
    }
    const fields: Input = {};
    form.forEach((value, key) => {
      if (typeof value === 'string' && key !== 'metadata') fields[key] = value;
    });
    const image = form.get('snapshot');
    return { input: { ...metadata, ...fields }, snapshot: image instanceof File ? image : null };
  }
  if (contentType.includes('application/json')) return { input: asObject(await c.req.json()), snapshot: null };
  throw new Error('Use application/json or multipart/form-data');
}

function randomHex(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function snapshotUrl(key: string | null): string | null {
  return key ? `/api/snapshots/${key.split('/').map(encodeURIComponent).join('/')}` : null;
}

export async function ingestDetection(c: ApiContext) {
  if (c.env.ROVER_API_KEY?.trim() && c.req.header('x-rover-key') !== c.env.ROVER_API_KEY) {
    return c.json({ ok: false, error: 'Invalid X-Rover-Key' }, 401);
  }
  let parsed: { input: Input; snapshot: File | null };
  try {
    parsed = await parseInput(c);
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : 'Invalid request body' }, 400);
  }
  const roadTag = inputString(parsed.input, 'road_tag');
  const potholeCount = inputNumber(parsed.input, 'pothole_count');
  const severity = inputString(parsed.input, 'severity') as Severity | undefined;
  const score = inputNumber(parsed.input, 'road_condition_score');
  const confidence = inputNumber(parsed.input, 'confidence', 0) ?? 0;
  if (!roadTag || potholeCount === undefined || !Number.isInteger(potholeCount) || potholeCount < 0 || !severity || !severities.has(severity) || score === undefined || !Number.isInteger(score) || score < 0 || score > 100 || confidence < 0 || confidence > 1) {
    return c.json({ ok: false, error: 'road_tag, integer pothole_count, valid severity, score 0-100, and confidence 0-1 are required' }, 400);
  }
  let storedSnapshotKey: string | null = null;
  if (parsed.snapshot) {
    const extension = imageTypes[parsed.snapshot.type];
    if (!extension) return c.json({ ok: false, error: 'snapshot must be JPEG, PNG, or WebP' }, 400);
    if (parsed.snapshot.size > 5 * 1024 * 1024) return c.json({ ok: false, error: 'snapshot exceeds 5MB limit' }, 413);
    storedSnapshotKey = `snapshots/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomHex()}.${extension}`;
    await c.env.BUCKET.put(storedSnapshotKey, await parsed.snapshot.arrayBuffer(), {
      httpMetadata: { contentType: parsed.snapshot.type, cacheControl: 'public, max-age=86400' },
    });
  }
  const detectedAt = inputString(parsed.input, 'detected_at') ?? new Date().toISOString();
  const insert = await c.env.DB.prepare(
    `INSERT INTO rover_detections
      (rover_id, road_tag, pincode, lat, lng, pothole_count, severity, road_condition_score, confidence, snapshot_key, telemetry_json, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    inputString(parsed.input, 'rover_id') ?? 'thinkcentre-rover-01', roadTag, inputString(parsed.input, 'pincode') ?? null,
    inputNumber(parsed.input, 'lat') ?? null, inputNumber(parsed.input, 'lng') ?? null, potholeCount, severity, score, confidence,
    storedSnapshotKey, safeTelemetry(parsed.input.telemetry_json ?? parsed.input.telemetry), detectedAt,
  ).run();
  const detectionId = Number(insert.meta.last_row_id);
  const detection = await c.env.DB.prepare('SELECT * FROM rover_detections WHERE id = ?').bind(detectionId).first<RoverDetection>();
  if (!detection) throw new Error('Detection insert did not return a record');
  const claimResult = await c.env.DB.prepare('SELECT * FROM gov_claims').all<GovernmentClaim>();
  const comparison = evaluateDetectionAgainstClaims(detection, claimResult.results);
  const { evaluation, matched_claim: matchedClaim } = comparison;
  const verdictInsert = await c.env.DB.prepare(
    `INSERT INTO audit_verdicts
      (detection_id, claim_id, verdict, discrepancy_score, budget_at_risk_inr, evidence_summary, grievance_draft, x_intent_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    detection.id, matchedClaim?.id ?? null, evaluation.verdict, evaluation.discrepancy_score,
    evaluation.budget_at_risk_inr, evaluation.evidence_summary, evaluation.grievance_draft, evaluation.x_intent_url,
  ).run();
  return c.json({
    ok: true,
    detection,
    matched_claim: matchedClaim,
    verdict: { id: Number(verdictInsert.meta.last_row_id), ...evaluation },
    snapshot_url: snapshotUrl(storedSnapshotKey),
  }, 201);
}

export async function listAudits(c: ApiContext) {
  const kpiResult = await c.env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM gov_claims) AS total_claims,
      (SELECT COALESCE(SUM(budget_inr), 0) FROM gov_claims) AS total_budget_audited_inr,
      COALESCE(SUM(a.budget_at_risk_inr), 0) AS total_budget_at_risk_inr,
      COALESCE(SUM(CASE WHEN a.verdict IN ('DISCREPANCY_UNFIXED', 'POST_REPAIR_FAILURE') THEN 1 ELSE 0 END), 0) AS active_discrepancies,
      COALESCE(SUM(CASE WHEN a.verdict = 'VERIFIED_CLEAR' THEN 1 ELSE 0 END), 0) AS verified_clear,
      (SELECT COALESCE(SUM(pothole_count), 0) FROM rover_detections) AS total_potholes_detected
     FROM audit_verdicts a`,
  ).first();
  const auditResult = await c.env.DB.prepare(
    `SELECT a.*, d.rover_id, d.road_tag, d.pincode AS detection_pincode, d.lat AS detection_lat, d.lng AS detection_lng,
      d.pothole_count, d.severity, d.road_condition_score, d.confidence, d.snapshot_key, d.detected_at,
      g.tender_ref, g.authority, g.zone_or_road, g.pincode AS claim_pincode, g.budget_inr, g.claimed_status
     FROM audit_verdicts a
     JOIN rover_detections d ON d.id = a.detection_id
     LEFT JOIN gov_claims g ON g.id = a.claim_id
     ORDER BY a.created_at DESC, a.id DESC`,
  ).all<Record<string, unknown>>();
  const audits = auditResult.results.map((audit) => ({ ...audit, snapshot_url: snapshotUrl(typeof audit.snapshot_key === 'string' ? audit.snapshot_key : null) }));
  return c.json({ ok: true, kpis: kpiResult ?? { total_claims: 0, total_budget_audited_inr: 0, total_budget_at_risk_inr: 0, active_discrepancies: 0, verified_clear: 0, total_potholes_detected: 0 }, audits });
}

export async function resetDemoDetections(c: ApiContext) {
  if (c.env.ROVER_API_KEY?.trim() && c.req.header('x-rover-key') !== c.env.ROVER_API_KEY) {
    return c.json({ ok: false, error: 'Invalid X-Rover-Key' }, 401);
  }
  const verdicts = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM audit_verdicts').first<{ count: number }>();
  const detections = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM rover_detections').first<{ count: number }>();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM audit_verdicts'),
    c.env.DB.prepare('DELETE FROM rover_detections'),
  ]);
  return c.json({
    ok: true,
    deleted: { verdicts: verdicts?.count ?? 0, detections: detections?.count ?? 0 },
    note: 'Government claims were preserved.',
  });
}

export async function handleDeleteAudit(c: ApiContext) {
  if (c.env.ROVER_API_KEY?.trim() && c.req.header('x-rover-key') !== c.env.ROVER_API_KEY) {
    return c.json({ ok: false, error: 'Invalid X-Rover-Key' }, 401);
  }
  const rawId = c.req.param('id');
  if (!rawId || !/^\d+$/.test(rawId) || Number(rawId) < 1) {
    return c.json({ ok: false, error: 'Audit id must be a positive integer' }, 400);
  }
  const auditId = Number(rawId);
  const audit = await c.env.DB.prepare(
    `SELECT a.id, a.detection_id, d.snapshot_key
     FROM audit_verdicts a
     JOIN rover_detections d ON d.id = a.detection_id
     WHERE a.id = ?`,
  ).bind(auditId).first<{ id: number; detection_id: number; snapshot_key: string | null }>();
  if (!audit) return c.json({ ok: false, error: 'Audit not found' }, 404);
  if (audit.snapshot_key) await c.env.BUCKET.delete(audit.snapshot_key);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM audit_verdicts WHERE id = ?').bind(audit.id),
    c.env.DB.prepare('DELETE FROM rover_detections WHERE id = ?').bind(audit.detection_id),
  ]);
  return c.json({ ok: true, deleted_audit_id: audit.id, deleted_detection_id: audit.detection_id });
}

export async function getSnapshot(c: ApiContext) {
  const key = c.req.param('key');
  if (!key || !key.startsWith('snapshots/') || key.includes('..')) return c.json({ ok: false, error: 'Snapshot not found' }, 404);
  const object = await c.env.BUCKET.get(key);
  if (!object) return c.json({ ok: false, error: 'Snapshot not found' }, 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': object.httpMetadata?.cacheControl ?? 'public, max-age=86400',
      ETag: object.httpEtag,
    },
  });
}
