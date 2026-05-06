// Local dev fallback — uses Node.js 22 built-in SQLite, no installation needed
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'camera.db'));

async function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gps_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      accuracy REAL,
      timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      lat REAL,
      lng REAL
    );
  `);
  // Migrations for existing databases
  try { db.exec('ALTER TABLE recordings ADD COLUMN lat REAL'); } catch {}
  try { db.exec('ALTER TABLE recordings ADD COLUMN lng REAL'); } catch {}
}

async function saveGpsPoint(roomId, lat, lng, accuracy, timestamp) {
  db.prepare(
    'INSERT INTO gps_history (room_id, lat, lng, accuracy, timestamp) VALUES (?, ?, ?, ?, ?)'
  ).run(roomId, lat, lng, accuracy, timestamp);
}

async function getGpsHistory(roomId, limit = 2000) {
  return db.prepare(
    'SELECT * FROM gps_history WHERE room_id = ? ORDER BY timestamp DESC LIMIT ?'
  ).all(roomId, limit);
}

async function saveRecording(roomId, filename, timestamp, lat, lng) {
  db.prepare(
    'INSERT INTO recordings (room_id, filename, timestamp, lat, lng) VALUES (?, ?, ?, ?, ?)'
  ).run(roomId, filename, timestamp, lat ?? null, lng ?? null);
}

async function getRecordings(roomId) {
  return db.prepare(
    'SELECT * FROM recordings WHERE room_id = ? ORDER BY timestamp DESC'
  ).all(roomId);
}

async function getExpiredRecordings(cutoff) {
  return db.prepare('SELECT * FROM recordings WHERE timestamp < ?').all(cutoff);
}

async function deleteExpiredRecordings(cutoff) {
  db.prepare('DELETE FROM recordings WHERE timestamp < ?').run(cutoff);
}

async function deleteExpiredGps(cutoff) {
  db.prepare('DELETE FROM gps_history WHERE timestamp < ?').run(cutoff);
}

module.exports = { initDb, saveGpsPoint, getGpsHistory, saveRecording, getRecordings, getExpiredRecordings, deleteExpiredRecordings, deleteExpiredGps };
