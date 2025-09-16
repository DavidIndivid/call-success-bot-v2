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
const MAIN_ADMINS = process.env.MAIN_ADMINS
  ? process.env.MAIN_ADMINS.split(",").map(id => id.trim())
  : [];

app.use(express.json());

const processedCallIds = new Set();
let availableScenarios = [];
let availableChats = [];

/* ================= DB Functions ================= */
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

function addScenarioMapping(scenarioId, scenarioName, chatId, chatTitle) {
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
}

function listScenarioMappings() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM scenario_mappings`, [], (err, rows) => {
      if (err) reject(err);
      resolve(rows);
    });
  });
}

/* ================= Skorozvon API ================= */
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
    const accessToken = await getAccessToken();
    if (!accessToken) return [];

    const response = await axios.get(
      "https://api.skorozvon.ru/api/v2/scenarios",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    return response.data?.data?.map(s => ({
      id: s.id,
      name: s.name,
      system: s.system,
    })) || [];
  } catch (error) {
    console.error("Fetch scenarios error:", error.response?.data || error.message);
    return [];
  }
}

async function refreshScenariosCache() {
  availableScenarios = await fetchScenariosFromSkorozvon();
  console.log(`Scenarios refreshed: ${availableScenarios.length}`);
}

/* ================= Telegram Bot ================= */
const bot = new Telegraf(TG_BOT_TOKEN);

async function updateAvailableChats(ctx) {
  if (ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
    const chatId = ctx.chat.id;
    const chatTitle = ctx.chat.title || `Chat ${chatId}`;

    const existingChat = availableChats.find(c => c.id === chatId);
    if (!existingChat) {
      availableChats.push({
        id: chatId,
        title: chatTitle,
        type: ctx.chat.type,
        updatedAt: new Date(),
      });
      console.log(`Added chat: ${chatTitle} (${chatId})`);
    }
  }
}

async function sendAudioToTelegram(callId, caption, targetChatId) {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return false;

    const recordingUrl = `https://api.skorozvon.ru/api/v2/calls/${callId}.mp3?access_token=${accessToken}`;
    const audioResponse = await axios.get(recordingUrl, { responseType: "stream" });

    const formData = new FormData();
    formData.append("chat_id", targetChatId);
    formData.append("audio", audioResponse.data);
    formData.append("caption", caption);
    formData.append("parse_mode", "HTML");

    await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendAudio`, formData, {
      headers: formData.getHeaders(),
    });

    return true;
  } catch (error) {
    console.error("Send audio error:", error.message);
    return false;
  }
}

/* ================= Bot Commands ================= */
bot.start(async ctx => {
  const userId = ctx.from.id.toString();
  if (MAIN_ADMINS.includes(userId)) {
    ctx.reply(
      "🤖 Bot for processing Skorozvon calls.\n\n" +
      "/setup - Bind scenarios\n" +
      "/list - Show bindings\n" +
      "/refresh - Refresh scenarios\n" +
      "/chats - Show available chats"
    );
  } else {
    ctx.reply("❌ Access denied. Contact the main admin.");
  }
});

bot.command("setup", async ctx => {
  if (!MAIN_ADMINS.includes(ctx.from.id.toString())) return ctx.reply("❌ No rights.");
  if (availableScenarios.length === 0) await refreshScenariosCache();
  if (availableScenarios.length === 0) return ctx.reply("❌ No scenarios loaded.");
  if (availableChats.length === 0) return ctx.reply("❌ No chats available.");

  ctx.reply(
    "Select scenario:",
    Markup.inlineKeyboard(
      availableScenarios.map(s => [Markup.button.callback(s.name, `select_scenario_${s.id}`)]),
      { columns: 1 }
    )
  );
});

bot.action(/select_scenario_(\d+)/, async ctx => {
  const scenarioId = ctx.match[1];
  const scenario = availableScenarios.find(s => s.id == scenarioId);
  ctx.reply(
    `Scenario: ${scenario.name}\n\nSelect group:`,
    Markup.inlineKeyboard(
      availableChats.map(c => [Markup.button.callback(c.title, `select_chat_${scenarioId}_${c.id}`)]),
      { columns: 1 }
    )
  );
});

bot.action(/select_chat_(\d+)_(-?\d+)/, async ctx => {
  const scenarioId = ctx.match[1];
  const chatId = ctx.match[2];
  const scenario = availableScenarios.find(s => s.id == scenarioId);
  const chat = availableChats.find(c => c.id == chatId);
  await addScenarioMapping(scenarioId, scenario.name, chatId, chat.title);
  ctx.editMessageText(`✅ Scenario "${scenario.name}" bound to "${chat.title}".`);
});

bot.command("list", async ctx => {
  if (!MAIN_ADMINS.includes(ctx.from.id.toString())) return ctx.reply("❌ No rights.");
  const mappings = await listScenarioMappings();
  if (mappings.length === 0) return ctx.reply("ℹ️ No bindings set.");
  ctx.reply(mappings.map(m => `📋 ${m.skorozvon_scenario_name} → ${m.telegram_chat_title}`).join("\n\n"));
});

bot.command("refresh", async ctx => {
  if (!MAIN_ADMINS.includes(ctx.from.id.toString())) return ctx.reply("❌ No rights.");
  await refreshScenariosCache();
  ctx.reply(`✅ Loaded ${availableScenarios.length} scenarios.`);
});

bot.command("chats", async ctx => {
  if (!MAIN_ADMINS.includes(ctx.from.id.toString())) return ctx.reply("❌ No rights.");
  if (availableChats.length === 0) return ctx.reply("ℹ️ No chats available.");
  ctx.reply(availableChats.map(c => `💬 ${c.title} (ID: ${c.id})`).join("\n"));
});

bot.on("message", updateAvailableChats);

bot.launch().then(() => {
  console.log("Telegram Bot is running...");
  refreshScenariosCache();
});

/* ================= Webhook Handler ================= */
app.post("/webhook", async (req, res) => {
  const callId = req.body?.call?.id;
  const resultName = req.body?.call_result?.result_name;
  const scenarioId = req.body?.call?.scenario_id;
  if (!scenarioId || !callId) return res.sendStatus(200);

  if (processedCallIds.has(callId)) return res.sendStatus(200);
  processedCallIds.add(callId);
  setTimeout(() => processedCallIds.delete(callId), 86400000);

  const isSuccessful = resultName &&
    SUCCESSFUL_RESULT_NAMES.some(n => resultName.toLowerCase().includes(n.toLowerCase()));
  if (!isSuccessful) return res.sendStatus(200);

  let targetChatId = await getChatIdForScenario(scenarioId);
  if (!targetChatId) {
    console.log(`⚠️ No mapping for scenario ${scenarioId}, skipping.`);
    return res.sendStatus(200);
  }

  const manager = req.body?.call?.user?.name || "Unknown";
  const phone = req.body?.call?.phone || "Unknown";
  const comment = req.body?.call_result?.comment || "No comment";
  const startedAt = req.body?.call?.started_at;
  const formattedDate = new Date(startedAt || Date.now()).toLocaleString("ru-RU");

  const message = `
✅ POTENTIAL CLIENT

👤 Manager: ${manager}
📞 Phone: ${phone}
🎯 Result: ${resultName}
💬 Comment: ${comment}

Scenario ID: ${scenarioId}
Date: ${formattedDate}
Call ID: ${callId}`;

  await new Promise(r => setTimeout(r, 120000));
  const audioSent = await sendAudioToTelegram(callId, message, targetChatId);
  if (!audioSent) {
    await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      chat_id: targetChatId,
      text: message + "\n\n❌ Recording not available.",
      parse_mode: "HTML",
    });
  }

  res.sendStatus(200);
});

/* ================= Express ================= */
app.get("/", (req, res) => res.send("CallSuccess AI Processor running"));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));