require("dotenv").config();
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const { Telegraf, Markup } = require("telegraf");
const db = require('./database.js');

const app = express();
const PORT = process.env.PORT || 3000;

const SUCCESSFUL_RESULT_NAMES = process.env.SUCCESSFUL_RESULT_NAMES
  ? process.env.SUCCESSFUL_RESULT_NAMES.split(",")
  : ["Горячий", "Горячая", "Hot", "Успех"];

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;

app.use(express.json());

const processedCallIds = new Set();
let availableScenarios = []; // Кэш сценариев из Skorozvon

// --- Функции для работы с БД (Promise-based) ---
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

function addScenarioMapping(scenarioId, scenarioName, chatId) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO scenario_mappings (skorozvon_scenario_id, skorozvon_scenario_name, telegram_chat_id) VALUES (?, ?, ?)`,
      [scenarioId, scenarioName, chatId],
      function(err) {
        if (err) reject(err);
        resolve({ id: this.lastID, changes: this.changes });
      }
    );
  });
}

function removeScenarioMapping(scenarioId) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM scenario_mappings WHERE skorozvon_scenario_id = ?`,
      [scenarioId],
      function(err) {
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
    `INSERT OR IGNORE INTO call_logs (call_id, scenario_id, result_name, manager_name, phone, comment, started_at, telegram_chat_id_sent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      callData.callId,
      callData.scenarioId,
      callData.resultName,
      callData.managerName,
      callData.phone,
      callData.comment,
      callData.startedAt,
      targetChatId
    ],
    (err) => { if (err) console.error('Error logging call:', err); }
  );
}

function addAdmin(userId, username) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR IGNORE INTO admin_users (telegram_user_id, username) VALUES (?, ?)`,
      [userId, username],
      function(err) {
        if (err) reject(err);
        resolve({ id: this.lastID, changes: this.changes });
      }
    );
  });
}
// --- Конец функций БД ---

