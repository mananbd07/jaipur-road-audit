export type ClaimSourceType = 'tender' | 'news' | 'official_notice';
export type ClaimedStatus = 'sanctioned' | 'in_progress' | 'claimed_fixed';
export type Severity = 'none' | 'low' | 'medium' | 'critical';
export type VerdictName =
  | 'DISCREPANCY_UNFIXED'
  | 'POST_REPAIR_FAILURE'
  | 'UNREPORTED_DAMAGE'
  | 'VERIFIED_CLEAR';

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS?: Fetcher;
  SCRAPINGDOG_API_KEY?: string;
  ROVER_API_KEY?: string;
}

export interface GovernmentClaim {
  id: number;
  source_type: ClaimSourceType;
  tender_ref: string | null;
  authority: string;
  zone_or_road: string;
  pincode: string | null;
  lat: number | null;
  lng: number | null;
  budget_inr: number;
  claimed_status: ClaimedStatus;
  source_url: string | null;
  raw_snippet: string | null;
  published_date: string | null;
  scraped_at: string;
}

export interface RoverDetection {
  id: number;
  rover_id: string;
  road_tag: string;
  pincode: string | null;
  lat: number | null;
  lng: number | null;
  pothole_count: number;
  severity: Severity;
  road_condition_score: number;
  confidence: number;
  snapshot_key: string | null;
  telemetry_json: string;
  detected_at: string;
}

export interface AuditEvaluation {
  verdict: VerdictName;
  discrepancy_score: number;
  budget_at_risk_inr: number;
  evidence_summary: string;
  grievance_draft: string;
  x_intent_url: string;
}

export interface ClaimCandidate {
  source_type: ClaimSourceType;
  tender_ref?: string | null;
  authority: string;
  zone_or_road: string;
  pincode?: string | null;
  lat?: number | null;
  lng?: number | null;
  budget_inr?: number;
  claimed_status?: ClaimedStatus;
  source_url?: string | null;
  raw_snippet?: string | null;
  published_date?: string | null;
}

export interface TenderSearchResult {
  url: string;
  title: string;
  snippet: string;
  candidate?: ClaimCandidate;
}

export interface NewsSearchResult extends ClaimCandidate {
  headline: string;
}

export interface ScrapingDogResponse<T> {
  live_mode: boolean;
  data: T;
}
