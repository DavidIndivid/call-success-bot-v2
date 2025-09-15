require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const SUCCESSFUL_RESULT_NAMES = process.env.SUCCESSFUL_RESULT_NAMES
  ? process.env.SUCCESSFUL_RESULT_NAMES.split(",")
  : ["Успех", "Горячий", "Горячая", "Hot"];

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

app.use(express.json());

app.get("/", (req, res) => {
  res.send("CallSuccess AI Processor is alive!");
});

// Берём новый access_token
async function getAccessToken() {
  try {
    const response = await axios.post("https://api.skorozvon.ru/oauth/token", null, {
      params: {
        grant_type: "password",
        username: process.env.SKOROZVON_USERNAME,
        api_key: process.env.SKOROZVON_API_KEY,
        client_id: process.env.SKOROZVON_CLIENT_ID,
        client_secret: process.env.SKOROZVON_CLIENT_SECRET,
      },
    });

    return response.data.access_token;
  } catch (err) {
    console.error("❌ Ошибка при получении токена:", err.response?.data || err.message);
    throw err;
  }
}

app.post("/webhook", async (req, res) => {
  console.log("=== ВЕБХУК ПОЛУЧЕН ===");
  console.log("Время:", new Date().toISOString());
  console.log("RAW ВЕБХУК:", JSON.stringify(req.body, null, 2));

  try {
    const resultName = req.body?.call_result?.result_name;
    const callDuration = req.body?.call?.duration || 0;
    const callId = req.body?.call?.id;

    console.log("--- АНАЛИЗ СТРУКТУРЫ ---");
    console.log("Название результата:", resultName);
    console.log("Длительность звонка:", callDuration, "сек");
    console.log("ID звонка:", callId);

    const isSuccessfulCall =
      resultName &&
      SUCCESSFUL_RESULT_NAMES.some((name) =>
        resultName.toLowerCase().includes(name.toLowerCase())
      );

    if (isSuccessfulCall) {
      console.log("ОБНАРУЖЕН ПОТЕНЦИАЛЬНЫЙ КЛИЕНТ!");

      const managerName = req.body?.call?.user?.name || "Менеджер не указан";
      const organizationName = req.body?.lead?.name || "Неизвестная организация";
      const phone = req.body?.call?.phone || "Телефон не указан";
      const comment = req.body?.call_result?.comment || "нет комментария";

      // ждём ровно 2 минуты
      console.log("Жду 2 минуты, чтобы запись успела появиться...");
      await new Promise((resolve) => setTimeout(resolve, 120000));

      // 1️⃣ Пытаемся взять готовую ссылку из вебхука
      let recordingLink = req.body?.call?.recording_url;

      // 2️⃣ Если её нет — fallback через calls/{id}.mp3
      if (!recordingLink && callId) {
        const token = await getAccessToken();
        recordingLink = `https://api.skorozvon.ru/api/v2/calls/${callId}.mp3?access_token=${token}`;
      }

      const message = `✅ ПОТЕНЦИАЛЬНЫЙ КЛИЕНТ

👤 Менеджер: ${managerName}
🏢 Организация: ${organizationName}
📞 Телефон: ${phone}
🎯 Результат: ${resultName}
⏱️ Длительность: ${callDuration} сек
💬 Комментарий: ${comment}
🔗 Ссылка на запись: ${recordingLink || "Запись недоступна"}

ID звонка: ${callId}`;

      const telegramApiUrl = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;

      console.log("📨 Отправляю сообщение в Telegram...");

      await axios.post(telegramApiUrl, {
        chat_id: TG_CHAT_ID,
        text: message,
        parse_mode: "HTML",
        reply_markup: recordingLink
          ? {
              inline_keyboard: [
                [
                  {
                    text: "🎧 Прослушать запись разговора",
                    url: recordingLink,
                  },
                ],
              ],
            }
          : {},
      });

      console.log("Сообщение отправлено в Telegram");
    } else {
      console.log("Пропускаем — не успешный звонок");
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Ошибка при обработке вебхука:", error.message);
    if (error.response) {
      console.error("Детали ошибки Telegram API:", error.response.data);
    }
    res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Вебхук для Skorozvon: http://localhost:${PORT}/webhook`);
  console.log(
    `Ожидаю звонки с результатами: ${SUCCESSFUL_RESULT_NAMES.join(", ")}`
  );
});