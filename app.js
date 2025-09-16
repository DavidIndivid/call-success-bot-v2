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
const MAIN_ADMIN_ID = process.env.MAIN_ADMIN_ID;

app.use(express.json());

const processedCallIds = new Set();
let availableScenarios = [];
let availableChats = [];

// Database functions
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
      `INSERT OR IGNORE INTO admin_users (telegram_user_id, username) VALUES (?, ?)`,
      [userId, username],
      function(err) {
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
      function(err) {
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

// Skorozvon API functions
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

// Telegram functions
async function checkBotAdminRights(chatId) {
  try {
    const response = await axios.get(`https://api.telegram.org/bot${TG_BOT_TOKEN}/getChatMember`, {
      params: {
        chat_id: chatId,
        user_id: (await bot.telegram.getMe()).id
      }
    });
    
    const status = response.data.result.status;
    return status === 'administrator' || status === 'creator';
  } catch (error) {
    console.error(`Error checking admin rights for chat ${chatId}:`, error.message);
    return false;
  }
}

async function updateAvailableChats(ctx) {
  try {
    if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
      const chatId = ctx.chat.id;
      
      const isAdmin = await checkBotAdminRights(chatId);
      
      if (isAdmin) {
        const chatTitle = ctx.chat.title || `Чат ${chatId}`;
        
        const existingChatIndex = availableChats.findIndex(chat => chat.id === chatId);
        
        if (existingChatIndex === -1) {
          availableChats.push({
            id: chatId,
            title: chatTitle,
            type: ctx.chat.type,
            updatedAt: new Date()
          });
          console.log(`Added admin chat: ${chatTitle} (${chatId})`);
        } else {
          if (availableChats[existingChatIndex].title !== chatTitle) {
            availableChats[existingChatIndex].title = chatTitle;
            availableChats[existingChatIndex].updatedAt = new Date();
            console.log(`Updated chat title: ${chatTitle} (${chatId})`);
          }
        }
      } else {
        const index = availableChats.findIndex(chat => chat.id === chatId);
        if (index !== -1) {
          console.log(`Removing chat ${chatId} - bot is no longer admin`);
          availableChats.splice(index, 1);
        }
      }
    }
  } catch (error) {
    console.error("Error updating chats:", error.message);
  }
}

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

// Bot initialization
const bot = new Telegraf(TG_BOT_TOKEN);

bot.use(async (ctx, next) => {
  await updateAvailableChats(ctx);
  await next();
});

// Command handlers
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  
  if (userId.toString() === MAIN_ADMIN_ID) {
    await addAdmin(userId, username);
    ctx.reply(
      '🤖 Бот для обработки успешных звонков из Skorozvon.\n\n' +
      'Команды:\n' +
      '/setup - Настроить привязку сценариев\n' +
      '/list - Показать текущие привязки\n' +
      '/refresh - Обновить список сценариев\n' +
      '/admins - Управление администраторами\n' +
      '/chats - Показать доступные чаты\n' +
      '/clean_chats - Очистить список чатов\n\n' +
      'Добавьте бота в группы как администратора!'
    );
  } else {
    ctx.reply(
      '🤖 Бот для обработки успешных звонков из Skorozvon.\n\n' +
      'Обратитесь к главному администратору для доступа.'
    );
  }
});

bot.command('clean_chats', async (ctx) => {
  if (!(await isUserAdmin(ctx.from.id))) {
    return ctx.reply('❌ Нет прав для выполнения команды.');
  }

  const oldCount = availableChats.length;
  availableChats = [];
  
  ctx.reply(`♻️ Список чатов очищен. Было: ${oldCount} чатов.\n\nОтправьте сообщение в группах для добавления.`);
});

bot.command('setup', async (ctx) => {
  if (!(await isUserAdmin(ctx.from.id))) {
    return ctx.reply('❌ Нет прав для выполнения команды.');
  }

  if (availableScenarios.length === 0) {
    await refreshScenariosCache();
  }

  if (availableScenarios.length === 0) {
    return ctx.reply('❌ Не удалось загрузить сценарии.');
  }

  if (availableChats.length === 0) {
    return ctx.reply('❌ Нет доступных чатов.');
  }

  ctx.reply(
    'Выберите сценарий для настройки:',
    Markup.inlineKeyboard(
      availableScenarios.map(scenario => [
        Markup.button.callback(
          `${scenario.name}`,
          `select_scenario_${scenario.id}`
        )
      ]),
      { columns: 1 }
    )
  );
});

