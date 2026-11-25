const API = '/api';
const JAIPUR = [26.9124, 75.7873];
const PWD_SUGAM_PATH = 'https://sugampath.rajasthan.gov.in/';
const SAMPARK = 'https://sampark.rajasthan.gov.in/';
const verdictColors = {
  DISCREPANCY_UNFIXED: '#ef4444',
  POST_REPAIR_FAILURE: '#f97316',
  UNREPORTED_DAMAGE: '#eab308',
  VERIFIED_CLEAR: '#10b981',
};

const state = {
  health: null,
  audits: [],
  claims: [],
  stats: null,
  map: null,
  claimLayer: null,
  auditLayer: null,
  auditMarkers: new Map(),
  mapFilter: 'all',
  polling: true,
  interval: null,
  refreshInFlight: false,
};

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatInr(value) {
  const amount = asNumber(value);
  if (amount >= 10_000_000) return `₹${(amount / 10_000_000).toFixed(2).replace(/\.00$/, '')} Cr`;
  if (amount >= 100_000) return `₹${(amount / 100_000).toFixed(amount >= 1_000_000 ? 2 : 1).replace(/\.0+$/, '')} Lakh`;
  return `₹${new Intl.NumberFormat('en-IN').format(amount)}`;
}

function readableVerdict(verdict) {
  return String(verdict ?? 'UNKNOWN').replaceAll('_', ' ');
}

