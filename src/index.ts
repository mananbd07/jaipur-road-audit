import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getSnapshot, handleDeleteAudit, ingestDetection, listAudits, resetDemoDetections } from './handlers/ingest';
import { listClaims, scrapeStats, scrapeSync } from './handlers/scrape';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'X-Rover-Key'],
  maxAge: 86400,
}));

app.get('/api/health', async (c) => {
  const counts = await c.env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM gov_claims) AS claims,
      (SELECT COUNT(*) FROM rover_detections) AS detections,
      (SELECT COUNT(*) FROM audit_verdicts) AS verdicts`,
  ).first<{ claims: number; detections: number; verdicts: number }>();
  return c.json({
    ok: true,
    service: 'jaipur-road-audit-api',
    scrapingdog_configured: Boolean(c.env.SCRAPINGDOG_API_KEY?.trim()),
    counts: counts ?? { claims: 0, detections: 0, verdicts: 0 },
  });
});

app.post('/api/scrape/sync', scrapeSync);
app.get('/api/claims', listClaims);
app.get('/api/scrape/stats', scrapeStats);
app.post('/api/ingest/detection', ingestDetection);
app.post('/api/demo/reset-detections', resetDemoDetections);
app.get('/api/audits', listAudits);
app.delete('/api/audits/:id', handleDeleteAudit);
app.get('/api/snapshots/:key{.+}', getSnapshot);

app.notFound((c) => c.json({ ok: false, error: 'Not found' }, 404));
app.onError((error, c) => {
  console.error('Unhandled API error', error);
  return c.json({ ok: false, error: 'Internal server error' }, 500);
});

export default app;
