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

/* ================= Admin Functions ================= */
function listAdmins() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM bot_admins`, [], (err, rows) => {
      if (err) reject(err);
      resolve(rows);
    });
  });
}

function addAdmin(telegramId, name, role = "normal") {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR IGNORE INTO bot_admins (telegram_id, name, role) VALUES (?, ?, ?)`,
      [telegramId, name, role],
      function (err) {
        if (err) reject(err);
        resolve({ id: this.lastID, changes: this.changes });
      }
    );
  });
}

function removeAdmin(telegramId) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM bot_admins WHERE telegram_id = ?`,
      [telegramId],
      function (err) {
        if (err) reject(err);
        resolve({ changes: this.changes });
      }
    );
  });
}

async function isAdmin(telegramId) {
  if (MAIN_ADMINS.includes(telegramId.toString())) return true;
  const row = await new Promise((resolve, reject) => {
    db.get(`SELECT * FROM bot_admins WHERE telegram_id = ?`, [telegramId], (err, r) => {
      if (err) reject(err);
      resolve(r);
    });
  });
  return !!row;
}

function canEditAdmins(telegramId) {
  return MAIN_ADMINS.includes(telegramId.toString());
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
    console.error("Ошибка получения токена:", error.response?.data || error.message);
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
    console.error("Ошибка получения сценариев:", error.response?.data || error.message);
    return [];
  }
}

async function refreshScenariosCache() {
  availableScenarios = await fetchScenariosFromSkorozvon();
  console.log(`Сценарии обновлены: ${availableScenarios.length}`);
}

/* ================= Telegram Bot ================= */
const bot = new Telegraf(TG_BOT_TOKEN);

async function updateAvailableChats(ctx) {
  if (ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
    const chatId = ctx.chat.id;
    const chatTitle = ctx.chat.title || `Чат ${chatId}`;

    const existingChat = availableChats.find(c => c.id === chatId);
    if (!existingChat) {
      availableChats.push({
        id: chatId,
        title: chatTitle,
        type: ctx.chat.type,
        updatedAt: new Date(),
      });
      console.log(`Добавлен чат: ${chatTitle} (${chatId})`);
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
    console.error("Ошибка отправки аудио:", error.message);
    return false;
  }
}

/* ================= Bot Commands ================= */
bot.start(async ctx => {
  if (!await isAdmin(ctx.from.id)) return ctx.reply("❌ Доступ запрещён.");

  const userId = ctx.from.id.toString();
  let msg = "🤖 Бот для обработки звонков Skorozvon\n\n";
  msg += "/setup - Привязка сценариев\n/list - Список привязок\n/refresh - Обновить сценарии\n/chats - Список чатов\n";
  if (canEditAdmins(userId)) msg += "/admins - Управление админами\n/addadmin - Добавить админа\n/deladmin - Удалить админа\n";

  ctx.reply(msg);
});

bot.command("setup", async ctx => {
  if (!await isAdmin(ctx.from.id)) return ctx.reply("❌ У вас нет прав для этой команды.");
  if (availableScenarios.length === 0) await refreshScenariosCache();
  if (availableScenarios.length === 0) return ctx.reply("❌ Сценарии не загружены.");
  if (availableChats.length === 0) return ctx.reply("❌ Нет доступных чатов.");

  ctx.reply(
    "Выберите сценарий:",
    Markup.inlineKeyboard(
      availableScenarios.map(s => [Markup.button.callback(s.name, `select_scenario_${s.id}`)]),
      { columns: 1 }
    )
  );
});

bot.command("list", async ctx => {
  if (!await isAdmin(ctx.from.id)) return ctx.reply("❌ У вас нет прав для этой команды.");
  const mappings = await listScenarioMappings();
  if (mappings.length === 0) return ctx.reply("ℹ️ Привязки не настроены.");
  ctx.reply(mappings.map(m => `📋 ${m.skorozvon_scenario_name} → ${m.telegram_chat_title}`).join("\n\n"));
});

bot.command("refresh", async ctx => {
  if (!await isAdmin(ctx.from.id)) return ctx.reply("❌ У вас нет прав для этой команды.");
  await refreshScenariosCache();
  ctx.reply(`✅ Загружено сценариев: ${availableScenarios.length}`);
});

bot.command("chats", async ctx => {
  if (!await isAdmin(ctx.from.id)) return ctx.reply("❌ У вас нет прав для этой команды.");
  if (availableChats.length === 0) return ctx.reply("ℹ️ Нет доступных чатов.");
  ctx.reply(availableChats.map(c => `💬 ${c.title} (ID: ${c.id})`).join("\n"));
});

/* ================= Admin Management ================= */
bot.command("admins", async ctx => {
  if (!canEditAdmins(ctx.from.id)) return ctx.reply("❌ У вас нет прав для этой команды.");
  const admins = await listAdmins();

  let msg = `👑 Главные админы:\n${MAIN_ADMINS.join(", ")}\n\n`;
  if (admins.length > 0) msg += `🛡️ Обычные админы:\n${admins.map(a => `${a.name} (${a.telegram_id})`).join("\n")}`;
  else msg += "🛡️ Обычные админы: нет";

  ctx.reply(msg, Markup.inlineKeyboard([
    [Markup.button.callback("➕ Добавить админа", "menu_add_admin")],
    [Markup.button.callback("➖ Удалить админа", "menu_remove_admin")]
  ]));
});

// Выбор добавления админа
bot.action("menu_add_admin", async ctx => {
  if (!canEditAdmins(ctx.from.id)) return ctx.reply("❌ У вас нет прав для этой команды.");

  if (availableChats.length === 0) return ctx.reply("ℹ️ Нет доступных пользователей для добавления.");

  ctx.editMessageText("Выберите пользователя для назначения админом:", Markup.inlineKeyboard(
    availableChats.map(u => [Markup.button.callback(`${u.title} (ID: ${u.id})`, `addadmin_select_${u.id}`)]),
    { columns: 1 }
  ));
});

// Подтверждение добавления админа
bot.action(/addadmin_select_(.+)/, async ctx => {
  const chatId = ctx.match[1];
  const chat = availableChats.find(c => c.id == chatId);
  if (!chat) return ctx.reply("❌ Пользователь не найден.");
  
  await addAdmin(chatId, chat.title);
  ctx.editMessageText(`✅ Админ добавлен: ${chat.title} (ID: ${chatId})`);
});

// Выбор удаления админа
bot.action("menu_remove_admin", async ctx => {
  if (!canEditAdmins(ctx.from.id)) return ctx.reply("❌ У вас нет прав для этой команды.");

  const admins = await listAdmins();
  if (admins.length === 0) return ctx.reply("ℹ️ Нет обычных админов для удаления.");

  ctx.editMessageText("Выберите админа для удаления:", Markup.inlineKeyboard(
    admins.map(a => [Markup.button.callback(`${a.name} (ID: ${a.telegram_id})`, `deladmin_select_${a.telegram_id}`)]),
    { columns: 1 }
  ));
});

// Подтверждение удаления админа
bot.action(/deladmin_select_(.+)/, async ctx => {
  const telegramId = ctx.match[1];
  const admin = (await listAdmins()).find(a => a.telegram_id === telegramId);
  if (!admin) return ctx.reply("❌ Админ не найден.");

  await removeAdmin(telegramId);
  ctx.editMessageText(`✅ Админ удалён: ${admin.name} (ID: ${telegramId})`);
});

/* ================= Capture Chats ================= */
bot.on("message", updateAvailableChats);

/* ================= Bot Launch ================= */
bot.telegram.deleteWebhook()
  .then(() => {
    bot.launch().then(() => {
      console.log("Бот запущен через polling...");
      refreshScenariosCache();
    });
  })
  .catch(err => console.error("Ошибка при удалении webhook:", err.message));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

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
    console.log(`⚠️ Нет привязки для сценария ${scenarioId}, пропускаем.`);
    return res.sendStatus(200);
  }

  const manager = req.body?.call?.user?.name || "Неизвестен";
  const phone = req.body?.call?.phone || "Неизвестен";
  const comment = req.body?.call_result?.comment || "Комментарий отсутствует";
  const startedAt = req.body?.call?.started_at;
  const formattedDate = new Date(startedAt || Date.now()).toLocaleString("ru-RU");

  const message = `
✅ ПОТЕНЦИАЛЬНЫЙ КЛИЕНТ

👤 Менеджер: ${manager}
📞 Телефон: ${phone}
🎯 Результат: ${resultName}
💬 Комментарий: ${comment}

Дата: ${formattedDate}
ID звонка: ${callId}`;

  await new Promise(r => setTimeout(r, 120000));
  const audioSent = await sendAudioToTelegram(callId, message, targetChatId);
  if (!audioSent) {
    await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      chat_id: targetChatId,
      text: message + "\n\n❌ Аудиозапись недоступна.",
      parse_mode: "HTML",
    });
  }

  res.sendStatus(200);
});

/* ================= Express ================= */
app.get("/", (req, res) => res.send("CallSuccess AI Processor запущен"));
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));