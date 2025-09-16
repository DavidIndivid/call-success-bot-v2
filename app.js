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

// Helper function to check if user is main admin (from .env)
function isMainAdmin(userId) {
  return MAIN_ADMINS.includes(userId.toString());
}

// Helper function to check if user has admin rights (either main admin or in database)
async function hasAdminRights(userId) {
  return isMainAdmin(userId) || await db.isAdministrator(userId);
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
  if (await hasAdminRights(userId)) {
    ctx.reply(
      "🤖 Bot for processing Skorozvon calls.\n\n" +
      "/setup - Bind scenarios\n" +
      "/list - Show bindings\n" +
      "/refresh - Refresh scenarios\n" +
      "/chats - Show available chats\n" +
      (isMainAdmin(userId) ? "/admins - Manage administrators\n" : "") +
      "/myid - Show my user info"
    );
  } else {
    ctx.reply("❌ Access denied. Contact the main admin.");
  }
});

// Show user ID
bot.command("myid", async ctx => {
  const user = ctx.from;
  ctx.reply(
    `👤 Your info:\n\n` +
    `ID: <code>${user.id}</code>\n` +
    `Username: @${user.username || 'none'}\n` +
    `Name: ${user.first_name}${user.last_name ? ' ' + user.last_name : ''}`,
    { parse_mode: 'HTML' }
  );
});

// Admin management (only for main admins)
bot.command("admins", async ctx => {
  if (!isMainAdmin(ctx.from.id.toString())) {
    return ctx.reply("❌ Only main administrators can manage admins.");
  }

  const admins = await db.listAdministrators();
  const mainAdmins = MAIN_ADMINS.map(id => ({ telegram_user_id: id, username: 'MAIN_ADMIN' }));
  const allAdmins = [...mainAdmins, ...admins];

  ctx.reply(
    "👑 Administrator Management:\n\n" +
    allAdmins.map(admin => 
      `• ${admin.username || 'No username'} (ID: ${admin.telegram_user_id})` +
      (MAIN_ADMINS.includes(admin.telegram_user_id.toString()) ? " 👑" : "")
    ).join('\n'),
    Markup.inlineKeyboard([
      [Markup.button.callback('➕ Add Admin', 'add_admin')],
      [Markup.button.callback('➖ Remove Admin', 'remove_admin')]
    ])
  );
});

// Add admin callback
bot.action('add_admin', async ctx => {
  if (!isMainAdmin(ctx.from.id.toString())) return;
  ctx.editMessageText("Send the user's ID or @username to add as administrator:");
  ctx.session = { adminAction: 'add' };
});

// Remove admin callback
bot.action('remove_admin', async ctx => {
  if (!isMainAdmin(ctx.from.id.toString())) return;
  
  const admins = await db.listAdministrators();
  if (admins.length === 0) {
    return ctx.editMessageText("❌ No additional administrators to remove.");
  }

  ctx.editMessageText(
    "Select administrator to remove:",
    Markup.inlineKeyboard(
      admins.map(admin => [
        Markup.button.callback(
          `@${admin.username || 'unknown'} (${admin.telegram_user_id})`,
          `remove_admin_${admin.telegram_user_id}`
        )
      ]),
      { columns: 1 }
    )
  );
});

// Remove specific admin
bot.action(/remove_admin_(\d+)/, async ctx => {
  if (!isMainAdmin(ctx.from.id.toString())) return;
  
  const userId = ctx.match[1];
  try {
    await db.removeAdministrator(userId);
    ctx.editMessageText(`✅ Administrator with ID ${userId} removed.`);
  } catch (error) {
    console.error('Remove admin error:', error);
    ctx.editMessageText('❌ Error removing administrator.');
  }
});

// Process admin add/remove messages
bot.on('text', async ctx => {
  await updateAvailableChats(ctx);
  
  if (ctx.session?.adminAction === 'add' && isMainAdmin(ctx.from.id.toString())) {
    const input = ctx.message.text.trim();
    let userId, username;

    if (input.startsWith('@')) {
      // Username provided
      username = input.replace('@', '');
      ctx.reply("❌ Cannot add by username alone. Please provide user ID. Use /myid to get user ID.");
    } else if (/^\d+$/.test(input)) {
      // User ID provided
      userId = input;
      username = ctx.from.username || 'unknown';
      
      try {
        await db.addAdministrator(userId, username);
        ctx.reply(`✅ User with ID ${userId} added as administrator.`);
      } catch (error) {
        console.error('Add admin error:', error);
        ctx.reply('❌ Error adding administrator.');
      }
    } else {
      ctx.reply("❌ Invalid input. Please provide a user ID (numbers only).");
    }
    
    delete ctx.session.adminAction;
  }
});

// Existing commands with updated permission checks
bot.command("setup", async ctx => {
  if (!await hasAdminRights(ctx.from.id.toString())) return ctx.reply("❌ No rights.");
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
  if (!await hasAdminRights(ctx.from.id.toString())) return;
  
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
  if (!await hasAdminRights(ctx.from.id.toString())) return;
  
  const scenarioId = ctx.match[1];
  const chatId = ctx.match[2];
  const scenario = availableScenarios.find(s => s.id == scenarioId);
  const chat = availableChats.find(c => c.id == chatId);
  await db.addScenarioMapping(scenarioId, scenario.name, chatId, chat.title);
  ctx.editMessageText(`✅ Scenario "${scenario.name}" bound to "${chat.title}".`);
});

bot.command("list", async ctx => {
  if (!await hasAdminRights(ctx.from.id.toString())) return ctx.reply("❌ No rights.");
  const mappings = await db.listScenarioMappings();
  if (mappings.length === 0) return ctx.reply("ℹ️ No bindings set.");
  ctx.reply(mappings.map(m => `📋 ${m.skorozvon_scenario_name} → ${m.telegram_chat_title}`).join("\n\n"));
});

bot.command("refresh", async ctx => {
  if (!await hasAdminRights(ctx.from.id.toString())) return ctx.reply("❌ No rights.");
  await refreshScenariosCache();
  ctx.reply(`✅ Loaded ${availableScenarios.length} scenarios.`);
});

bot.command("chats", async ctx => {
  if (!await hasAdminRights(ctx.from.id.toString())) return ctx.reply("❌ No rights.");
  if (availableChats.length === 0) return ctx.reply("ℹ️ No chats available.");
  ctx.reply(availableChats.map(c => `💬 ${c.title} (ID: ${c.id})`).join("\n"));
});

bot.on("message", updateAvailableChats);

// Initialize main admins on startup
async function initializeMainAdmins() {
  for (const adminId of MAIN_ADMINS) {
    try {
      await db.addAdministrator(adminId, 'MAIN_ADMIN');
      console.log(`Main admin initialized: ${adminId}`);
    } catch (error) {
      console.error(`Error initializing main admin ${adminId}:`, error);
    }
  }
}

bot.launch().then(() => {
  console.log("Telegram Bot is running...");
  initializeMainAdmins().then(() => {
    refreshScenariosCache();
  });
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

  let targetChatId = await db.getChatIdForScenario(scenarioId);
  if (!targetChatId) {
    console.log(`⚠️ No mapping for scenario ${scenarioId}, skipping.`);
    return res.sendStatus(200);
  }

  const manager = req.body?.call?.user?.name || "Оператор";
  const phone = req.body?.call?.phone || "Не указан";
  const comment = req.body?.call_result?.comment || "Нет комментария";
  const startedAt = req.body?.call?.started_at;
  const formattedDate = new Date(startedAt || Date.now()).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit", 
    year: "numeric"
  });

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
      text: message + "\n\n❌ Запись недоступна",
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