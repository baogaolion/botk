import Database from 'better-sqlite3';
import { resolve } from 'path';
import { statSync, unlinkSync, mkdirSync } from 'fs';

const DB_PATH = resolve(process.cwd(), 'data', 'botk.db');
let db;

export function initDb() {
  mkdirSync(resolve(process.cwd(), 'data'), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      username TEXT,
      first_seen INTEGER NOT NULL,
      last_active INTEGER NOT NULL,
      task_count INTEGER DEFAULT 0,
      storage_bytes INTEGER DEFAULT 0,
      storage_limit INTEGER DEFAULT 52428800
    );

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      message TEXT,
      duration_ms INTEGER,
      status TEXT DEFAULT 'ok',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);

    CREATE TABLE IF NOT EXISTS allowed_users (
      user_id INTEGER PRIMARY KEY,
      added_by INTEGER,
      added_at INTEGER NOT NULL
    );
  `);

  return db;
}

export function getDb() { return db; }

// ==================== Users ====================

const _stmts = {};
function stmt(key, sql) {
  if (!_stmts[key]) _stmts[key] = db.prepare(sql);
  return _stmts[key];
}

export const userRepo = {
  upsert(userId, username) {
    const now = Date.now();
    stmt('user_upsert', `
      INSERT INTO users (user_id, username, first_seen, last_active)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username = excluded.username,
        last_active = excluded.last_active
    `).run(userId, username || null, now, now);
  },

  get(userId) {
    return stmt('user_get', 'SELECT * FROM users WHERE user_id = ?').get(userId);
  },

  incrementTaskCount(userId) {
    stmt('user_inc_task', `
      UPDATE users SET task_count = task_count + 1, last_active = ? WHERE user_id = ?
    `).run(Date.now(), userId);
  },

  updateStorage(userId) {
    const row = stmt('user_storage_sum', `
      SELECT COALESCE(SUM(size_bytes), 0) as total FROM files WHERE user_id = ?
    `).get(userId);
    stmt('user_update_storage', `
      UPDATE users SET storage_bytes = ? WHERE user_id = ?
    `).run(row.total, userId);
    return row.total;
  },

  getStats(userId) {
    const user = this.get(userId);
    if (!user) return null;
    const fileCount = stmt('user_file_count', `
      SELECT COUNT(*) as cnt FROM files WHERE user_id = ?
    `).get(userId).cnt;
    const recentTasks = stmt('user_recent_tasks', `
      SELECT COUNT(*) as cnt FROM tasks WHERE user_id = ? AND created_at > ?
    `).get(userId, Date.now() - 24 * 60 * 60 * 1000).cnt;
    return { ...user, fileCount, tasksToday: recentTasks };
  },

  deleteAllData(userId) {
    const files = stmt('user_files_list', `
      SELECT file_path FROM files WHERE user_id = ?
    `).all(userId);
    for (const f of files) {
      try { unlinkSync(f.file_path); } catch {}
    }
    const doDelete = db.transaction((uid) => {
      stmt('user_files_del', 'DELETE FROM files WHERE user_id = ?').run(uid);
      stmt('user_tasks_del', 'DELETE FROM tasks WHERE user_id = ?').run(uid);
      stmt('user_reset', `
        UPDATE users SET task_count = 0, storage_bytes = 0 WHERE user_id = ?
      `).run(uid);
    });
    doDelete(userId);
    return files.length;
  },
};

// ==================== Files ====================

export const fileRepo = {
  add(userId, fileName, filePath, sizeBytes) {
    stmt('file_add', `
      INSERT INTO files (user_id, file_name, file_path, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, fileName, filePath, sizeBytes, Date.now());
    userRepo.updateStorage(userId);
  },

  listByUser(userId) {
    return stmt('file_list', `
      SELECT * FROM files WHERE user_id = ? ORDER BY created_at DESC
    `).all(userId);
  },

  deleteByUser(userId) {
    const files = this.listByUser(userId);
    for (const f of files) {
      try { unlinkSync(f.file_path); } catch {}
    }
    stmt('file_del_user', 'DELETE FROM files WHERE user_id = ?').run(userId);
    userRepo.updateStorage(userId);
    return files.length;
  },
};

// ==================== Tasks ====================

export const taskRepo = {
  add(userId, message, durationMs, status = 'ok') {
    stmt('task_add', `
      INSERT INTO tasks (user_id, message, duration_ms, status, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, message?.slice(0, 200), durationMs, status, Date.now());
    userRepo.incrementTaskCount(userId);
  },
};

// ==================== DB Stats ====================

export function dbStats() {
  let sizeMB = 0;
  try { sizeMB = (statSync(DB_PATH).size / 1024 / 1024).toFixed(1); } catch {}
  const userCount = stmt('stats_users', 'SELECT COUNT(*) as cnt FROM users').get().cnt;
  const taskCount = stmt('stats_tasks', 'SELECT COUNT(*) as cnt FROM tasks').get().cnt;
  const fileCount = stmt('stats_files', 'SELECT COUNT(*) as cnt FROM files').get().cnt;
  return { sizeMB, userCount, taskCount, fileCount };
}

// ==================== Allowed Users ====================

export const allowRepo = {
  add(userId, addedBy) {
    stmt('allow_add', `
      INSERT OR IGNORE INTO allowed_users (user_id, added_by, added_at)
      VALUES (?, ?, ?)
    `).run(userId, addedBy, Date.now());
  },

  remove(userId) {
    stmt('allow_del', 'DELETE FROM allowed_users WHERE user_id = ?').run(userId);
  },

  has(userId) {
    return !!stmt('allow_has', 'SELECT 1 FROM allowed_users WHERE user_id = ?').get(userId);
  },

  list() {
    return stmt('allow_list', `
      SELECT a.user_id, a.added_by, a.added_at, u.username
      FROM allowed_users a LEFT JOIN users u ON a.user_id = u.user_id
      ORDER BY a.added_at DESC
    `).all();
  },
};

export function closeDb() {
  if (db) db.close();
}
