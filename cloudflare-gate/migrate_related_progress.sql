-- Related progress / one-shot callback token (not a user-managed secret)
ALTER TABLE progress ADD COLUMN related_token TEXT DEFAULT '';
ALTER TABLE progress ADD COLUMN related_progress REAL DEFAULT 0;
ALTER TABLE progress ADD COLUMN related_detail TEXT DEFAULT '';
