require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

const app = express();
const PORT = process.env.PORT || 3000;

const SUCCESSFUL_RESULT_NAMES = process.env.SUCCESSFUL_RESULT_NAMES
  ? process.env.SUCCESSFUL_RESULT_NAMES.split(",")
  : ["Успех", "Горячий", "Горячая", "Hot"];

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

app.use(express.json());

// Создаем папку для временных файлов
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

app.get("/", (req, res) => {
  res.send("CallSuccess AI Processor is alive!");
});

// Функция для получения access_token
async function getAccessToken() {
  try {
    console.log("Получаю access_token...");
    
    const response = await axios({
      method: 'post',
      url: 'https://api.skorozvon.ru/oauth/token',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      data: new URLSearchParams({
        grant_type: 'password',
        username: process.env.SKOROZVON_USERNAME,
        api_key: process.env.SKOROZVON_API_KEY,
        client_id: process.env.SKOROZVON_CLIENT_ID,
        client_secret: process.env.SKOROZVON_CLIENT_SECRET
      })
    });

    console.log("Access token получен успешно");
    return response.data.access_token;
  } catch (error) {
    console.error("❌ Ошибка при получении токена:", error.response?.data || error.message);
    return null;
  }
}

// Функция для скачивания записи
async function downloadRecording(callId) {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      console.error('Не удалось получить access token');
      return null;
    }

    const recordingUrl = `https://api.skorozvon.ru/api/v2/calls/${callId}.mp3?access_token=${accessToken}`;
    console.log("Скачиваю запись по URL:", recordingUrl);
    
    const response = await axios({
      method: 'GET',
      url: recordingUrl,
      responseType: 'stream',
      timeout: 30000
    });

    const filePath = path.join(tempDir, `${callId}.mp3`);
    const writer = fs.createWriteStream(filePath);
    
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log("Запись успешно скачана:", filePath);
        resolve(filePath);
      });
      writer.on('error', reject);
    });
    
  } catch (error) {
    console.error("Ошибка при скачивании записи:", error.message);
    if (error.response) {
      console.error("Статус ошибки:", error.response.status);
    }
    return null;
  }
}

// Функция для форматирования даты (только дата без времени)
function formatDate(dateString) {
  if (!dateString) return "Дата не указана";
  
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  } catch (error) {
    return "Дата не указана";
  }
}

app.post("/webhook", async (req, res) => {
  console.log("=== ВЕБХУК ПОЛУЧЕН ===");
  console.log("Время:", new Date().toISOString());

  try {
    const resultName = req.body?.call_result?.result_name;
    const callDuration = req.body?.call?.duration || 0;
    const callId = req.body?.call?.id;
    const callStartedAt = req.body?.call?.started_at;

    console.log("--- АНАЛИЗ СТРУКТУРЫ ---");
    console.log("Название результата:", resultName);
    console.log("Длительность звонка:", callDuration, "сек");
    console.log("ID звонка:", callId);
    console.log("Дата звонка:", callStartedAt);

    const isSuccessfulCall =
      resultName &&
      SUCCESSFUL_RESULT_NAMES.some((name) =>
        resultName.toLowerCase().includes(name.toLowerCase())
      );

    if (isSuccessfulCall && callId) {
      console.log("ОБНАРУЖЕН ПОТЕНЦИАЛЬНЫЙ КЛИЕНТ!");

      const managerName = req.body?.call?.user?.name || "Менеджер не указан";
      const phone = req.body?.call?.phone || "Телефон не указан";
      const comment = req.body?.call_result?.comment || "нет комментария";
      
      // Форматируем дату (только дата без времени)
      const formattedDate = formatDate(callStartedAt);

      // Форматируем сообщение для подписи к аудио
      const message = `🎧 [Аудиозапись]
✅ ПОТЕНЦИАЛЬНЫЙ КЛИЕНТ 

👤 Менеджер: ${managerName}
📞 Телефон: ${phone}
🎯 Результат: ${resultName}
💬 Комментарий: ${comment}

Дата: ${formattedDate}
ID звонка: ${callId}`;

      // Ждем 2 минуты для появления записи
      console.log("Жду 2 минуты, чтобы запись успела появиться...");
      await new Promise((resolve) => setTimeout(resolve, 120000));

      // Пытаемся скачать и отправить аудио С ТЕКСТОМ В ПОДПИСИ
      const audioFilePath = await downloadRecording(callId);
      
      if (audioFilePath) {
        // Отправляем ОДНО сообщение с аудио и текстом
        const formData = new FormData();
        formData.append('chat_id', TG_CHAT_ID);
        formData.append('audio', fs.createReadStream(audioFilePath));
        formData.append('caption', message); // Текст идет как подпись к аудио
        formData.append('parse_mode', 'HTML');

        await axios.post(
          `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendAudio`,
          formData,
          {
            headers: formData.getHeaders(),
            maxContentLength: Infinity,
            maxBodyLength: Infinity
          }
        );

        console.log("Аудио с текстом отправлено в Telegram в одном сообщении");
        
        // Удаляем временный файл
        try {
          fs.unlinkSync(audioFilePath);
          console.log("Временный файл удален");
        } catch (err) {
          console.error("Ошибка при удалении файла:", err.message);
        }
      } else {
        // Если не удалось скачать аудио, отправляем только текст
        console.log("Не удалось скачать аудио, отправляю только текст");
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
          chat_id: TG_CHAT_ID,
          text: message + "\n\n❌ Запись разговора недоступна",
          parse_mode: "HTML"
        });
      }

    } else {
      console.log("Пропускаем - не успешный звонок или отсутствует ID звонка");
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Ошибка при обработке вебхука:", error.message);
    if (error.response) {
      console.error("Детали ошибки:", error.response.data);
    }
    res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Вебхук для Skorozvon: http://localhost:${PORT}/webhook`);
  console.log(`Ожидаю звонки с результатами: ${SUCCESSFUL_RESULT_NAMES.join(", ")}`);
});