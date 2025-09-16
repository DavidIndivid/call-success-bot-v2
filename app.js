require("dotenv").config();
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const { Telegraf, Markup } = require("telegraf");
const db = require("./database.js");

const app = express();
const PORT = process.env.PORT || 3000;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;

// Load main admins from .env
const MAIN_ADMINS = process.env.MAIN_ADMINS
  ? process.env.MAIN_ADMINS.split(",").map((id) => id.trim())
  : [];

// Success result names
const SUCCESSFUL_RESULT_NAMES = process.env.SUCCESSFUL_RESULT_NAMES
  ? process.env.SUCCESSFUL_RESULT_NAMES.split(",")
  : ["Успех", "Горячий", "Горячая", "Hot"];

app.use(express.json());

// Track processed calls to avoid duplicates
const processedCallIds = new Set();

// Cache
let availableScenarios = [];
let availableChats = [];

// === DB utils ===
function getChatIdForScenario(scenarioId) {
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
}

function addAdmin(userId, username) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR IGNORE INTO admin_users (telegram_user_id, username) VALUES (?, ?)`,
      [userId, username],
      function (err) {
        if (err) reject(err);
        resolve({ changes: this.changes });
      }
    );
  });
}

function removeAdmin(userId) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM admin_users WHERE telegram_user_id = ?`,
      [userId],
      function (err) {
        if (err) reject(err);
        resolve({ changes: this.changes });
      }
    );
  });
}

function listAdmins() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM admin_users`, [], (err, rows) => {
      if (err) reject(err);
      resolve(rows);
    });
  });
}

function addScenarioMapping(scenarioId, scenarioName, chatId, chatTitle) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO scenario_mappings 
       (skorozvon_scenario_id, skorozvon_scenario_name, telegram_chat_id, telegram_chat_title) 
       VALUES (?, ?, ?, ?)`,
      [scenarioId, scenarioName, chatId, chatTitle],
      function (err) {
        if (err) reject(err);
        resolve({ changes: this.changes });
      }
    );
  });
}

function listScenarioMappings() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM scenario_mappings`, [], (err, rows) => {
      if (err) reject(err);
      resolve(rows);
    });
  });
}

function logCall(callData, targetChatId) {
  db.run(
    `INSERT OR IGNORE INTO call_logs 
     (call_id, scenario_id, result_name, manager_name, phone, comment, started_at, telegram_chat_id_sent) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      callData.callId,
      callData.scenarioId,
      callData.resultName,
      callData.managerName,
      callData.phone,
      callData.comment,
      callData.startedAt,
      targetChatId,
    ],
    (err) => {
      if (err) console.error("Error logging call:", err);
    }
  );
}

// === Roles ===
function isMainAdmin(userId) {
  return MAIN_ADMINS.includes(String(userId));
}

async function isAdmin(userId) {
  if (isMainAdmin(userId)) return true;
  const row = await new Promise((resolve) => {
    db.get(
      `SELECT 1 FROM admin_users WHERE telegram_user_id = ?`,
      [userId],
      (err, row) => resolve(row)
    );
  });
  return !!row;
}

