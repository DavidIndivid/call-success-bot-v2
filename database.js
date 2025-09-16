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

  // Administrators table
  db.run(`
    CREATE TABLE IF NOT EXISTS administrators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL UNIQUE,
      username TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// Database functions for administrators
function addAdministrator(userId, username) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO administrators (telegram_user_id, username) VALUES (?, ?)`,
      [userId, username],
      function(err) {
        if (err) reject(err);
        resolve({ id: this.lastID, changes: this.changes });
      }
    );
  });
}

function removeAdministrator(userId) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM administrators WHERE telegram_user_id = ?`,
      [userId],
      function(err) {
        if (err) reject(err);
        resolve({ changes: this.changes });
      }
    );
  });
}

function listAdministrators() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM administrators`, [], (err, rows) => {
      if (err) reject(err);
      resolve(rows);
    });
  });
}

function isAdministrator(userId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT 1 FROM administrators WHERE telegram_user_id = ?`,
      [userId],
      (err, row) => {
        if (err) reject(err);
        resolve(!!row);
      }
    );
  });
}

module.exports = {
  db,
  addAdministrator,
  removeAdministrator,
  listAdministrators,
  isAdministrator,
  // Existing functions
  getChatIdForScenario: function(scenarioId) {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT telegram_chat_id FROM scenario_mappings WHERE skorozvon_scenario_id = ?`,
        [scenarioId],
        (err, row) => {
          if (err) reject(err);
          resolve(row ? row.telegram_chat_id : null);
        }
      );
    });
  },
  addScenarioMapping: function(scenarioId, scenarioName, chatId, chatTitle) {
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT OR REPLACE INTO scenario_mappings 
         (skorozvon_scenario_id, skorozvon_scenario_name, telegram_chat_id, telegram_chat_title) 
         VALUES (?, ?, ?, ?)`,
        [scenarioId, scenarioName, chatId, chatTitle],
        function (err) {
          if (err) reject(err);
          resolve({ id: this.lastID, changes: this.changes });
        }
      );
    });
  },
  listScenarioMappings: function() {
    return new Promise((resolve, reject) => {
      db.all(`SELECT * FROM scenario_mappings`, [], (err, rows) => {
        if (err) reject(err);
        resolve(rows);
      });
    });
  }
};