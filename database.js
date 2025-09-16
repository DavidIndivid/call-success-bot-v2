// database.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'bot_data.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database.');
    initTables();
  }
});

function initTables() {
  // Таблица для привязки сценариев к чатам
  db.run(`
    CREATE TABLE IF NOT EXISTS scenario_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skorozvon_scenario_id INTEGER NOT NULL UNIQUE,
      skorozvon_scenario_name TEXT,
      telegram_chat_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Таблица для администраторов
  db.run(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL UNIQUE,
      username TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Таблица для лога звонков
  db.run(`
    CREATE TABLE IF NOT EXISTS call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id INTEGER NOT NULL UNIQUE,
      scenario_id INTEGER,
      result_name TEXT,
      manager_name TEXT,
      phone TEXT,
      comment TEXT,
      started_at DATETIME,
      processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      telegram_chat_id_sent TEXT
    )
  `);
}

module.exports = db;