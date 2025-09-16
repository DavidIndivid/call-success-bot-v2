require("dotenv").config();
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const { Telegraf, Markup } = require("telegraf");
const db = require("./database.js");

const app = express();
const PORT = process.env.PORT || 3000;

const SUCCESSFUL_RESULT_NAMES = process.env.SUCCESSFUL_RESULT_NAMES
  ? process.env.SUCCESSFUL_RESULT_NAMES.split(",")
  : ["Горячий", "Горячая", "Hot", "Успех"];

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const MAIN_ADMIN_IDS = process.env.MAIN_ADMIN_IDS
  ? process.env.MAIN_ADMIN_IDS.split(",").map((id) => id.trim())
  : [];

app.use(express.json());

const processedCallIds = new Set();
let availableScenarios = [];
let availableChats = [];

// ===== Database functions =====
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

function isUserAdmin(telegramUserId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT 1 FROM admin_users WHERE telegram_user_id = ?`,
      [telegramUserId],
      (err, row) => {
        if (err) reject(err);
        resolve(!!row);
      }
    );
  });
}

function addAdmin(userId, username) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO admin_users (telegram_user_id, username) VALUES (?, ?)`,
      [userId, username],
      function (err) {
        if (err) reject(err);
        resolve({ id: this.lastID, changes: this.changes });
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
      `INSERT OR REPLACE INTO scenario_mappings (skorozvon_scenario_id, skorozvon_scenario_name, telegram_chat_id, telegram_chat_title) VALUES (?, ?, ?, ?)`,
      [scenarioId, scenarioName, chatId, chatTitle],
      function (err) {
        if (err) reject(err);
        resolve({ id: this.lastID, changes: this.changes });
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
    `INSERT OR IGNORE INTO call_logs (call_id, scenario_id, result_name, manager_name, phone, comment, started_at, telegram_chat_id_sent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

// ===== Skorozvon API =====
async function getAccessToken() {
  try {
    const response = await axios({
      method: "post",
      url: "https://api.skorozvon.ru/oauth/token",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      data: new URLSearchParams({
        grant_type: "password",
        username: process.env.SKOROZVON_USERNAME,
        api_key: process.env.SKOROZVON_API_KEY,
        client_id: process.env.SKOROZVON_CLIENT_ID,
        client_secret: process.env.SKOROZVON_CLIENT_SECRET,
      }),
    });
    return response.data.access_token;
  } catch (error) {
    console.error("Token error:", error.response?.data || error.message);
    return null;
  }
}

async function fetchScenariosFromSkorozvon() {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return [];

    const response = await axios.get(
      "https://api.skorozvon.ru/api/v2/scenarios",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (response.data && response.data.data) {
      return response.data.data.map((s) => ({
        id: s.id,
        name: s.name,
      }));
    }
    return [];
  } catch (error) {
    console.error("Error fetching scenarios:", error.response?.data || error.message);
    return [];
  }
}

async function refreshScenariosCache() {
  availableScenarios = await fetchScenariosFromSkorozvon();
  console.log(`Refreshed scenarios: ${availableScenarios.length}`);
}

// ===== Telegram bot =====
const bot = new Telegraf(TG_BOT_TOKEN);

bot.start(async (ctx) => {
  const userId = ctx.from.id.toString();
  if (MAIN_ADMIN_IDS.includes(userId)) {
    await addAdmin(userId, ctx.from.username || "main_admin");
    ctx.reply(
      "✅ You are the MAIN ADMIN.\n\nUse /setup to link scenarios."
    );
  } else {
    ctx.reply("🚫 Access denied. Contact the main admin.");
  }
});

bot.command("admins", async (ctx) => {
  if (!MAIN_ADMIN_IDS.includes(ctx.from.id.toString())) {
    return ctx.reply("🚫 Only main admins can manage admins.");
  }

  const admins = await listAdmins();
  if (admins.length === 0) return ctx.reply("ℹ️ No admins yet.");
  ctx.reply(
    "👥 Current admins:\n\n" +
      admins
        .map((a) => `• @${a.username || "unknown"} (ID: ${a.telegram_user_id})`)
        .join("\n")
  );
});

// ===== Skorozvon webhook =====
app.post("/webhook", async (req, res) => {
  const call = req.body?.call || {};
  const callId = call.id;
  const resultName = req.body?.call_result?.result_name;
  const scenarioId = call.scenario_id;

  if (!scenarioId || !callId) return res.sendStatus(200);

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

  const managerName = call.user?.name || "Не указан";
  const phone = call.phone || "Не указан";
  const comment = req.body?.call_result?.comment || "нет комментария";
  const startedAt = call.started_at || null;
  const formattedDate = startedAt
    ? new Date(startedAt).toLocaleDateString("ru-RU")
    : new Date().toLocaleDateString("ru-RU");

  const message = `✅ ПОТЕНЦИАЛЬНЫЙ КЛИЕНТ 

👤 Менеджер: ${managerName}
📞 Телефон: ${phone}
🎯 Результат: ${resultName}
💬 Комментарий: ${comment}

Дата: ${formattedDate}
ID звонка: ${callId}`;

  await new Promise((r) => setTimeout(r, 120000));

  let audioSent = false;
  try {
    const token = await getAccessToken();
    if (token) {
      const recordingUrl = `https://api.skorozvon.ru/api/v2/calls/${callId}.mp3?access_token=${token}`;
      const audioResp = await axios.get(recordingUrl, { responseType: "stream" });

      const form = new FormData();
      form.append("chat_id", targetChatId);
      form.append("audio", audioResp.data);
      form.append("caption", message);
      form.append("parse_mode", "HTML");

      await axios.post(
        `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendAudio`,
        form,
        { headers: form.getHeaders() }
      );

      audioSent = true;
    }
  } catch (e) {
    console.error("Audio error:", e.message);
  }

  if (!audioSent) {
    await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      chat_id: targetChatId,
      text: message + "\n\n❌ Запись недоступна.",
      parse_mode: "HTML",
    });
  }

  logCall({ callId, scenarioId, resultName, managerName, phone, comment, startedAt }, targetChatId);

  res.sendStatus(200);
});

// ===== Webhook binding =====
app.use(bot.webhookCallback(`/bot${TG_BOT_TOKEN}`));
bot.telegram.setWebhook(
  `https://call-success-bot-v2-production.up.railway.app/bot${TG_BOT_TOKEN}`
);

// ===== Start =====
app.listen(PORT, () => {
  console.log(`🌐 Server listening on ${PORT}`);
  console.log(`🤖 Bot is working via webhook`);
});