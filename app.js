// server.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const sqlite3 = require("sqlite3").verbose();
const { Telegraf, Markup } = require("telegraf");

const app = express();
app.use(express.json());

/* ====== Настройки ====== */
const PORT = process.env.PORT || 3000;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const DEFAULT_TG_CHAT_ID = process.env.DEFAULT_TG_CHAT_ID;
const SUCCESSFUL_RESULT_NAMES = process.env.SUCCESSFUL_RESULT_NAMES
  ? process.env.SUCCESSFUL_RESULT_NAMES.split(",")
  : ["Успех", "Горячий", "Горячая", "Hot"];

/* ====== DB (SQLite) ====== */
const db = new sqlite3.Database("./data.sqlite");
function dbRun(sql, params = []) {
  return new Promise((res, rej) =>
    db.run(sql, params, function (err) {
      if (err) return rej(err);
      return res(this);
    })
  );
}
function dbAll(sql, params = []) {
  return new Promise((res, rej) =>
    db.all(sql, params, (err, rows) => {
      if (err) return rej(err);
      return res(rows);
    })
  );
}
function dbGet(sql, params = []) {
  return new Promise((res, rej) =>
    db.get(sql, params, (err, row) => {
      if (err) return rej(err);
      return res(row);
    })
  );
}

async function initDb() {
  await dbRun(`CREATE TABLE IF NOT EXISTS scenarios (
    scenario_id TEXT PRIMARY KEY,
    scenario_name TEXT,
    group_id TEXT,
    group_name TEXT,
    updated_at INTEGER
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    group_id TEXT,
    group_name TEXT,
    UNIQUE(chat_id, group_id)
  )`);
}
initDb().catch(console.error);

/* ====== Телеграм бот (Telegraf) ====== */
const bot = new Telegraf(TG_BOT_TOKEN);

async function isUserAdmin(chatId, userId) {
  try {
    const member = await bot.telegram.getChatMember(chatId, userId);
    return ["creator", "administrator"].includes(member.status);
  } catch (e) {
    return false;
  }
}

