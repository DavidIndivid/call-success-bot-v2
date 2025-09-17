require("dotenv").config();
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const { Telegraf, Markup } = require("telegraf");
const LocalSession = require("telegraf-session-local");
const db = require("./database.js");

const app = express();
const PORT = process.env.PORT || 3000;

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const MAIN_ADMINS = process.env.MAIN_ADMINS
  ? process.env.MAIN_ADMINS.split(",").map((id) => id.trim())
  : [];
const RAILWAY_PUBLIC_URL = process.env.RAILWAY_PUBLIC_URL || ""; // set on Railway
const SUCCESSFUL_RESULT_NAMES = process.env.SUCCESSFUL_RESULT_NAMES
  ? process.env.SUCCESSFUL_RESULT_NAMES.split(",")
  : ["Успех", "Горячий", "Горячая", "Hot"];

app.use(express.json());

const bot = new Telegraf(TG_BOT_TOKEN);
bot.use(new LocalSession({ database: "sessions.json" }).middleware());

const processedCallIds = new Set();
let availableScenarios = [];

// ---------- DB helpers ----------
function addOrUpdateChat(chatId, title, type) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO chats(id, title, type, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
      [chatId, title, type],
      function (err) {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

function listChatsFromDb() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT id, title, type FROM chats ORDER BY title`, [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function getChatIdForScenario(scenarioId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT telegram_chat_id FROM scenario_mappings WHERE skorozvon_scenario_id = ?`,
      [scenarioId],
      (err, row) => {
        if (err) return reject(err);
        resolve(row ? row.telegram_chat_id : null);
      }
    );
  });
}

function addScenarioMapping(scenarioId, scenarioName, chatId, chatTitle) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO scenario_mappings (skorozvon_scenario_id, skorozvon_scenario_name, telegram_chat_id, telegram_chat_title) VALUES (?, ?, ?, ?)`,
      [scenarioId, scenarioName, chatId, chatTitle],
      function (err) {
        if (err) return reject(err);
        resolve({ changes: this.changes });
      }
    );
  });
}

function removeScenarioMapping(scenarioId) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM scenario_mappings WHERE skorozvon_scenario_id = ?`,
      [scenarioId],
      function (err) {
        if (err) reject(err);
        resolve({ changes: this.changes });
      }
    );
  });
}

function listScenarioMappings() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM scenario_mappings ORDER BY skorozvon_scenario_name`, [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function addAdminToDb(telegramUserId, username) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO admin_users (telegram_user_id, username) VALUES (?, ?)`,
      [telegramUserId || null, username || null],
      function (err) {
        if (err) return reject(err);
        resolve({ changes: this.changes });
      }
    );
  });
}

function removeAdminFromDbById(id) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM admin_users WHERE telegram_user_id = ?`, [id], function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes });
    });
  });
}

function removeAdminFromDbByUsername(username) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM admin_users WHERE username = ?`, [username], function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes });
    });
  });
}

function listAdminsFromDb() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM admin_users ORDER BY created_at DESC`, [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
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

// ---------- roles ----------
function isMainAdminRaw(userId) {
  if (!userId) return false;
  return MAIN_ADMINS.map(String).includes(String(userId));
}

async function isAdmin(userId, username) {
  if (isMainAdminRaw(userId)) return true;
  const row = await new Promise((res) =>
    db.get(
      `SELECT * FROM admin_users WHERE telegram_user_id = ? OR username = ?`,
      [userId || null, username || null],
      (err, r) => res(r)
    )
  );
  return !!row;
}

// ---------- Skorozvon API ----------
async function getAccessToken() {
  try {
    const resp = await axios.post(
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
    return resp.data.access_token;
  } catch (e) {
    console.error("Token error:", e.response?.data || e.message);
    return null;
  }
}

async function fetchScenariosFromSkorozvon() {
  try {
    const token = await getAccessToken();
    if (!token) return [];
    const r = await axios.get("https://api.skorozvon.ru/api/v2/scenarios", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return r.data?.data?.map((s) => ({ id: s.id, name: s.name })) || [];
  } catch (e) {
    console.error("Fetch scenarios error:", e.response?.data || e.message);
    return [];
  }
}

async function refreshScenariosCache() {
  availableScenarios = await fetchScenariosFromSkorozvon();
  console.log("Scenarios count:", availableScenarios.length);
}

// ---------- bot helpers ----------
async function sendAudioToTelegram(callId, caption, chatId) {
  try {
    const token = await getAccessToken();
    if (!token) return false;
    const url = `https://api.skorozvon.ru/api/v2/calls/${callId}.mp3?access_token=${token}`;
    const audioResp = await axios.get(url, { responseType: "stream", timeout: 30000 });

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
    console.error("Send audio error:", e.response?.data || e.message);
    return false;
  }
}

