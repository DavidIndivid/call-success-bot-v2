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

/* ====== DB (SQLite) и инициализация ====== */
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

// helper: проверка, админ ли пользователь в данном чате
async function isUserAdmin(chatId, userId) {
  try {
    const member = await bot.telegram.getChatMember(chatId, userId);
    return ["creator", "administrator"].includes(member.status);
  } catch (e) {
    console.error("getChatMember error:", e.message);
    return false;
  }
}

/* ====== Skorozvon: токен и сценарии ====== */
// Возвращает access_token (последовательный запрос каждый раз — простая и надежная схема)
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
    // не логируем весь токен, только первые символы
    console.log("Skorozvon token received (masked):", (resp.data.access_token || "").slice(0, 10) + "...");
    return resp.data.access_token;
  } catch (err) {
    console.error("Error getting Skorozvon token:", err.response?.data || err.message);
    return null;
  }
}

// Подтягиваем сценарии с API и кешируем в таблице scenarios
async function refreshScenariosCache() {
  const token = await getAccessToken();
  if (!token) throw new Error("no token");

  try {
    const resp = await axios.get("https://api.skorozvon.ru/api/v2/scenarios", {
      headers: { Authorization: `Bearer ${token}` },
      params: { per_page: 1000 }, // если API поддерживает
    });

    const items = resp.data?.data || resp.data || []; // адаптация под возможный формат
    const now = Math.floor(Date.now() / 1000);

    // Очищаем и вставляем (упрощенно)
    const insert = async (row) => {
      const scenario_id = String(row.id || row.scenario_id || row._id || "");
      const scenario_name = row.name || row.scenario_name || "";
      const group_id = row.group_id || row.project_id || row.parent_id || "";
      const group_name = row.group_name || row.project_name || row.parent_name || "";
      if (!scenario_id) return;
      await dbRun(
        `INSERT OR REPLACE INTO scenarios(scenario_id, scenario_name, group_id, group_name, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [scenario_id, scenario_name, group_id, group_name, now]
      );
    };

    // Если items — объект со списком
    if (Array.isArray(items)) {
      for (const r of items) await insert(r);
    } else {
      // если API вернул {scenarios: [...]} или т.п.
      const arr = resp.data?.scenarios || resp.data?.items || [];
      for (const r of arr) await insert(r);
    }

    console.log("Scenarios cache refreshed, count maybe:", items.length || (resp.data?.scenarios || []).length);
    return true;
  } catch (err) {
    console.error("Error refreshing scenarios:", err.response?.data || err.message);
    throw err;
  }
}

// Получить group info по scenario_id (если нет в кэше — обновим)
async function getGroupForScenario(scenarioId) {
  if (!scenarioId) return null;
  let row = await dbGet("SELECT * FROM scenarios WHERE scenario_id = ?", [String(scenarioId)]);
  if (row) return { group_id: row.group_id, group_name: row.group_name };

  // обновим кэш и попробуем снова
  try {
    await refreshScenariosCache();
    row = await dbGet("SELECT * FROM scenarios WHERE scenario_id = ?", [String(scenarioId)]);
    if (row) return { group_id: row.group_id, group_name: row.group_name };
  } catch (e) {
    console.error("getGroupForScenario error:", e.message);
  }
  return null;
}

/* ====== Подписки: bind / unbind / list ====== */
async function addSubscription(chatId, groupId, groupName) {
  try {
    await dbRun(
      `INSERT OR IGNORE INTO subscriptions(chat_id, group_id, group_name) VALUES (?, ?, ?)`,
      [String(chatId), String(groupId), groupName || null]
    );
    return true;
  } catch (e) {
    console.error("addSubscription error:", e.message);
    return false;
  }
}
async function removeSubscription(chatId, groupId) {
  try {
    await dbRun(`DELETE FROM subscriptions WHERE chat_id = ? AND group_id = ?`, [String(chatId), String(groupId)]);
    return true;
  } catch (e) {
    console.error("removeSubscription error:", e.message);
    return false;
  }
}
async function listSubscriptions(chatId) {
  return await dbAll(`SELECT * FROM subscriptions WHERE chat_id = ?`, [String(chatId)]);
}
async function getChatsForGroup(groupId) {
  return await dbAll(`SELECT DISTINCT chat_id FROM subscriptions WHERE group_id = ?`, [String(groupId)]);
}

/* ====== Bot commands (Telegraf) ====== */

// /обновить_сценарии
bot.command("обновить_сценарии", async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const ok = ctx.chat.type === "private" ? true : await isUserAdmin(chatId, userId);
    if (!ok) return ctx.reply("У тебя нет прав на эту команду.");

    await ctx.reply("⏳ Обновляю список сценариев в Skorozvon...");
    await refreshScenariosCache();
    await ctx.reply("✅ Список сценариев успешно обновлён.");
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при обновлении сценариев: " + (e.message || e));
  }
});

// /привязать
bot.command("привязать", async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const okAdmin = ctx.chat.type === "private" ? true : await isUserAdmin(chatId, userId);
    if (!okAdmin) return ctx.reply("❌ Только администраторы могут управлять подписками.");

    const groups = await dbAll(
      `SELECT DISTINCT group_id, group_name FROM scenarios WHERE group_id IS NOT NULL AND group_id <> ''`
    );

    if (!groups || groups.length === 0) {
      return ctx.reply("⚠️ Список сценариев пуст. Сначала обновите его командой /обновить_сценарии.");
    }

    const buttons = groups.map((g) =>
      Markup.button.callback(`📌 ${g.group_name || g.group_id}`, `bind:${g.group_id}:${(g.group_name || "").replace(/[:]/g,'')}`)
    );

    const keyboard = [];
    for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));

    await ctx.reply("Выберите группу сценариев для привязки этого чата:", Markup.inlineKeyboard(keyboard));
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка при /привязать: " + e.message);
  }
});

// обработчик нажатий кнопок (callback_query)
bot.on("callback_query", async (ctx) => {
  try {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
    const userId = ctx.from.id;

    const isAdmin = await isUserAdmin(chatId, userId);
    if (!isAdmin) {
      await ctx.answerCbQuery("❌ Только администраторы могут управлять подписками.");
      return;
    }

    if (data.startsWith("bind:")) {
      const parts = data.split(":");
      const groupId = parts[1];
      const groupName = parts.slice(2).join(":") || null;
      await addSubscription(chatId, groupId, groupName);
      await ctx.editMessageText(`✅ Чат успешно подписан на группу «${groupName || groupId}»`);
      await ctx.answerCbQuery("Привязка сохранена");
      return;
    }

    if (data.startsWith("unbind:")) {
      const parts = data.split(":");
      const groupId = parts[1];
      await removeSubscription(chatId, groupId);
      await ctx.editMessageText(`❌ Чат отвязан от группы ${groupId}`);
      await ctx.answerCbQuery("Отвязка сохранена");
      return;
    }

    await ctx.answerCbQuery("Неизвестное действие.");
  } catch (e) {
    console.error("callback_query error:", e);
    try { await ctx.answerCbQuery("❌ Ошибка: " + e.message); } catch {}
  }
});

// /подписки
bot.command("подписки", async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const rows = await listSubscriptions(chatId);
    if (!rows || rows.length === 0) return ctx.reply("📭 У этого чата пока нет подписок.");
    let text = "📌 Подписки этого чата:\n\n";
    rows.forEach((r) => (text += `• ${r.group_name || r.group_id}\n`));
    return ctx.reply(text);
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Ошибка: " + e.message);
  }
});


// функция получения записи и отправки в конкретный чат (stream -> sendAudio)
async function sendAudioToChat(callId, caption, chatId) {
  try {
    const token = await getAccessToken();
    if (!token) throw new Error("no token");

    const recordingUrl = `https://api.skorozvon.ru/api/v2/calls/${callId}.mp3?access_token=${token}`;

    // Скачиваем стрим
    const audioResp = await axios.get(recordingUrl, { responseType: "stream", timeout: 30000 });

    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("audio", audioResp.data);
    form.append("caption", caption);
    form.append("parse_mode", "HTML");

    await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendAudio`, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    return true;
  } catch (e) {
    console.error(`sendAudioToChat error for chat ${chatId}:`, e.response?.data || e.message);
    return false;
  }
}


app.post("/webhook", async (req, res) => {
  try {
    console.log("Skorozvon webhook received at", new Date().toISOString());

    const call = req.body?.call || {};
    const callId = call.id;
    const resultName = req.body?.call_result?.result_name;
    const callDuration = call.duration || 0;
    const scenarioId = (call.scenario && call.scenario.id) || req.body?.call?.scenario_id || req.body?.call?.scenarioId;

    // фильтр успешных названий 
    const isSuccessful = resultName && SUCCESSFUL_RESULT_NAMES.some((s) => resultName.toLowerCase().includes(s.toLowerCase()));

    if (!isSuccessful) {
      console.log("Skipping call (not successful) id:", callId, "result:", resultName);
      return res.sendStatus(200);
    }

    // собрать текст сообщения
    const managerName = call.user?.name || "Не указан";
    const phone = call.phone || "Не указан";
    const comment = req.body?.call_result?.comment || "нет комментария";
    const startedAt = call.started_at || null;
    const formattedDate = startedAt ? new Date(startedAt).toLocaleString("ru-RU") : new Date().toLocaleString("ru-RU");

    const caption = `✅ ПОТЕНЦИАЛЬНЫЙ КЛИЕНТ

👤 Менеджер: ${managerName}
📞 Телефон: ${phone}
🎯 Результат: ${resultName}
💬 Комментарий: ${comment}

Дата: ${formattedDate}
ID звонка: ${callId}`;

    // Найдём group по сценарию
    const groupInfo = await getGroupForScenario(scenarioId);
    const groupId = groupInfo?.group_id;
    const groupName = groupInfo?.group_name;

    // Если удалось получить group_id, найдём подписанные чаты
    let targetChats = [];
    if (groupId) {
      const rows = await getChatsForGroup(groupId);
      targetChats = (rows || []).map((r) => r.chat_id);
    }

    // Если ничего не найдено — отправляем в дефолтный чат (если задан)
    if ((!targetChats || targetChats.length === 0) && DEFAULT_TG_CHAT_ID) {
      targetChats = [DEFAULT_TG_CHAT_ID];
    }

    // Отправляем запись/сообщение в каждый чат
    for (const chatId of targetChats) {
      const ok = await sendAudioToChat(callId, caption, chatId);
      if (!ok) {
        // если не удалось отправить аудио — отправим просто текст с ссылкой (fallback)
        const token = await getAccessToken();
        const link = token ? `https://api.skorozvon.ru/api/v2/calls/${callId}.mp3?access_token=${token}` : "Запись недоступна";
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: caption + `\n\n🔗 Ссылка на запись: ${link}`,
          parse_mode: "HTML",
        });
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook handling error:", e.response?.data || e.message || e);
    return res.sendStatus(200);
  }
});

/* ====== Запуск бота и сервера ====== */
bot.launch().then(() => console.log("Telegram bot started (polling)")).catch(console.error);

app.get("/", (req, res) => res.send("Service is running"));
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));