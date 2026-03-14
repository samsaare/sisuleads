CREATE TABLE IF NOT EXISTS campaigns (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  persona_config TEXT DEFAULT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id                  TEXT PRIMARY KEY,
  campaign_id         TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  company_name        TEXT NOT NULL,
  domain              TEXT NOT NULL,
  contact_name        TEXT NOT NULL DEFAULT '',
  contact_title       TEXT NOT NULL DEFAULT '',
  contact_email       TEXT NOT NULL DEFAULT '',
  contact_phone       TEXT NOT NULL DEFAULT '',
  extraction_comment  TEXT NOT NULL DEFAULT '',
  found               INTEGER NOT NULL DEFAULT 0,
  is_generic_contact  INTEGER NOT NULL DEFAULT 0,
  source_url          TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'pending',
  status_message      TEXT NOT NULL DEFAULT '',
  error_message       TEXT NOT NULL DEFAULT '',
  retry_count         INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_leads_status   ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_domain   ON leads(domain);

CREATE TABLE IF NOT EXISTS lead_logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id   TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  timestamp INTEGER NOT NULL,
  message   TEXT NOT NULL,
  level     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_lead ON lead_logs(lead_id);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
