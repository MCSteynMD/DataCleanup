-- Pass number (1 = original review, 2 = children-as-parents)
ALTER TABLE jobs ADD COLUMN pass_number INTEGER DEFAULT 1;
ALTER TABLE jobs ADD COLUMN source_job_id TEXT;
