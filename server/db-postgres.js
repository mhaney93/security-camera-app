// Production — uses PostgreSQL (e.g. Render free tier)
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gps_history (
      id SERIAL PRIMARY KEY,
      room_id TEXT NOT NULL,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      accuracy DOUBLE PRECISION,
      timestamp BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recordings (
      id SERIAL PRIMARY KEY,
      room_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      timestamp BIGINT NOT NULL,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION
    );
  `);
  // Migrations for existing databases
  await pool.query('ALTER TABLE recordings ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION').catch(() => {});
  await pool.query('ALTER TABLE recordings ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION').catch(() => {});
}

async function saveGpsPoint(roomId, lat, lng, accuracy, timestamp) {
  await pool.query(
    'INSERT INTO gps_history (room_id, lat, lng, accuracy, timestamp) VALUES ($1,$2,$3,$4,$5)',
    [roomId, lat, lng, accuracy, timestamp]
  );
}

async function getGpsHistory(roomId, limit = 2000) {
  const { rows } = await pool.query(
    'SELECT * FROM gps_history WHERE room_id = $1 ORDER BY timestamp DESC LIMIT $2',
    [roomId, limit]
  );
  return rows;
}

async function saveRecording(roomId, filename, timestamp, lat, lng) {
  await pool.query(
    'INSERT INTO recordings (room_id, filename, timestamp, lat, lng) VALUES ($1,$2,$3,$4,$5)',
    [roomId, filename, timestamp, lat ?? null, lng ?? null]
  );
}

async function getRecordings(roomId) {
  const { rows } = await pool.query(
    'SELECT * FROM recordings WHERE room_id = $1 ORDER BY timestamp DESC',
    [roomId]
  );
  return rows;
}

async function getExpiredRecordings(cutoff) {
  const { rows } = await pool.query('SELECT * FROM recordings WHERE timestamp < $1', [cutoff]);
  return rows;
}

async function deleteExpiredRecordings(cutoff) {
  await pool.query('DELETE FROM recordings WHERE timestamp < $1', [cutoff]);
}

async function deleteExpiredGps(cutoff) {
  await pool.query('DELETE FROM gps_history WHERE timestamp < $1', [cutoff]);
}

module.exports = { initDb, saveGpsPoint, getGpsHistory, saveRecording, getRecordings, getExpiredRecordings, deleteExpiredRecordings, deleteExpiredGps };
