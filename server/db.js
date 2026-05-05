// Picks PostgreSQL (production) or SQLite (local dev) based on env
module.exports = process.env.DATABASE_URL
  ? require('./db-postgres')
  : require('./db-sqlite');
