const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const dbPath = path.resolve(__dirname, "bot_data.db");
const db = new sqlite3.Database(dbPath, err => {
  if (err) {
    console.error("Database connection error:", err);
  } else {
    console.log("Connected to SQLite database.");
    initTables();
  }
});

function initTables() {
  // Таблица привязок: сценарий → чат
  db.run(`
    CREATE TABLE IF NOT EXISTS scenario_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skorozvon_scenario_id INTEGER NOT NULL UNIQUE,
      skorozvon_scenario_name TEXT,
      telegram_chat_id TEXT NOT NULL,
      telegram_chat_title TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Таблица логов звонков
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

  // Таблица обычных админов
  db.run(`
    CREATE TABLE IF NOT EXISTS bot_admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL UNIQUE,
      name TEXT,
      role TEXT DEFAULT 'normal',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Таблица пользователей бота
  db.run(`
    CREATE TABLE IF NOT EXISTS bot_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL UNIQUE,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

module.exports = db;