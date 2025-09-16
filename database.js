// database.js
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
  // Bindings: scenario → chat
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

  // Call logs
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