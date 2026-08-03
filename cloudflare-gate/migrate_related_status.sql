-- Related job status (idle|queued|running|done|failed)
ALTER TABLE progress ADD COLUMN related_status TEXT DEFAULT 'idle';
ALTER TABLE progress ADD COLUMN related_error TEXT DEFAULT '';
ALTER TABLE progress ADD COLUMN related_n_suggestions INTEGER DEFAULT 0;