// ---------- update available chats on any message ----------
bot.use(async (ctx, next) => {
  try {
    const chat = ctx.chat;
    if (chat && (chat.type === "group" || chat.type === "supergroup")) {
      // try to store chat to DB (if bot added to group and receives messages)
      await addOrUpdateChat(chat.id, chat.title || `Chat ${chat.id}`, chat.type);
    }
  } catch (e) {
    console.warn("update chat error:", e.message);
  }
  return next();
});

// ---------- commands ----------

bot.start(async (ctx) => {
  const uid = ctx.from?.id;
  if (isMainAdminRaw(uid)) {
    // ensure MAIN ADMIN is recorded in DB for listing
    try {
      await addAdminToDb(uid, ctx.from.username || "main_admin");
    } catch (e) {
      // ignore
    }
    return ctx.reply(
      "🤖 Добро пожаловать!\n\n" +
        "Вы главный администратор.\n\n" +
        "Команды:\n" +
        "/setup — привязать сценарий к чату\n" +
        "/list — список привязок\n" +
        "/refresh — обновить сценарии\n" +
        "/admins — управление администраторами\n" +
        "/unlink — отвязать сценарий\n" +
        "/chats — список чатов\n"
    );
  }

  if (await isAdmin(uid, ctx.from.username)) {
    return ctx.reply(
      "🤖 Добро пожаловать!\n\n" +
        "Вы администратор. Доступны: /setup, /list, /refresh, /chats"
    );
  }

  return ctx.reply("🤖 Добро пожаловать! Обратитесь к главному администратору для доступа.");
});

// show chats
bot.command("chats", async (ctx) => {
  if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.reply("🚫 Нет доступа.");
  const rows = await listChatsFromDb();
  if (!rows.length) return ctx.reply("ℹ️ Чатов нет в базе.");
  const txt = rows.map(r => `💬 ${r.title} (ID: ${r.id})`).join("\n\n");
  ctx.reply(txt);
});

// refresh scenarios
bot.command("refresh", async (ctx) => {
  if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.reply("🚫 Нет доступа.");
  await ctx.reply("⏳ Обновляю сценарии...");
  await refreshScenariosCache();
  ctx.reply(`✅ Загружено ${availableScenarios.length} сценариев.`);
});

// list bindings
bot.command("list", async (ctx) => {
  if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.reply("🚫 Нет доступа.");
  const rows = await listScenarioMappings();
  if (!rows.length) return ctx.reply("ℹ️ Нет привязок.");
  const txt = rows.map(r => `📋 ${r.skorozvon_scenario_name} → ${r.telegram_chat_title}`).join("\n\n");
  ctx.reply(txt);
});

// setup (bind) - admins allowed
bot.command("setup", async (ctx) => {
  if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.reply("🚫 Нет доступа.");
  if (!availableScenarios.length) await refreshScenariosCache();
  if (!availableScenarios.length) return ctx.reply("❌ Нет сценариев.");
  const chats = await listChatsFromDb();
  if (!chats.length) return ctx.reply("❌ Нет доступных чатов. Добавьте бота в чат и отправьте там любое сообщение.");

  // first choose scenario
  await ctx.reply(
    "Выберите сценарий:",
    Markup.inlineKeyboard(
      availableScenarios.map(s => [Markup.button.callback(s.name, `bind_s:${s.id}`)]),
      { columns: 1 }
    )
  );
});

bot.action(/bind_s:(.+)/, async (ctx) => {
  const scenarioId = ctx.match[1];
  const scenario = availableScenarios.find(s => String(s.id) === String(scenarioId));
  if (!scenario) return ctx.answerCbQuery("Сценарий не найден");
  const chats = await listChatsFromDb();
  if (!chats.length) return ctx.answerCbQuery("Нет чатов");
  await ctx.editMessageText(`Сценарий: ${scenario.name}\nВыберите чат:`, Markup.inlineKeyboard(
    chats.map(c => [Markup.button.callback(c.title, `bind_c:${scenarioId}:${c.id}`)])
  ));
});

bot.action(/bind_c:(\d+):(-?\d+)/, async (ctx) => {
  const scenarioId = ctx.match[1];
  const chatId = ctx.match[2];
  const scenario = availableScenarios.find(s => String(s.id) === String(scenarioId));
  const chats = await listChatsFromDb();
  const chat = chats.find(c => String(c.id) === String(chatId));
  if (!scenario || !chat) return ctx.answerCbQuery("Ошибка");
  await addScenarioMapping(scenarioId, scenario.name, chatId, chat.title);
  await ctx.editMessageText(`✅ Сценарий "${scenario.name}" привязан к "${chat.title}"`);
});

