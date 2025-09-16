// debug-server.js — временная debug-версия, заменяет server.js на время отладки
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const sqlite3 = require("sqlite3").verbose();
const { Telegraf, Markup } = require("telegraf");

const app = express();

// Парсинг JSON
app.use(express.json({ limit: "1mb" }));

/* ====== Настройки ====== */
const PORT = process.env.PORT || 3000;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const RAILWAY_PUBLIC_URL = process.env.RAILWAY_PUBLIC_URL || "";
const SUCCESSFUL_RESULT_NAMES = process.env.SUCCESSFUL_RESULT_NAMES
  ? process.env.SUCCESSFUL_RESULT_NAMES.split(",")
  : ["Успех", "Горячий", "Горячая", "Hot"];

if (!TG_BOT_TOKEN) {
  console.error("ERROR: TG_BOT_TOKEN is not set in .env");
  process.exit(1);
}
if (!RAILWAY_PUBLIC_URL) {
  console.warn("WARN: RAILWAY_PUBLIC_URL not set — set it to your public url if you want automatic webhook setup.");
}

/* ====== DB (SQLite) - инициализация минимальная (как у тебя) ====== */
const db = new sqlite3.Database("./data.sqlite");
// (инициализация таблиц пропущена здесь, предполагается, что они уже созданы или используем твою версию)

/* ====== Telegraf (webhook mode) ====== */
const bot = new Telegraf(TG_BOT_TOKEN);

// Логируем ВСЕ входящие HTTP-запросы (полезно)
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.originalUrl}`);
  next();
});

// Логгер только для webhook пути (парсит тело уже express.json сделал)
app.post(`/bot${TG_BOT_TOKEN}`, (req, res, next) => {
  console.log("=== ВХОДЯЩИЙ UPDATE от Telegram ===");
  console.log(JSON.stringify(req.body, null, 2));
  // пропускаем дальше к telegraf
  next();
});

// Подключаем telegraf webhook callback на тот же путь
app.use(bot.webhookCallback(`/bot${TG_BOT_TOKEN}`));

// Доп. эндпойнт — возвращает getWebhookInfo от Telegram (для быстрой диагностики)
app.get("/tg/getWebhookInfo", async (req, res) => {
  try {
    const info = await axios.get(`https://api.telegram.org/bot${TG_BOT_TOKEN}/getWebhookInfo`);
    return res.json(info.data);
  } catch (e) {
    return res.status(500).json({ error: e.message, detail: e.response?.data });
  }
});

// Тестовый эндпойнт: отправляет симулированный update на webhook (локально тест)
app.post("/tg/simulate", async (req, res) => {
  // Тело можно передать JSON для message; по умолчанию отправит команду /обновить_сценарии
  const payload = req.body.payload || {
    update_id: Date.now(),
    message: {
      message_id: 1,
      from: { id: 123456789, is_bot: false, first_name: "Debug" },
      chat: { id: 123456789, type: "private", first_name: "Debug" },
      date: Math.floor(Date.now() / 1000),
      text: "/обновить_сценарии"
    }
  };

  try {
    const webhookUrl = `${RAILWAY_PUBLIC_URL}/bot${TG_BOT_TOKEN}`;
    const r = await axios.post(webhookUrl, payload, { headers: { "Content-Type": "application/json" } });
    return res.json({ ok: true, status: r.status });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, detail: e.response?.data });
  }
});

/* ====== Команды (минимальные, для проверки) ====== */
bot.command("обновить_сценарии", async (ctx) => {
  console.log("COMMAND /обновить_сценарии received from", ctx.from.id, "chat", ctx.chat.id);
  await ctx.reply("Понял, обновляю сценарии (debug)..."); // тут можно вызвать refreshScenariosCache
});

bot.command("привязать", async (ctx) => {
  console.log("COMMAND /привязать", ctx.from.id, ctx.chat.id);
  await ctx.reply("Показываю список групп (debug) ...");
});

bot.command("подписки", async (ctx) => {
  console.log("COMMAND /подписки", ctx.from.id, ctx.chat.id);
  await ctx.reply("Показываю подписки (debug) ...");
});

/* ====== Запуск сервера и регистрация вебхука ====== */
app.listen(PORT, async () => {
  console.log(`🌐 Debug server listening on port ${PORT}`);

  // Попытаемся зарегистрировать webhook если RAILWAY_PUBLIC_URL задан
  if (RAILWAY_PUBLIC_URL) {
    const webhookUrl = `${RAILWAY_PUBLIC_URL}/bot${TG_BOT_TOKEN}`;
    try {
      const resp = await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/setWebhook`, null, {
        params: { url: webhookUrl }
      });
      console.log("setWebhook response:", resp.data);
    } catch (e) {
      console.error("setWebhook error:", e.response?.data || e.message);
    }
  } else {
    console.log("RAILWAY_PUBLIC_URL not set — skip setWebhook");
  }

  console.log("Теперь: отправь боту в личке /обновить_сценарии и смотри логи Railway.");
});

// глобальная обработка ошибок
process.on("unhandledRejection", (err) => {
  console.error("UnhandledRejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("UncaughtException:", err);
});