// --- Функции для работы с Skorozvon API ---
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
    if (!accessToken) {
      console.error("Cannot get access token to fetch scenarios");
      return [];
    }

    const response = await axios.get('https://api.skorozvon.ru/api/v2/scenarios', {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (response.data && response.data.data) {
      return response.data.data.map(scenario => ({
        id: scenario.id,
        name: scenario.name,
        system: scenario.system
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
  console.log(`Refreshed scenarios cache. Found ${availableScenarios.length} scenarios.`);
}
// --- Конец функций Skorozvon API ---

// --- Функции для работы с Telegram ---
async function sendAudioToTelegram(callId, caption, targetChatId) {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return false;

    const recordingUrl = `https://api.skorozvon.ru/api/v2/calls/${callId}.mp3?access_token=${accessToken}`;

    const audioResponse = await axios({
      method: "GET",
      url: recordingUrl,
      responseType: "stream",
      timeout: 30000,
    });

    const formData = new FormData();
    formData.append("chat_id", targetChatId);
    formData.append("audio", audioResponse.data);
    formData.append("caption", caption);
    formData.append("parse_mode", "HTML");

    await axios.post(
      `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendAudio`,
      formData,
      {
        headers: formData.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );

    return true;
  } catch (error) {
    console.error("Audio send error for chat", targetChatId, error.message);
    return false;
  }
}

function formatDate(dateString) {
  if (!dateString) return new Date().toLocaleDateString("ru-RU");
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch (error) {
    return new Date().toLocaleDateString("ru-RU");
  }
}
// --- Конец функций Telegram ---

// --- Инициализация и запуск бота ---
const bot = new Telegraf(TG_BOT_TOKEN);

// Обработчик команды /start
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  
  // Добавляем пользователя в админы при первом старте
  await addAdmin(userId, username);
  
  ctx.reply(
    '🤖 Бот для обработки успешных звонков из Skorozvon.\n\n' +
    'Команды:\n' +
    '/setup - Настроить привязку сценариев к группам\n' +
    '/list - Показать текущие привязки\n' +
    '/refresh - Обновить список сценариев из Skorozvon\n\n' +
    'Добавьте бота в нужные группы как администратора!'
  );
});

// Обработчик команды /setup
bot.command('setup', async (ctx) => {
  if (!(await isUserAdmin(ctx.from.id))) {
    return ctx.reply('❌ У вас нет прав для выполнения этой команды.');
  }

  if (availableScenarios.length === 0) {
    await refreshScenariosCache();
  }

  if (availableScenarios.length === 0) {
    return ctx.reply('❌ Не удалось загрузить сценарии из Skorozvon. Проверьте настройки API.');
  }

  ctx.reply(
    'Выберите сценарий для настройки:',
    Markup.inlineKeyboard(
      availableScenarios.map(scenario => [
        Markup.button.callback(
          `${scenario.name} (ID: ${scenario.id})`,
          `select_scenario_${scenario.id}`
        )
      ]),
      { columns: 1 }
    )
  );
});

// Обработчик выбора сценария
bot.action(/select_scenario_(\d+)/, async (ctx) => {
  const scenarioId = ctx.match[1];
  const scenario = availableScenarios.find(s => s.id == scenarioId);
  
  await ctx.editMessageText(
    `Выбран сценарий: ${scenario.name}\n\nТеперь отправьте ID Telegram группы, куда должны приходить уведомления по этому сценарию.\n\nПример: -1001234567890`
  );
  
  // Сохраняем состояние для ожидания ID чата
  ctx.session = ctx.session || {};
  ctx.session.waitingForChatId = scenarioId;
});

// Обработчик текстовых сообщений (для получения ID чата)
bot.on('text', async (ctx) => {
  if (ctx.session && ctx.session.waitingForChatId) {
    const scenarioId = ctx.session.waitingForChatId;
    const chatId = ctx.message.text.trim();
    const scenario = availableScenarios.find(s => s.id == scenarioId);

    // Валидация chatId (должен начинаться с -100 для супергрупп)
    if (!chatId.startsWith('-100')) {
      return ctx.reply('❌ Неверный формат ID группы. ID группы должен начинаться с -100 (например: -1001234567890).');
    }

    try {
      await addScenarioMapping(scenarioId, scenario.name, chatId);
      delete ctx.session.waitingForChatId;
      
      ctx.reply(`✅ Сценарий "${scenario.name}" привязан к группе ${chatId}.`);
    } catch (error) {
      console.error('Add scenario error:', error);
      ctx.reply('❌ Произошла ошибка при добавлении привязки.');
    }
  }
});

// Обработчик команды /list
bot.command('list', async (ctx) => {
  if (!(await isUserAdmin(ctx.from.id))) {
    return ctx.reply('❌ У вас нет прав для выполнения этой команды.');
  }

  try {
    const mappings = await listScenarioMappings();
    if (mappings.length === 0) {
      return ctx.reply('ℹ️ Привязки сценариев не настроены.');
    }

    const message = mappings.map(m =>
      `📋 ${m.skorozvon_scenario_name} (ID: ${m.skorozvon_scenario_id}) → Группа: ${m.telegram_chat_id}`
    ).join('\n\n');

    ctx.reply(`Текущие привязки:\n\n${message}`);
  } catch (error) {
    console.error('List scenarios error:', error);
    ctx.reply('❌ Произошла ошибка при получении списка.');
  }
});

// Обработчик команды /refresh
bot.command('refresh', async (ctx) => {
  if (!(await isUserAdmin(ctx.from.id))) {
    return ctx.reply('❌ У вас нет прав для выполнения этой команды.');
  }

  await ctx.reply('🔄 Обновляю список сценариев из Skorozvon...');
  await refreshScenariosCache();
  
  ctx.reply(`✅ Получено ${availableScenarios.length} сценариев из Skorozvon.`);
});

// Запускаем бота
bot.launch().then(() => {
  console.log('Telegram Bot is running...');
  // Обновляем кэш сценариев при старте
  refreshScenariosCache();
}).catch(err => {
  console.error('Error starting bot:', err);
});

// --- Вебхук обработчик ---
app.post("/webhook", async (req, res) => {
  const callId = req.body?.call?.id;
  const resultName = req.body?.call_result?.result_name;
  const scenarioId = req.body?.call?.scenario_id;

  if (!scenarioId) {
    console.log("Webhook received, but no scenario_id found. Skipping.");
    return res.sendStatus(200);
  }

  if (processedCallIds.has(callId)) {
    console.log("Duplicate webhook skipped:", callId);
    return res.sendStatus(200);
  }
  processedCallIds.add(callId);
  setTimeout(() => processedCallIds.delete(callId), 24 * 60 * 60 * 1000);

  const isSuccessfulCall = resultName && SUCCESSFUL_RESULT_NAMES.some(name =>
    resultName.toLowerCase().includes(name.toLowerCase())
  );

  if (isSuccessfulCall && callId) {
    let targetChatId;
    try {
      targetChatId = await getChatIdForScenario(scenarioId);
    } catch (error) {
      console.error("Error getting target chat for scenario:", scenarioId, error);
      return res.sendStatus(500);
    }

    if (!targetChatId) {
      console.log(`No Telegram chat mapped for scenario ${scenarioId}. Call ${callId} skipped.`);
      return res.sendStatus(200);
    }

    const managerName = req.body?.call?.user?.name || "Не указан";
    const phone = req.body?.call?.phone || "Не указан";
    const comment = req.body?.call_result?.comment || "нет комментария";
    const callStartedAt = req.body?.call?.started_at;
    const formattedDate = formatDate(callStartedAt);

    const message = `
✅ ПОТЕНЦИАЛЬНЫЙ КЛИЕНТ 

👤 Менеджер: ${managerName}
📞 Телефон: ${phone}
🎯 Результат: ${resultName}
💬 Комментарий: ${comment}
🔄 Сценарий ID: ${scenarioId}

Дата: ${formattedDate}
ID звонка: ${callId}`;

    await new Promise((resolve) => setTimeout(resolve, 120000));

    const audioSent = await sendAudioToTelegram(callId, message, targetChatId);

    logCall({
      callId, scenarioId, resultName, managerName, phone, comment, startedAt: callStartedAt
    }, targetChatId);

    if (!audioSent) {
      await axios.post(
        `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,
        {
          chat_id: targetChatId,
          text: message + "\n\n❌ Запись звонка недоступна для скачивания.",
          parse_mode: "HTML",
        }
      );
    }
  }

  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("CallSuccess AI Processor is running with Scenario Routing");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook: http://localhost:${PORT}/webhook`);
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));