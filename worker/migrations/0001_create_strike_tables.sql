CREATE TABLE IF NOT EXISTS strikes (
  id TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  timestamp TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  source_date TEXT,
  raw_json TEXT NOT NULL,
  inserted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_strikes_timestamp_ms
  ON strikes (timestamp_ms DESC);

CREATE INDEX IF NOT EXISTS idx_strikes_lat_lon
  ON strikes (lat, lon);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reason TEXT,
  upstream_count INTEGER NOT NULL DEFAULT 0,
  stored_count INTEGER NOT NULL DEFAULT 0,
  latest_timestamp_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ingest_runs_ran_at
  ON ingest_runs (ran_at DESC);
