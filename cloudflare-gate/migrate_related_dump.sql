-- Related dump (hide suggestion for a cluster parent)
CREATE TABLE IF NOT EXISTS related_dump (
  job_id TEXT NOT NULL,
  cluster_id INTEGER NOT NULL,
  suggested_product TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, cluster_id, suggested_product)
);