function compactDate(value) {
  if (!value) return 'Timestamp unavailable';
  const date = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function safeUrl(value) {
  try {
    const url = new URL(value, window.location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '#';
  } catch {
    return '#';
  }
}

function showToast(message, kind = 'success') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast ${kind} show`;
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => { toast.className = 'toast'; }, 3600);
}

async function getJson(path, options = {}) {
  const response = await fetch(`${API}${path}`, { headers: { accept: 'application/json', ...(options.headers ?? {}) }, ...options });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body;
}

function initMap() {
  if (!window.L) return;
  state.map = window.L.map('audit-map', { zoomControl: true, scrollWheelZoom: true }).setView(JAIPUR, 12);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(state.map);
  state.claimLayer = window.L.layerGroup().addTo(state.map);
  state.auditLayer = window.L.layerGroup().addTo(state.map);
}

function claimPopup(claim) {
  const source = safeUrl(claim.source_url);
  return `<div class="map-popup"><strong>${escapeHtml(claim.tender_ref || 'Public road record')}</strong><br><span>${escapeHtml(claim.authority)}</span><hr><b>${escapeHtml(claim.zone_or_road)}</b><br>PIN ${escapeHtml(claim.pincode || '—')} · ${formatInr(claim.budget_inr)}<br><span class="claim-status">${escapeHtml(String(claim.claimed_status).replace('_', ' '))}</span>${source !== '#' ? `<br><a href="${escapeHtml(source)}" target="_blank" rel="noreferrer">Open source ↗</a>` : ''}</div>`;
}

function auditPopup(audit) {
  const image = audit.snapshot_url ? `<img src="${escapeHtml(audit.snapshot_url)}" alt="Rover snapshot" style="width:100%;max-width:220px;margin:8px 0;border-radius:6px">` : '';
  return `<div class="map-popup"><strong>${escapeHtml(readableVerdict(audit.verdict))}</strong><br><b>${escapeHtml(audit.road_tag)}</b><br>${escapeHtml(String(audit.pothole_count))} potholes · condition ${escapeHtml(String(audit.road_condition_score))}/100${image}</div>`;
}

function rebuildMap() {
  if (!state.map || !state.claimLayer || !state.auditLayer) return;
  state.claimLayer.clearLayers();
  state.auditLayer.clearLayers();
  state.auditMarkers.clear();
  const filter = state.mapFilter;
  const showClaims = filter === 'all' || filter === 'claims';
  const showAudits = filter === 'all' || filter === 'discrepancies' || filter === 'clear';
  if (showClaims) {
    state.claims.forEach((claim) => {
      const lat = asNumber(claim.lat, NaN); const lng = asNumber(claim.lng, NaN);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      window.L.circleMarker([lat, lng], { radius: 7, color: '#60a5fa', fillColor: '#2563eb', fillOpacity: .82, weight: 2 })
        .bindPopup(claimPopup(claim)).addTo(state.claimLayer);
    });
  }
  if (showAudits) {
    state.audits.forEach((audit) => {
      const isClear = audit.verdict === 'VERIFIED_CLEAR';
      if ((filter === 'discrepancies' && isClear) || (filter === 'clear' && !isClear)) return;
      const lat = asNumber(audit.detection_lat, NaN); const lng = asNumber(audit.detection_lng, NaN);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const marker = window.L.circleMarker([lat, lng], { radius: 10, color: '#fff', fillColor: verdictColors[audit.verdict] ?? '#94a3b8', fillOpacity: .95, weight: 3 })
        .bindPopup(auditPopup(audit)).addTo(state.auditLayer);
      state.auditMarkers.set(String(audit.id), marker);
    });
  }
}

function renderStatus() {
  const mode = $('#scrapingdog-mode');
  const configured = Boolean(state.health?.scrapingdog_configured);
  mode.textContent = configured ? 'Scrapingdog: LIVE' : 'Scrapingdog: Demo Fallback';
  mode.className = `status-pill ${configured ? 'status-emerald' : 'status-amber'}`;
}

function renderKpis() {
  const kpis = state.stats && state.audits ? state.audits.kpis : null;
  $('#metric-budget').textContent = formatInr(kpis?.total_budget_audited_inr);
  $('#metric-claims').textContent = `${asNumber(kpis?.total_claims)} public claims indexed`;
  const atRisk = asNumber(kpis?.total_budget_at_risk_inr);
  const risk = $('#metric-risk');
  risk.textContent = formatInr(atRisk);
  risk.classList.toggle('is-risk', atRisk > 0);
  $('#metric-risk-caption').textContent = atRisk > 0 ? 'Flagged by rover evidence' : 'No funds currently flagged';
  $('#metric-discrepancies').textContent = String(asNumber(kpis?.active_discrepancies));
  $('#metric-potholes').textContent = String(asNumber(kpis?.total_potholes_detected));
  $('#metric-calls').textContent = String(asNumber(state.stats?.total_calls));
  $('#metric-credits').textContent = `Estimated credits: ${asNumber(state.stats?.estimated_credits_used)}`;
}

function renderPipeline() {
  const endpointCounts = new Map((state.stats?.by_endpoint ?? []).map((item) => [item.endpoint, item]));
  ['google', 'scrape', 'google_news/v2', 'google_maps'].forEach((endpoint) => {
    const item = endpointCounts.get(endpoint);
    const node = $(`[data-endpoint="${endpoint}"]`);
    if (node) node.textContent = String(asNumber(item?.calls));
  });
  const total = asNumber(state.stats?.total_calls);
  $('#run-count').textContent = `${total} logged call${total === 1 ? '' : 's'}`;
  $('#pipeline-mode').textContent = asNumber(state.stats?.live_calls) > 0 ? 'Live activity' : 'Demo-safe mode';
  $('#pipeline-mode').className = `status-pill ${asNumber(state.stats?.live_calls) > 0 ? 'status-emerald' : 'status-amber'}`;
  const rows = state.stats?.recent_runs ?? [];
  $('#runs-body').innerHTML = rows.length ? rows.map((run) => `<tr>
    <td class="mono">${escapeHtml(run.endpoint)}</td>
    <td class="truncate" title="${escapeHtml(run.query_or_url)}">${escapeHtml(run.query_or_url)}</td>
    <td><span class="mode-badge ${run.mode === 'live_scrapingdog' ? 'mode-live' : 'mode-demo'}">${run.mode === 'live_scrapingdog' ? 'Live' : 'Demo'}</span></td>
    <td>${escapeHtml(run.http_status)}</td><td>${escapeHtml(run.records_found)}</td><td>${escapeHtml(run.duration_ms)}</td></tr>`).join('') : '<tr><td colspan="6" class="empty-row">Waiting for API activity…</td></tr>';
}

function snapshotOrPlaceholder(audit) {
  if (audit.snapshot_url) return `<button class="snapshot-button" type="button" data-lightbox="${escapeHtml(audit.snapshot_url)}" aria-label="Expand rover snapshot"><img class="snapshot" src="${escapeHtml(audit.snapshot_url)}" alt="Rover snapshot for ${escapeHtml(audit.road_tag)}"></button>`;
  return '<svg class="telemetry-placeholder" viewBox="0 0 94 76" role="img" aria-label="Road telemetry placeholder"><path d="M-4 59 30 21h38l30 38" fill="none" stroke="#64748b" stroke-width="8"/><path d="M47 19v42" stroke="#fbbf24" stroke-width="3" stroke-dasharray="7 5"/><circle cx="31" cy="54" r="8" fill="#0f172a" stroke="#f97316" stroke-width="2"/><text x="47" y="13" fill="#fbbf24" font-size="7" text-anchor="middle">ROVER</text></svg>';
}

function claimBox(audit) {
  if (!audit.claim_id) return '<div class="claim-box"><strong>No matching public claim</strong><br>Damage is recorded as unreported in the current public dataset.</div>';
  return `<div class="claim-box"><strong>${escapeHtml(audit.authority || 'Public authority')}</strong> · ${escapeHtml(audit.tender_ref || 'Tender ref unavailable')}<br>${escapeHtml(audit.zone_or_road || audit.road_tag)} · PIN ${escapeHtml(audit.claim_pincode || audit.detection_pincode || '—')}<br>Recorded: ${escapeHtml(String(audit.claimed_status || '—').replace('_', ' '))} · <strong>${formatInr(audit.budget_inr)} allocated</strong></div>`;
}

function renderAudits() {
  const audits = state.audits?.audits ?? [];
  $('#audit-count').textContent = `${audits.length} audit${audits.length === 1 ? '' : 's'}`;
  if (!audits.length) {
    $('#audit-feed').innerHTML = '<div class="empty-feed"><div class="empty-icon">⌁</div><h3>Waiting for ThinkCentre Rover telemetry</h3><p>Send a scan to <code>POST /api/ingest/detection</code>, or click <strong>Simulate Rover Scan</strong> to test the full accountability flow.</p></div>';
    return;
  }
  $('#audit-feed').innerHTML = audits.map((audit) => `<article id="audit-${escapeHtml(audit.id)}" class="audit-card" data-audit-id="${escapeHtml(audit.id)}" tabindex="0">
    <div class="audit-top">${snapshotOrPlaceholder(audit)}<div><span class="verdict-badge verdict-${escapeHtml(audit.verdict)}">${escapeHtml(readableVerdict(audit.verdict))}</span><h3 class="audit-road">${escapeHtml(audit.road_tag)}</h3><p class="audit-time">${escapeHtml(compactDate(audit.detected_at))}</p></div></div>
    <div class="score-line"><div><strong>${escapeHtml(audit.discrepancy_score)}</strong><span>score / 100</span></div><div><strong>${escapeHtml(audit.pothole_count)}</strong><span>potholes</span></div><div><strong>${escapeHtml(audit.road_condition_score)}</strong><span>road score</span></div></div>
    ${claimBox(audit)}
    <p class="evidence">${escapeHtml(audit.evidence_summary)}</p>
    <div class="card-actions"><button type="button" data-action="copy" data-id="${escapeHtml(audit.id)}">Copy Formal Grievance</button><a class="x-action" href="${escapeHtml(safeUrl(audit.x_intent_url))}" target="_blank" rel="noreferrer">Post Evidence on X ↗</a><a href="${SAMPARK}" target="_blank" rel="noreferrer">Rajasthan Sampark ↗</a><a href="${PWD_SUGAM_PATH}" target="_blank" rel="noreferrer">PWD Sugam Path ↗</a></div>
    <details class="grievance"><summary>Preview formal complaint</summary><pre>${escapeHtml(audit.grievance_draft)}</pre></details>
  </article>`).join('');
}

function renderClaims() {
  const query = $('#claim-search').value.trim().toLowerCase();
  const authority = $('#authority-filter').value;
  const filtered = state.claims.filter((claim) => {
    const content = [claim.tender_ref, claim.authority, claim.zone_or_road, claim.pincode, claim.claimed_status].join(' ').toLowerCase();
    return (!query || content.includes(query)) && (!authority || claim.authority === authority);
  });
  $('#claims-body').innerHTML = filtered.length ? filtered.map((claim) => {
    const source = safeUrl(claim.source_url);
    return `<tr><td class="mono">${escapeHtml(claim.tender_ref || 'News record')}</td><td>${escapeHtml(claim.authority)}</td><td>${escapeHtml(claim.zone_or_road)}</td><td>${escapeHtml(claim.pincode || '—')}</td><td>${formatInr(claim.budget_inr)}</td><td><span class="claim-status">${escapeHtml(String(claim.claimed_status).replace('_', ' '))}</span></td><td>${source === '#' ? '—' : `<a class="source-link" href="${escapeHtml(source)}" target="_blank" rel="noreferrer">Source ↗</a>`}</td></tr>`;
  }).join('') : '<tr><td colspan="7" class="empty-row">No claims match this filter.</td></tr>';
}

function renderAll() {
  renderStatus();
  renderKpis();
  renderPipeline();
  renderAudits();
  renderClaims();
  rebuildMap();
}

async function refreshDashboard(showFailure = false) {
  if (state.refreshInFlight) return;
  state.refreshInFlight = true;
  try {
    const [health, auditResponse, stats, claims] = await Promise.all([
      getJson('/health'), getJson('/audits'), getJson('/scrape/stats'), getJson('/claims'),
    ]);
    state.health = health;
    state.audits = auditResponse;
    state.stats = stats;
    state.claims = claims.claims ?? [];
    renderAll();
  } catch (error) {
    console.error(error);
    if (showFailure) showToast(error instanceof Error ? error.message : 'Unable to refresh dashboard', 'error');
  } finally {
    state.refreshInFlight = false;
  }
}

function setMapFilter(filter) {
  state.mapFilter = filter;
  $$('#map-filters [data-map-filter]').forEach((button) => button.classList.toggle('is-active', button.dataset.mapFilter === filter));
  rebuildMap();
}

async function runSync(zone) {
  const button = $('#zone-sync-submit');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Syncing…';
  try {
    const response = await getJson('/scrape/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ zone: zone || undefined }) });
    showToast(`${response.synced_count} records synced in ${response.mode === 'live_scrapingdog' ? 'live' : 'demo'} mode.`);
    await refreshDashboard(true);
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Sync failed', 'error');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function canvasMockImage(roadTag) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = 960; canvas.height = 540;
    const ctx = canvas.getContext('2d');
    if (!ctx) { reject(new Error('Canvas is unavailable')); return; }
    const road = ctx.createLinearGradient(0, 0, 960, 540);
    road.addColorStop(0, '#273448'); road.addColorStop(1, '#101827');
    ctx.fillStyle = road; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 8; ctx.setLineDash([32, 22]);
    ctx.beginPath(); ctx.moveTo(0, 276); ctx.lineTo(960, 236); ctx.stroke(); ctx.setLineDash([]);
    [[305, 296, 49], [595, 245, 38], [744, 319, 31], [498, 361, 27]].forEach(([x, y, r]) => {
      const gradient = ctx.createRadialGradient(x - 10, y - 10, 5, x, y, r);
      gradient.addColorStop(0, '#0b1222'); gradient.addColorStop(.7, '#020617'); gradient.addColorStop(1, '#64748b');
      ctx.fillStyle = gradient; ctx.beginPath(); ctx.ellipse(x, y, r, r * .62, -.35, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#f97316'; ctx.lineWidth = 3; ctx.stroke();
    });
    ctx.fillStyle = 'rgba(2,6,23,.86)'; ctx.fillRect(20, 20, 500, 80);
    ctx.fillStyle = '#fbbf24'; ctx.font = 'bold 22px monospace'; ctx.fillText('THINKCENTRE ROVER · DEMO EVIDENCE', 36, 52);
    ctx.fillStyle = '#e2e8f0'; ctx.font = '16px monospace'; ctx.fillText(roadTag.slice(0, 54), 36, 80);
    canvas.toBlob((blob) => blob ? resolve(new File([blob], 'rover-demo-potholes.png', { type: 'image/png' })) : reject(new Error('Could not create demo image')), 'image/png');
  });
}

function formControl(name) { return $(`#simulator-form [name="${name}"]`); }

function applyPreset(preset) {
  const presets = {
    sitapura: { road_tag: 'Sitapura Industrial Area / Mahal Road', pincode: '302022', lat: '26.7870', lng: '75.8227', pothole_count: '4', severity: 'critical', road_condition_score: '28' },
    malviya: { road_tag: 'Malviya Nagar Ward 75', pincode: '302017', lat: '26.8547', lng: '75.8118', pothole_count: '3', severity: 'medium', road_condition_score: '46' },
    tonk: { road_tag: 'Tonk Road service lane, Gopalpura', pincode: '302018', lat: '26.8466', lng: '75.7983', pothole_count: '2', severity: 'medium', road_condition_score: '55' },
  };
  const values = presets[preset];
  if (!values) return;
  Object.entries(values).forEach(([name, value]) => { const control = formControl(name); if (control) control.value = value; });
  $$('#simulator-presets button').forEach((button) => button.classList.toggle('is-active', button.dataset.preset === preset));
}

async function submitSimulation(event) {
  event.preventDefault();
  const form = $('#simulator-form');
  const submit = $('#simulator-submit');
  const key = $('#rover-key').value.trim();
  if (key) sessionStorage.setItem('sadaksatya-rover-key', key);
  const body = new FormData(form);
  body.delete('snapshot');
  const supplied = $('#snapshot-input').files?.[0];
  try {
    if (supplied) body.append('snapshot', supplied);
    else if ($('#generate-mock').checked) body.append('snapshot', await canvasMockImage(formControl('road_tag').value));
    body.append('confidence', '0.94');
    body.append('telemetry_json', JSON.stringify({ source: 'dashboard-simulator', capture_mode: supplied ? 'user-upload' : 'canvas-demo' }));
    submit.disabled = true; submit.textContent = 'Submitting…';
    const response = await getJson('/ingest/detection', { method: 'POST', headers: key ? { 'x-rover-key': key } : {}, body });
    $('#simulator-modal').close();
    await refreshDashboard(true);
    const card = $(`#audit-${response.verdict?.id}`) || $('#audit-feed .audit-card');
    if (card) { card.classList.add('is-highlighted'); card.scrollIntoView({ behavior: 'smooth', block: 'center' }); window.setTimeout(() => card.classList.remove('is-highlighted'), 5200); }
    showToast(`${readableVerdict(response.verdict?.verdict)} recorded — accountability kit ready.`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Rover submission failed', 'error');
  } finally {
    submit.disabled = false; submit.textContent = 'Submit Rover Evidence';
  }
}

async function copyGrievance(id, button) {
  const audit = (state.audits?.audits ?? []).find((item) => String(item.id) === String(id));
  if (!audit?.grievance_draft) return;
  try {
    await navigator.clipboard.writeText(audit.grievance_draft);
    const original = button.textContent; button.textContent = '✓ Copied!';
    window.setTimeout(() => { button.textContent = original; }, 1800);
  } catch {
    showToast('Clipboard access was unavailable. Open the grievance preview to copy it.', 'error');
  }
}

function openAuditOnMap(id) {
  const audit = (state.audits?.audits ?? []).find((item) => String(item.id) === String(id));
  const marker = state.auditMarkers.get(String(id));
  if (!audit || !marker || !state.map) return;
  state.map.flyTo([asNumber(audit.detection_lat), asNumber(audit.detection_lng)], 15, { duration: .7 });
  window.setTimeout(() => marker.openPopup(), 730);
}

function bindEvents() {
  $('#poll-toggle').addEventListener('click', () => {
    state.polling = !state.polling;
    const button = $('#poll-toggle');
    button.classList.toggle('is-paused', !state.polling);
    button.setAttribute('aria-pressed', String(!state.polling));
    $('#poll-label').textContent = state.polling ? 'Live Rover Feed · 5s' : 'Live Rover Feed · Paused';
    button.lastElementChild.textContent = state.polling ? 'Pause' : 'Resume';
    if (state.polling) refreshDashboard(true);
  });
  $('#sync-now').addEventListener('click', () => runSync($('#zone-input').value.trim()));
  $('#zone-sync-form').addEventListener('submit', (event) => { event.preventDefault(); runSync($('#zone-input').value.trim()); });
  $$('#quick-zones button').forEach((button) => button.addEventListener('click', () => {
    $('#zone-input').value = button.dataset.zone ?? '';
    $$('#quick-zones button').forEach((item) => item.classList.toggle('is-active', item === button));
  }));
  $$('#map-filters [data-map-filter]').forEach((button) => button.addEventListener('click', () => setMapFilter(button.dataset.mapFilter ?? 'all')));
  $('#claim-search').addEventListener('input', renderClaims);
  $('#authority-filter').addEventListener('change', renderClaims);
  $('#open-simulator').addEventListener('click', () => $('#simulator-modal').showModal());
  $$('[data-close-modal]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.closeModal)?.close()));
  $$('#simulator-presets button').forEach((button) => button.addEventListener('click', () => applyPreset(button.dataset.preset)));
  $('#simulator-form').addEventListener('submit', submitSimulation);
  $('#audit-feed').addEventListener('click', (event) => {
    const lightbox = event.target.closest('[data-lightbox]');
    if (lightbox) { $('#lightbox-image').src = lightbox.dataset.lightbox; $('#lightbox-modal').showModal(); return; }
    const copy = event.target.closest('[data-action="copy"]');
    if (copy) { copyGrievance(copy.dataset.id, copy); return; }
    const card = event.target.closest('.audit-card');
    if (card && !event.target.closest('a,button,summary,details')) openAuditOnMap(card.dataset.auditId);
  });
  $('#audit-feed').addEventListener('keydown', (event) => { if (event.key === 'Enter' && event.target.classList.contains('audit-card')) openAuditOnMap(event.target.dataset.auditId); });
}

async function boot() {
  initMap();
  bindEvents();
  $('#rover-key').value = sessionStorage.getItem('sadaksatya-rover-key') ?? '';
  applyPreset('sitapura');
  await refreshDashboard(true);
  state.interval = window.setInterval(() => { if (state.polling) refreshDashboard(false); }, 5000);
}

boot();
