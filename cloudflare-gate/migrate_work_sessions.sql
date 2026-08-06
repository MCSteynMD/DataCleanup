-- Login/logout timesheet sessions (local + UTC stamps)
CREATE TABLE IF NOT EXISTS work_sessions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  login_local TEXT NOT NULL,
  login_utc TEXT NOT NULL,
  logout_local TEXT,
  logout_utc TEXT,
  tz_offset_min INTEGER,
  tz_name TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_work_sessions_email_login
  ON work_sessions (email, login_utc);
