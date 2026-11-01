CREATE TABLE ip_quota (
  ip_hash TEXT PRIMARY KEY,
  used INTEGER NOT NULL CHECK (used BETWEEN 0 AND 5)
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 24),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1))
);
CREATE INDEX messages_visible ON messages(hidden, id DESC);
-- The quota and message are one SQLite statement/transaction, including concurrent requests.
-- Deleting/hiding a message deliberately never refunds the lifetime quota.
CREATE TRIGGER messages_quota BEFORE INSERT ON messages BEGIN
  SELECT RAISE(ABORT, 'IP_QUOTA') WHERE
    COALESCE((SELECT used FROM ip_quota WHERE ip_hash = NEW.ip_hash), 0) >= 5;
  INSERT INTO ip_quota(ip_hash, used) VALUES(NEW.ip_hash, 1)
    ON CONFLICT(ip_hash) DO UPDATE SET used = used + 1;
END;