bot.action(/select_scenario_(\d+)/, async (ctx) => {
  const scenarioId = ctx.match[1];
  const scenario = availableScenarios.find(s => s.id == scenarioId);
  
  ctx.reply(
    `Выбран сценарий: ${scenario.name}\n\nВыберите группу для уведомлений:`,
    Markup.inlineKeyboard(
      availableChats.map(chat => [
        Markup.button.callback(
          `${chat.title}`,
          `select_chat_${scenarioId}_${chat.id}`
        )
      ]),
      { columns: 1 }
    )
  );
});

bot.action(/select_chat_(\d+)_(-?\d+)/, async (ctx) => {
  const scenarioId = ctx.match[1];
  const chatId = ctx.match[2];
  const scenario = availableScenarios.find(s => s.id == scenarioId);
  const chat = availableChats.find(c => c.id == chatId);

  try {
    await addScenarioMapping(scenarioId, scenario.name, chatId, chat.title);
    ctx.editMessageText(`✅ Сценарий "${scenario.name}" привязан к группе "${chat.title}".`);
  } catch (error) {
    console.error('Add scenario error:', error);
    ctx.editMessageText('❌ Ошибка при добавлении привязки.');
  }
});

bot.command('list', async (ctx) => {
  if (!(await isUserAdmin(ctx.from.id))) {
    return ctx.reply('❌ Нет прав для выполнения команды.');
  }

  try {
    const mappings = await listScenarioMappings();
    if (mappings.length === 0) {
      return ctx.reply('ℹ️ Привязки не настроены.');
    }

    const message = mappings.map(m =>
      `📋 ${m.skorozvon_scenario_name} → Группа: ${m.telegram_chat_title}`
    ).join('\n\n');

    ctx.reply(`Текущие привязки:\n\n${message}`);
  } catch (error) {
    console.error('List scenarios error:', error);
    ctx.reply('❌ Ошибка при получении списка.');
  }
});

bot.command('refresh', async (ctx) => {
  if (!(await isUserAdmin(ctx.from.id))) {
    return ctx.reply('❌ Нет прав для выполнения команды.');
  }

  await ctx.reply('🔄 Обновляю сценарии...');
  await refreshScenariosCache();
  ctx.reply(`✅ Получено ${availableScenarios.length} сценариев.`);
});

bot.command('chats', async (ctx) => {
  if (!(await isUserAdmin(ctx.from.id))) {
    return ctx.reply('❌ Нет прав для выполнения команды.');
  }

  if (availableChats.length === 0) {
    return ctx.reply('ℹ️ Нет доступных чатов.');
  }

  const message = availableChats.map(chat =>
    `💬 ${chat.title} (ID: ${chat.id})`
  ).join('\n\n');

  ctx.reply(`Доступные чаты:\n\n${message}`);
});

bot.command('admins', async (ctx) => {
  if (ctx.from.id.toString() !== MAIN_ADMIN_ID) {
    const admins = await listAdmins();
    if (admins.length === 0) {
      return ctx.reply('ℹ️ Администраторы не назначены.');
    }
    
    const message = admins.map(admin =>
      `👤 @${admin.username || 'unknown'} (ID: ${admin.telegram_user_id})`
    ).join('\n');

    return ctx.reply(`Текущие администраторы:\n\n${message}`);
  }

  const admins = await listAdmins();
  ctx.reply(
    'Управление администраторами:',
    Markup.inlineKeyboard([
      [Markup.button.callback('➕ Добавить админа', 'add_admin')],
      [Markup.button.callback('➖ Удалить админа', 'remove_admin')],
      [Markup.button.callback('📋 Список админов', 'list_admins')]
    ])
  );
});

bot.action('add_admin', async (ctx) => {
  await ctx.editMessageText(
    'Выберите способ добавления:\n\n' +
    '1. 📧 По username (@username)\n' +
    '2. ➡️ Перешлите сообщение\n' +
    '3. 🔢 По ID',
    Markup.inlineKeyboard([
      [Markup.button.callback('📧 По username', 'add_by_username')],
      [Markup.button.callback('➡️ Переслать сообщение', 'add_by_forward')],
      [Markup.button.callback('🔢 По ID', 'add_by_id')]
    ])
  );
});

bot.action('add_by_username', async (ctx) => {
  await ctx.editMessageText('Отправьте username (@username или username):');
  ctx.session = { waitingForAdmin: 'username' };
});

bot.action('add_by_forward', async (ctx) => {
  await ctx.editMessageText('Перешлите сообщение от пользователя:');
  ctx.session = { waitingForAdmin: 'forward' };
});

bot.action('add_by_id', async (ctx) => {
  await ctx.editMessageText('Отправьте ID пользователя:');
  ctx.session = { waitingForAdmin: 'id' };
});

