-- Existing DBs: add parent_times for per-cluster review timing
ALTER TABLE progress ADD COLUMN parent_times TEXT DEFAULT '{}';
