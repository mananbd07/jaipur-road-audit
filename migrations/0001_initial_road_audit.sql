PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS gov_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL CHECK(source_type IN ('tender','news','official_notice')),
  tender_ref TEXT UNIQUE,
  authority TEXT NOT NULL,
  zone_or_road TEXT NOT NULL,
  pincode TEXT,
  lat REAL,
  lng REAL,
  budget_inr INTEGER NOT NULL DEFAULT 0,
  claimed_status TEXT NOT NULL DEFAULT 'sanctioned' CHECK(claimed_status IN ('sanctioned','in_progress','claimed_fixed')),
  source_url TEXT,
  raw_snippet TEXT,
  published_date TEXT,
  scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rover_detections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rover_id TEXT NOT NULL DEFAULT 'thinkcentre-rover-01',
  road_tag TEXT NOT NULL,
  pincode TEXT,
  lat REAL,
  lng REAL,
  pothole_count INTEGER NOT NULL DEFAULT 0,
  severity TEXT NOT NULL CHECK(severity IN ('none','low','medium','critical')),
  road_condition_score INTEGER NOT NULL CHECK(road_condition_score BETWEEN 0 AND 100),
  confidence REAL NOT NULL DEFAULT 0.0,
  snapshot_key TEXT,
  telemetry_json TEXT NOT NULL DEFAULT '{}',
  detected_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  detection_id INTEGER NOT NULL REFERENCES rover_detections(id) ON DELETE CASCADE,
  claim_id INTEGER REFERENCES gov_claims(id) ON DELETE SET NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('DISCREPANCY_UNFIXED','POST_REPAIR_FAILURE','UNREPORTED_DAMAGE','VERIFIED_CLEAR')),
  discrepancy_score INTEGER NOT NULL DEFAULT 0 CHECK(discrepancy_score BETWEEN 0 AND 100),
  budget_at_risk_inr INTEGER NOT NULL DEFAULT 0,
  evidence_summary TEXT NOT NULL,
  grievance_draft TEXT NOT NULL,
  x_intent_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL,
  query_or_url TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('live_scrapingdog','demo_fallback')),
  http_status INTEGER NOT NULL,
  credits_estimated INTEGER NOT NULL DEFAULT 0,
  records_found INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gov_claims_pincode ON gov_claims(pincode);
CREATE INDEX IF NOT EXISTS idx_gov_claims_authority ON gov_claims(authority);
CREATE INDEX IF NOT EXISTS idx_rover_detections_detected_at ON rover_detections(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_verdicts_verdict_created_at ON audit_verdicts(verdict, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scrape_runs_created_at ON scrape_runs(created_at DESC);