bot.action('remove_admin', async (ctx) => {
  const admins = await listAdmins();
  await ctx.editMessageText(
    'Выберите администратора для удаления:',
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

bot.action('list_admins', async (ctx) => {
  const admins = await listAdmins();
  const message = admins.map(admin =>
    `👤 @${admin.username || 'unknown'} (ID: ${admin.telegram_user_id})`
  ).join('\n');

  ctx.editMessageText(`Текущие администраторы:\n\n${message}`);
});

bot.action(/remove_admin_(\d+)/, async (ctx) => {
  const userId = ctx.match[1];
  try {
    await removeAdmin(userId);
    ctx.editMessageText(`✅ Администратор с ID ${userId} удален.`);
  } catch (error) {
    console.error('Remove admin error:', error);
    ctx.editMessageText('❌ Ошибка при удалении администратора.');
  }
});

bot.command('add_admin', async (ctx) => {
  if (ctx.from.id.toString() !== MAIN_ADMIN_ID) {
    return ctx.reply('❌ Только главный администратор может добавлять администраторов.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    return ctx.reply('Использование: /add_admin <user_id>');
  }

  const userId = args[0];
  if (!/^\d+$/.test(userId)) {
    return ctx.reply('❌ Неверный формат ID.');
  }

  try {
    await addAdmin(parseInt(userId), 'unknown');
    ctx.reply(`✅ Пользователь с ID ${userId} добавлен в администраторы.`);
  } catch (error) {
    console.error('Add admin error:', error);
    ctx.reply('❌ Ошибка при добавлении администратора.');
  }
});

bot.command('myid', (ctx) => {
  const user = ctx.from;
  ctx.reply(
    `👤 Ваша информация:\n\n` +
    `ID: <code>${user.id}</code>\n` +
    `Username: @${user.username || 'не установлен'}\n` +
    `Имя: ${user.first_name}${user.last_name ? ' ' + user.last_name : ''}\n\n` +
    `Для добавления в администраторы отправьте главному админу:\n` +
    `<code>/add_admin ${user.id}</code> или перешлите это сообщение`,
    { parse_mode: 'HTML' }
  );
});

bot.on('message', async (ctx) => {
  await updateAvailableChats(ctx);
  
  if (ctx.session && ctx.session.waitingForAdmin === 'forward' && ctx.message.forward_from) {
    const user = ctx.message.forward_from;
    try {
      await addAdmin(user.id, user.username || 'unknown');
      delete ctx.session.waitingForAdmin;
      ctx.reply(`✅ Пользователь @${user.username || user.id} (ID: ${user.id}) добавлен в администраторы.`);
    } catch (error) {
      console.error('Add admin error:', error);
      ctx.reply('❌ Ошибка при добавлении администратора.');
    }
    return;
  }
});

bot.on('text', async (ctx) => {
  if (ctx.session && ctx.session.waitingForAdmin) {
    const input = ctx.message.text.trim();
    
    try {
      let userId, username;
      
      if (ctx.session.waitingForAdmin === 'username') {
        const cleanUsername = input.replace('@', '').trim();
        if (!cleanUsername) {
          return ctx.reply('❌ Username не может быть пустым.');
        }
        userId = ctx.from.id;
        username = cleanUsername;
      } else if (ctx.session.waitingForAdmin === 'id') {
        if (!/^\d+$/.test(input)) {
          return ctx.reply('❌ Неверный формат ID.');
        }
        userId = parseInt(input);
        username = 'unknown';
      }
      
      if (userId) {
        await addAdmin(userId, username);
        delete ctx.session.waitingForAdmin;
        ctx.reply(`✅ Пользователь ${ctx.session.waitingForAdmin === 'username' ? '@' + username : 'с ID ' + userId} добавлен в администраторы.`);
      }
    } catch (error) {
      console.error('Add admin error:', error);
      ctx.reply('❌ Ошибка при добавлении администратора.');
    }
  }
});

// Bot launch
bot.launch().then(() => {
  console.log('Telegram Bot is running...');
  if (MAIN_ADMIN_ID) {
    addAdmin(MAIN_ADMIN_ID, 'main_admin');
  }
  refreshScenariosCache();
}).catch(err => {
  console.error('Error starting bot:', err);
});

// Webhook handler
app.post("/webhook", async (req, res) => {
  const callId = req.body?.call?.id;
  const resultName = req.body?.call_result?.result_name;
  const scenarioId = req.body?.call?.scenario_id;

  if (!scenarioId) {
    return res.sendStatus(200);
  }

  if (processedCallIds.has(callId)) {
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
          text: message + "\n\n❌ Запись недоступна.",
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

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));