/* ====== Skorozvon API ====== */
async function getAccessToken() {
  try {
    const resp = await axios({
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
    return resp.data.access_token;
  } catch (err) {
    console.error(
      "Ошибка токена Skorozvon:",
      err.response?.data || err.message
    );
    return null;
  }
}

async function refreshScenariosCache() {
  const token = await getAccessToken();
  if (!token) throw new Error("нет токена");

  const resp = await axios.get("https://api.skorozvon.ru/api/v2/scenarios", {
    headers: { Authorization: `Bearer ${token}` },
  });

  const items = resp.data?.data || resp.data || [];
  const now = Math.floor(Date.now() / 1000);

  for (const r of items) {
    const scenario_id = String(r.id || r.scenario_id || "");
    const scenario_name = r.name || "";
    const group_id = r.group_id || r.project_id || "";
    const group_name = r.group_name || r.project_name || "";
    if (!scenario_id) continue;
    await dbRun(
      `INSERT OR REPLACE INTO scenarios(scenario_id, scenario_name, group_id, group_name, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [scenario_id, scenario_name, group_id, group_name, now]
    );
  }

  console.log("Сценарии обновлены:", items.length);
}

async function getGroupForScenario(scenarioId) {
  if (!scenarioId) return null;
  let row = await dbGet("SELECT * FROM scenarios WHERE scenario_id = ?", [
    String(scenarioId),
  ]);
  if (row) return { group_id: row.group_id, group_name: row.group_name };

  await refreshScenariosCache();
  row = await dbGet("SELECT * FROM scenarios WHERE scenario_id = ?", [
    String(scenarioId),
  ]);
  if (row) return { group_id: row.group_id, group_name: row.group_name };
  return null;
}

/* ====== Подписки ====== */
async function addSubscription(chatId, groupId, groupName) {
  await dbRun(
    `INSERT OR IGNORE INTO subscriptions(chat_id, group_id, group_name) VALUES (?, ?, ?)`,
    [String(chatId), String(groupId), groupName || null]
  );
}
async function removeSubscription(chatId, groupId) {
  await dbRun(`DELETE FROM subscriptions WHERE chat_id = ? AND group_id = ?`, [
    String(chatId),
    String(groupId),
  ]);
}
async function listSubscriptions(chatId) {
  return await dbAll(`SELECT * FROM subscriptions WHERE chat_id = ?`, [
    String(chatId),
  ]);
}
async function getChatsForGroup(groupId) {
  return await dbAll(
    `SELECT DISTINCT chat_id FROM subscriptions WHERE group_id = ?`,
    [String(groupId)]
  );
}

/* ====== Команды бота ====== */
// /обновить_сценарии
bot.command("обновить_сценарии", async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const ok =
    ctx.chat.type === "private" ? true : await isUserAdmin(chatId, userId);
  if (!ok)
    return ctx.reply("❌ Только администраторы могут обновлять сценарии.");

  await ctx.reply("⏳ Обновляю список сценариев...");
  await refreshScenariosCache();
  await ctx.reply("✅ Сценарии обновлены.");
});

// /привязать
bot.command("привязать", async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const ok =
    ctx.chat.type === "private" ? true : await isUserAdmin(chatId, userId);
  if (!ok)
    return ctx.reply("❌ Только администраторы могут управлять подписками.");

  const groups = await dbAll(
    `SELECT DISTINCT group_id, group_name FROM scenarios`
  );
  if (!groups || groups.length === 0) {
    return ctx.reply(
      "⚠️ Сценарии ещё не загружены. Сначала выполните /обновить_сценарии"
    );
  }

  const buttons = groups.map((g) =>
    Markup.button.callback(
      `📌 ${g.group_name || g.group_id}`,
      `bind:${g.group_id}:${g.group_name || ""}`
    )
  );
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 2)
    keyboard.push(buttons.slice(i, i + 2));

  await ctx.reply(
    "Выберите группу сценариев для привязки:",
    Markup.inlineKeyboard(keyboard)
  );
});

// /подписки
bot.command("подписки", async (ctx) => {
  const chatId = ctx.chat.id;
  const rows = await listSubscriptions(chatId);
  if (!rows || rows.length === 0)
    return ctx.reply("📭 У этого чата пока нет подписок.");

  let text = "📌 Подписки этого чата:\n\n";

  const buttons = rows.map((r) =>
    Markup.button.callback(
      `❌ ${r.group_name || r.group_id}`,
      `unbind:${r.group_id}`
    )
  );

  // каждую кнопку в отдельную строку
  const keyboard = buttons.map((b) => [b]);

  rows.forEach((r) => (text += `• ${r.group_name || r.group_id}\n`));

  return ctx.reply(text, Markup.inlineKeyboard(keyboard));
});

// Обработчик кнопок
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  const userId = ctx.from.id;

  const isAdmin = await isUserAdmin(chatId, userId);
  if (!isAdmin) {
    await ctx.answerCbQuery(
      "❌ Только администраторы могут управлять подписками."
    );
    return;
  }

  if (data.startsWith("bind:")) {
    const parts = data.split(":");
    const groupId = parts[1];
    const groupName = parts.slice(2).join(":") || null;
    await addSubscription(chatId, groupId, groupName);
    await ctx.editMessageText(
      `✅ Чат подписан на группу «${groupName || groupId}»`
    );
    await ctx.answerCbQuery("Подписка сохранена");
  }

  if (data.startsWith("unbind:")) {
    const parts = data.split(":");
    const groupId = parts[1];
    await removeSubscription(chatId, groupId);
    await ctx.editMessageText(`❌ Подписка на группу ${groupId} удалена.`);
    await ctx.answerCbQuery("Отвязка выполнена");
  }
});

/* ====== Отправка аудио ====== */
async function sendAudioToChat(callId, caption, chatId) {
  try {
    const token = await getAccessToken();
    if (!token) throw new Error("нет токена");

    const recordingUrl = `https://api.skorozvon.ru/api/v2/calls/${callId}.mp3?access_token=${token}`;
    const audioResp = await axios.get(recordingUrl, {
      responseType: "stream",
      timeout: 30000,
    });

    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("audio", audioResp.data);
    form.append("caption", caption);
    form.append("parse_mode", "HTML");

    await axios.post(
      `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendAudio`,
      form,
      {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );
    return true;
  } catch (e) {
    console.error(
      `Ошибка отправки аудио в чат ${chatId}:`,
      e.response?.data || e.message
    );
    return false;
  }
}

/* ====== Webhook Skorozvon ====== */
app.post("/webhook", async (req, res) => {
  const call = req.body?.call || {};
  const callId = call.id;
  const resultName = req.body?.call_result?.result_name;

  const isSuccessful =
    resultName &&
    SUCCESSFUL_RESULT_NAMES.some((s) =>
      resultName.toLowerCase().includes(s.toLowerCase())
    );
  if (!isSuccessful) return res.sendStatus(200);

  const managerName = call.user?.name || "Не указан";
  const phone = call.phone || "Не указан";
  const comment = req.body?.call_result?.comment || "нет комментария";
  const startedAt = call.started_at || null;
  const formattedDate = startedAt
    ? new Date(startedAt).toLocaleString("ru-RU")
    : new Date().toLocaleString("ru-RU");

  const caption = `✅ ПОТЕНЦИАЛЬНЫЙ КЛИЕНТ

👤 Менеджер: ${managerName}
📞 Телефон: ${phone}
🎯 Результат: ${resultName}
💬 Комментарий: ${comment}

Дата: ${formattedDate}
ID звонка: ${callId}`;

  const scenarioId = call.scenario?.id || null;
  const groupInfo = await getGroupForScenario(scenarioId);
  const groupId = groupInfo?.group_id;

  let targetChats = [];
  if (groupId) {
    const rows = await getChatsForGroup(groupId);
    targetChats = rows.map((r) => r.chat_id);
  }
  if (targetChats.length === 0 && DEFAULT_TG_CHAT_ID) {
    targetChats = [DEFAULT_TG_CHAT_ID];
  }

  for (const chatId of targetChats) {
    const ok = await sendAudioToChat(callId, caption, chatId);
    if (!ok) {
      await axios.post(
        `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,
        {
          chat_id: chatId,
          text: caption + "\n\n❌ Запись недоступна",
          parse_mode: "HTML",
        }
      );
    }
  }

  res.sendStatus(200);
});

/* ====== Запуск ====== */
bot.launch().then(() => console.log("🤖 Бот запущен"));
app.listen(PORT, () => console.log(`🌐 Сервер слушает порт ${PORT}`));
