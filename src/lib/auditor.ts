import type { AuditEvaluation, GovernmentClaim, RoverDetection } from '../types';

const STOP_WORDS = new Set([
  'road', 'roads', 'area', 'zone', 'ward', 'near', 'and', 'the', 'to', 'of',
  'jaipur', 'repair', 'industrial', 'service', 'lane', 'sector', 'new',
]);

function normalizedTokens(value: string): Set<string> {
  return new Set(
    value.toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length > 2 && !STOP_WORDS.has(token)) ?? [],
  );
}

function hasTokenOverlap(a: string, b: string): boolean {
  const left = normalizedTokens(a);
  const right = normalizedTokens(b);
  for (const token of left) if (right.has(token)) return true;
  return false;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const radiusKm = 6371;
  const dLat = radians(lat2 - lat1);
  const dLng = radians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLng / 2) ** 2;
  return radiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function newestOrLargest(claims: GovernmentClaim[]): GovernmentClaim | null {
  return [...claims].sort(
    (a, b) => b.budget_inr - a.budget_inr || b.scraped_at.localeCompare(a.scraped_at),
  )[0] ?? null;
}

export function matchClaimForDetection(
  detection: RoverDetection,
  claims: GovernmentClaim[],
): GovernmentClaim | null {
  const pincodeRoadMatches = claims.filter(
    (claim) =>
      Boolean(detection.pincode) &&
      detection.pincode === claim.pincode &&
      hasTokenOverlap(detection.road_tag, claim.zone_or_road),
  );
  if (pincodeRoadMatches.length) return newestOrLargest(pincodeRoadMatches);

  if (detection.lat !== null && detection.lng !== null) {
    const nearby = claims
      .filter((claim) => claim.lat !== null && claim.lng !== null)
      .map((claim) => ({
        claim,
        distance: haversineKm(detection.lat as number, detection.lng as number, claim.lat as number, claim.lng as number),
      }))
      .filter(({ distance }) => distance <= 2.5)
      .sort((a, b) => a.distance - b.distance || b.claim.budget_inr - a.claim.budget_inr);
    if (nearby.length) return nearby[0].claim;
  }

  if (detection.pincode) {
    return newestOrLargest(claims.filter((claim) => claim.pincode === detection.pincode));
  }
  return null;
}

export function formatInr(amount: number): string {
  if (amount >= 10_000_000) return `₹${(amount / 10_000_000).toFixed(2).replace(/\.00$/, '')} Cr`;
  if (amount >= 100_000) return `₹${(amount / 100_000).toFixed(2).replace(/\.00$/, '')} Lakh`;
  return `₹${new Intl.NumberFormat('en-IN').format(amount)}`;
}

function departmentHandle(authority?: string): string {
  const normalized = authority?.toLowerCase() ?? '';
  if (normalized.includes('nagar')) return '@jaipurnagarnig';
  if (normalized.includes('pwd')) return '@PWD_Rajasthan';
  return '@JaipurJDA';
}

function accountabilityKit(
  detection: RoverDetection,
  claim: GovernmentClaim | null,
  verdict: AuditEvaluation['verdict'],
  score: number,
  atRisk: number,
): Omit<AuditEvaluation, 'verdict' | 'discrepancy_score' | 'budget_at_risk_inr'> {
  const authority = claim?.authority ?? 'the responsible Jaipur road authority';
  const tender = claim?.tender_ref ? ` Tender Ref ${claim.tender_ref}` : '';
  const budget = claim ? ` The associated allocation is ${formatInr(claim.budget_inr)}.` : '';
  const status = claim ? ` Its recorded status is ${claim.claimed_status.replace('_', ' ')}.` : '';
  const evidenceSummary = verdict === 'VERIFIED_CLEAR'
    ? `Rover inspection found no potholes and a road-condition score of ${detection.road_condition_score}/100 at ${detection.road_tag}. No active repair discrepancy was observed.`
    : `Rover inspection found ${detection.pothole_count} pothole(s) and a road-condition score of ${detection.road_condition_score}/100 at ${detection.road_tag}.${tender} is linked to ${authority}.${status}${budget}`;
  const gps = detection.lat !== null && detection.lng !== null ? `${detection.lat}, ${detection.lng}` : 'GPS not supplied';
  const grievanceDraft = [
    `To: ${authority}`,
    'Subject: Road-audit grievance requiring inspection and repair action',
    '',
    `I request an on-site inspection of ${detection.road_tag}${detection.pincode ? `, PIN ${detection.pincode}` : ''}.`,
    `Rover evidence recorded ${detection.pothole_count} pothole(s), condition score ${detection.road_condition_score}/100, severity ${detection.severity}, at ${gps} on ${detection.detected_at}.`,
    claim ? `Relevant claim: ${claim.tender_ref ?? 'no tender reference'}; recorded status: ${claim.claimed_status}; allocated amount: ${formatInr(claim.budget_inr)}.` : 'No matching public repair claim was located in this audit dataset.',
    `Audit verdict: ${verdict} (discrepancy score ${score}/100; budget at risk ${formatInr(atRisk)}).`,
    'Please register this on Rajasthan Sampark (sampark.rajasthan.gov.in), share an action timeline, and where applicable update the PWD Sugam Path record with photographic proof of repair.',
  ].join('\n');
  const tweet = `${departmentHandle(claim?.authority)} Road audit: ${verdict} at ${detection.road_tag}. ${detection.pothole_count} pothole(s), score ${detection.road_condition_score}/100.${claim?.tender_ref ? ` Tender ${claim.tender_ref}.` : ''} #JaipurRoads #RoadAudit`;
  return {
    evidence_summary: evidenceSummary,
    grievance_draft: grievanceDraft,
    x_intent_url: `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweet)}`,
  };
}

export function evaluateDetectionAgainstClaims(
  detection: RoverDetection,
  claims: GovernmentClaim[],
): { matched_claim: GovernmentClaim | null; evaluation: AuditEvaluation } {
  const matchedClaim = matchClaimForDetection(detection, claims);
  let verdict: AuditEvaluation['verdict'];
  let discrepancyScore: number;
  let budgetAtRisk: number;

  if (detection.pothole_count === 0 && detection.road_condition_score >= 80) {
    verdict = 'VERIFIED_CLEAR';
    discrepancyScore = 0;
    budgetAtRisk = 0;
  } else if (matchedClaim?.claimed_status === 'claimed_fixed' && detection.pothole_count > 0) {
    verdict = 'POST_REPAIR_FAILURE';
    discrepancyScore = Math.min(100, 60 + detection.pothole_count * 10);
    budgetAtRisk = matchedClaim.budget_inr;
  } else if (matchedClaim && detection.pothole_count > 0) {
    verdict = 'DISCREPANCY_UNFIXED';
    discrepancyScore = Math.min(100, 50 + detection.pothole_count * 10);
    budgetAtRisk = matchedClaim.budget_inr;
  } else {
    verdict = 'UNREPORTED_DAMAGE';
    discrepancyScore = Math.min(100, 35 + Math.max(0, detection.pothole_count) * 10);
    budgetAtRisk = 0;
  }

  return {
    matched_claim: matchedClaim,
    evaluation: {
      verdict,
      discrepancy_score: discrepancyScore,
      budget_at_risk_inr: budgetAtRisk,
      ...accountabilityKit(detection, matchedClaim, verdict, discrepancyScore, budgetAtRisk),
    },
  };
}