// unlink (only main admins)
bot.command("unlink", async (ctx) => {
  if (!isMainAdminRaw(ctx.from.id)) return ctx.reply("🚫 Только главный админ.");
  const mappings = await listScenarioMappings();
  if (!mappings.length) return ctx.reply("ℹ️ Нет привязок.");
  await ctx.reply(
    "Выберите сценарий для отвязки:",
    Markup.inlineKeyboard(
      mappings.map(m => [Markup.button.callback(`❌ ${m.skorozvon_scenario_name} → ${m.telegram_chat_title}`, `unlink:${m.skorozvon_scenario_id}`)])
    )
  );
});

bot.action(/unlink:(.+)/, async (ctx) => {
  if (!isMainAdminRaw(ctx.from.id)) return ctx.answerCbQuery("Только главный админ.");
  const sid = ctx.match[1];
  await removeScenarioMapping(sid);
  await ctx.editMessageText(`✅ Сценарий ID ${sid} отвязан.`);
});

// admins management (main admins only)
bot.command("admins", async (ctx) => {
  if (!isMainAdminRaw(ctx.from.id)) return ctx.reply("🚫 Только главный админ.");
  const admins = await listAdminsFromDb();
  const text = admins.length ? admins.map(a => `• ${a.username ? '@' + a.username : a.telegram_user_id} (ID: ${a.telegram_user_id || '-'})`).join("\n") : "ℹ️ Админов нет.";
  await ctx.reply(text, Markup.inlineKeyboard([
    [Markup.button.callback("➕ Добавить админа", "admin_add")],
    [Markup.button.callback("➖ Удалить админа", "admin_remove")]
  ]));
});

// admin add flow
bot.action("admin_add", async (ctx) => {
  if (!isMainAdminRaw(ctx.from.id)) return ctx.answerCbQuery("Only main admins.");
  ctx.session.waitingForAddAdmin = true;
  await ctx.reply("Отправьте ID пользователя, @username или перешлите сообщение от пользователя, которого нужно добавить.");
});

bot.action("admin_remove", async (ctx) => {
  if (!isMainAdminRaw(ctx.from.id)) return ctx.answerCbQuery("Only main admins.");
  const admins = await listAdminsFromDb();
  if (!admins.length) return ctx.answerCbQuery("Нет админов для удаления.");
  await ctx.editMessageText("Выберите админа для удаления:", Markup.inlineKeyboard(
    admins.map(a => {
      const token = a.telegram_user_id ? `id:${a.telegram_user_id}` : `u:${a.username}`;
      const label = a.username ? `@${a.username}` : String(a.telegram_user_id);
      return [Markup.button.callback(label, `admin_remove_do:${token}`)];
    })
  ));
});

bot.action(/admin_remove_do:(.+)/, async (ctx) => {
  if (!isMainAdminRaw(ctx.from.id)) return ctx.answerCbQuery("Only main admins.");
  const token = ctx.match[1];
  if (token.startsWith("id:")) {
    const id = token.slice(3);
    await removeAdminFromDbById(id);
    try { await bot.telegram.sendMessage(id, "❗️ Вам отозваны права администратора."); } catch (e) {}
    await ctx.editMessageText(`✅ Админ с ID ${id} удалён.`);
  } else if (token.startsWith("u:")) {
    const username = token.slice(2);
    await removeAdminFromDbByUsername(username);
    await ctx.editMessageText(`✅ Админ @${username} удалён.`);
  } else {
    await ctx.answerCbQuery("Ошибка формата");
  }
});