// === Skorozvon API ===
async function getAccessToken() {
  try {
    const response = await axios.post(
      "https://api.skorozvon.ru/oauth/token",
      new URLSearchParams({
        grant_type: "password",
        username: process.env.SKOROZVON_USERNAME,
        api_key: process.env.SKOROZVON_API_KEY,
        client_id: process.env.SKOROZVON_CLIENT_ID,
        client_secret: process.env.SKOROZVON_CLIENT_SECRET,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    return response.data.access_token;
  } catch (error) {
    console.error("Token error:", error.response?.data || error.message);
    return null;
  }
}

async function fetchScenariosFromSkorozvon() {
  try {
    const token = await getAccessToken();
    if (!token) return [];

    const response = await axios.get(
      "https://api.skorozvon.ru/api/v2/scenarios",
      { headers: { Authorization: `Bearer ${token}` } }
    );

    return (
      response.data?.data?.map((s) => ({
        id: s.id,
        name: s.name,
      })) || []
    );
  } catch (e) {
    console.error("Error fetching scenarios:", e.message);
    return [];
  }
}

async function refreshScenariosCache() {
  availableScenarios = await fetchScenariosFromSkorozvon();
  console.log(`Refreshed scenarios cache: ${availableScenarios.length} found`);
}

// === Telegram bot ===
const bot = new Telegraf(TG_BOT_TOKEN);

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  if (isMainAdmin(userId)) {
    ctx.reply("👑 Welcome, Main Admin! Use /admins to manage.");
  } else if (await isAdmin(userId)) {
    ctx.reply("✅ You are an admin. Use /setup to bind scenarios.");
  } else {
    ctx.reply("❌ Access denied. Contact the main admin.");
  }
});

// Manage admins (only main admins)
bot.command("add_admin", async (ctx) => {
  if (!isMainAdmin(ctx.from.id))
    return ctx.reply("❌ Only main admins can do this.");
  const args = ctx.message.text.split(" ").slice(1);
  if (args.length === 0) return ctx.reply("Usage: /add_admin <id|@username>");

  let userId, username;
  if (args[0].startsWith("@")) {
    username = args[0].replace("@", "");
    userId = ctx.from.id; // temporary, will be updated when user talks
  } else {
    userId = args[0];
    username = "unknown";
  }

  await addAdmin(userId, username);
  ctx.reply(`✅ Admin added: ${userId}`);
  try {
    await bot.telegram.sendMessage(userId, "✅ You are now an admin!");
  } catch {}
});

bot.command("remove_admin", async (ctx) => {
  if (!isMainAdmin(ctx.from.id))
    return ctx.reply("❌ Only main admins can do this.");
  const args = ctx.message.text.split(" ").slice(1);
  if (args.length === 0) return ctx.reply("Usage: /remove_admin <id>");
  const userId = args[0];
  await removeAdmin(userId);
  ctx.reply(`✅ Admin removed: ${userId}`);
});

bot.command("list_admins", async (ctx) => {
  if (!isMainAdmin(ctx.from.id))
    return ctx.reply("❌ Only main admins can do this.");
  const admins = await listAdmins();
  const text = admins
    .map((a) => `👤 ${a.username || "unknown"} (ID: ${a.telegram_user_id})`)
    .join("\n");
  ctx.reply(`Admins:\n\n${text}`);
});

// === Webhook handler ===
app.post("/webhook", async (req, res) => {
  const callId = req.body?.call?.id;
  const resultName = req.body?.call_result?.result_name;
  const scenarioId = req.body?.call?.scenario_id;

  if (!callId || !scenarioId) return res.sendStatus(200);
  if (processedCallIds.has(callId)) return res.sendStatus(200);

  processedCallIds.add(callId);
  setTimeout(() => processedCallIds.delete(callId), 24 * 60 * 60 * 1000);

  const isSuccessful =
    resultName &&
    SUCCESSFUL_RESULT_NAMES.some((n) =>
      resultName.toLowerCase().includes(n.toLowerCase())
    );

  if (!isSuccessful) return res.sendStatus(200);

  const targetChatId = await getChatIdForScenario(scenarioId);
  if (!targetChatId) return res.sendStatus(200);

  const manager = req.body?.call?.user?.name || "Не указан";
  const phone = req.body?.call?.phone || "Не указан";
  const comment = req.body?.call_result?.comment || "нет комментария";
  const startedAt = req.body?.call?.started_at;
  const formattedDate = new Date(startedAt || Date.now()).toLocaleDateString(
    "ru-RU"
  );

  const message = `
  ✅ ПОТЕНЦИАЛЬНЫЙ КЛИЕНТ 

👤 Менеджер: ${manager}
📞 Телефон: ${phone}
🎯 Результат: ${resultName}
💬 Комментарий: ${comment}

Дата: ${formattedDate}
ID звонка: ${callId}`;

  await new Promise((r) => setTimeout(r, 120000));

  const sent = await sendAudioToTelegram(callId, message, targetChatId);
  logCall(
    { callId, scenarioId, resultName, manager, phone, comment, startedAt },
    targetChatId
  );

  if (!sent) {
    await bot.telegram.sendMessage(
      targetChatId,
      message + "\n\n❌ Запись недоступна."
    );
  }

  res.sendStatus(200);
});

async function sendAudioToTelegram(callId, caption, chatId) {
  try {
    const token = await getAccessToken();
    if (!token) return false;

    const url = `https://api.skorozvon.ru/api/v2/calls/${callId}.mp3?access_token=${token}`;
    const audio = await axios.get(url, {
      responseType: "stream",
      timeout: 30000,
    });

    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("audio", audio.data);
    form.append("caption", caption);
    form.append("parse_mode", "HTML");

    await axios.post(
      `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendAudio`,
      form,
      {
        headers: form.getHeaders(),
      }
    );
    return true;
  } catch (e) {
    console.error("Audio send error:", e.message);
    return false;
  }
}

// Start bot & server
bot.launch().then(() => {
  console.log("🤖 Bot launched");
  refreshScenariosCache();
});
app.listen(PORT, () => console.log(`🌐 Server listening on ${PORT}`));
