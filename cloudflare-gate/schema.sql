CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  n_products INTEGER NOT NULL DEFAULT 0,
  n_clusters INTEGER NOT NULL DEFAULT 0,
  cluster_index INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS decisions (
  job_id TEXT NOT NULL,
  product_number TEXT NOT NULL,
  status TEXT NOT NULL,
  cluster_id INTEGER,
  note TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, product_number)
);

CREATE TABLE IF NOT EXISTS cluster_moves (
  job_id TEXT NOT NULL,
  product_number TEXT NOT NULL,
  cluster_id INTEGER NOT NULL,
  from_cluster_id INTEGER,
  linked_to_product TEXT,
  semantic_score REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, product_number)
);

CREATE TABLE IF NOT EXISTS progress (
  job_id TEXT PRIMARY KEY,
  clusters_completed TEXT NOT NULL DEFAULT '[]',
  parent_times TEXT NOT NULL DEFAULT '{}',
  related_status TEXT NOT NULL DEFAULT 'idle',
  related_error TEXT NOT NULL DEFAULT '',
  related_n_suggestions INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  job_id TEXT NOT NULL,
  product_number TEXT NOT NULL,
  cluster_id INTEGER NOT NULL,
  cluster_size INTEGER NOT NULL DEFAULT 0,
  position_in_cluster INTEGER NOT NULL DEFAULT 0,
  depth INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  linked_to_product TEXT NOT NULL DEFAULT '',
  score_to_parent REAL,
  PRIMARY KEY (job_id, product_number)
);

CREATE INDEX IF NOT EXISTS idx_products_job_cluster
  ON products (job_id, cluster_id, position_in_cluster);

CREATE TABLE IF NOT EXISTS semantic (
  job_id TEXT NOT NULL,
  product_number TEXT NOT NULL,
  suggested_product TEXT NOT NULL,
  suggested_cluster_id INTEGER,
  suggested_description TEXT NOT NULL DEFAULT '',
  semantic_score REAL,
  PRIMARY KEY (job_id, product_number, suggested_product)
);

CREATE TABLE IF NOT EXISTS job_meta (
  job_id TEXT PRIMARY KEY,
  cluster_order TEXT NOT NULL DEFAULT '[]'
);