// handle interactive text / forwarded messages for adding admin
bot.on("message", async (ctx, next) => {
  // add admin interactive flow
  if (ctx.session && ctx.session.waitingForAddAdmin && isMainAdminRaw(ctx.from.id)) {
    try {
      // forwarded message case
      const f = ctx.message.forward_from;
      if (f && f.id) {
        await addAdminToDb(f.id, f.username || null);
        try { await bot.telegram.sendMessage(f.id, "✅ Вы назначены администратором."); } catch (_) {}
        await ctx.reply(`✅ Добавлен админ: ${f.username ? '@' + f.username : f.id}`);
        ctx.session.waitingForAddAdmin = false;
        return;
      }

      // text message case: id or @username
      const text = (ctx.message.text || "").trim();
      if (!text) {
        await ctx.reply("Пустое сообщение. Отправьте ID или @username, либо перешлите сообщение пользователя.");
        return;
      }

      if (text.startsWith("@")) {
        const uname = text.slice(1);
        // store username (user might not have contacted bot yet)
        await addAdminToDb(null, uname);
        await ctx.reply(`✅ Добавлен админ: @${uname}. Пользователь получит уведомление, когда начнёт диалог с ботом.`);
        ctx.session.waitingForAddAdmin = false;
        return;
      }

      if (/^\d+$/.test(text)) {
        const id = text;
        await addAdminToDb(id, null);
        try { await bot.telegram.sendMessage(Number(id), "✅ Вы назначены администратором."); } catch (_) {}
        await ctx.reply(`✅ Добавлен админ с ID ${id}`);
        ctx.session.waitingForAddAdmin = false;
        return;
      }

      await ctx.reply("Неверный формат. Отправьте ID (число) или @username.");
    } catch (e) {
      console.error("Add admin error:", e);
      await ctx.reply("Ошибка при добавлении администратора.");
      ctx.session.waitingForAddAdmin = false;
    }
    return;
  }

  // not part of admin flow -> continue to handlers
  return next();
});

// ---------- Skorozvon webhook ----------
app.post("/webhook", async (req, res) => {
  try {
    const call = req.body?.call || {};
    const callId = call.id;
    const resultName = req.body?.call_result?.result_name;
    const scenarioId = call.scenario_id;

    if (!callId || !scenarioId) return res.sendStatus(200);
    if (processedCallIds.has(callId)) return res.sendStatus(200);
    processedCallIds.add(callId);
    setTimeout(() => processedCallIds.delete(callId), 24 * 60 * 60 * 1000);

    const isSuccessful =
      resultName &&
      SUCCESSFUL_RESULT_NAMES.some((n) => resultName.toLowerCase().includes(n.toLowerCase()));
    if (!isSuccessful) return res.sendStatus(200);

    const targetChatId = await getChatIdForScenario(scenarioId);
    if (!targetChatId) {
      console.log("No mapping for scenario:", scenarioId);
      return res.sendStatus(200);
    }

    const managerName = call.user?.name || "Не указан";
    const phone = call.phone || "Не указан";
    const comment = req.body?.call_result?.comment || "нет комментария";
    const startedAt = call.started_at || null;
    const dt = startedAt ? new Date(startedAt) : new Date();
    const formattedDate = dt.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });

    const message = `
    ✅ ПОТЕНЦИАЛЬНЫЙ КЛИЕНТ 

👤 Менеджер: ${managerName}
📞 Телефон: ${phone}
🎯 Результат: ${resultName}
💬 Комментарий: ${comment}

Дата: ${formattedDate}
ID звонка: ${callId}`;

    // wait 2 minutes to allow recording to appear
    await new Promise((r) => setTimeout(r, 180000));

    const sent = await sendAudioToTelegram(callId, message, targetChatId);
    logCall(
      {
        callId,
        scenarioId,
        resultName,
        managerName,
        phone,
        comment,
        startedAt,
      },
      targetChatId
    );

    if (!sent) {
      await bot.telegram.sendMessage(targetChatId, message + "\n\n❌ Запись недоступна.", { parse_mode: "HTML" });
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("webhook handler error:", e);
    return res.sendStatus(500);
  }
});

// ---------- webhook binding ----------
app.use(bot.webhookCallback(`/bot${TG_BOT_TOKEN}`));
if (RAILWAY_PUBLIC_URL) {
  // register webhook at startup (safe to call repeatedly)
  (async () => {
    try {
      await bot.telegram.setWebhook(`${RAILWAY_PUBLIC_URL}/bot${TG_BOT_TOKEN}`);
      console.log("Webhook set to", `${RAILWAY_PUBLIC_URL}/bot${TG_BOT_TOKEN}`);
    } catch (e) {
      console.error("setWebhook error:", e.response?.data || e.message);
    }
  })();
} else {
  console.warn("RAILWAY_PUBLIC_URL not set — webhook must be set manually");
}

// ---------- startup tasks ----------
(async () => {
  try {
    await refreshScenariosCache();
    // load chats into memory (optional)
    const chats = await listChatsFromDb();
    // fill availableChats for quick UI (not required)
    // availableChats = chats;
    console.log("Startup complete");
  } catch (e) {
    console.error("Startup error:", e);
  }
})();

// ---------- start express ----------
app.get("/", (req, res) => res.send("CallSuccess AI Processor"));
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));