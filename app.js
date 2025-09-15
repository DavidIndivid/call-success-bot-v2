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

// Функция для отправки аудио в Telegram
async function sendAudioToTelegram(filePath, callId, caption) {
  try {
    const formData = new FormData();
    formData.append('chat_id', TG_CHAT_ID);
    formData.append('audio', fs.createReadStream(filePath));
    formData.append('caption', caption);
    formData.append('parse_mode', 'HTML');

    const response = await axios.post(
      `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendAudio`,
      formData,
      {
        headers: formData.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      }
    );

    console.log("Аудио отправлено в Telegram");
    return true;
  } catch (error) {
    console.error("Ошибка при отправке аудио:", error.message);
    return false;
  }
}

app.post("/webhook", async (req, res) => {
  console.log("=== ВЕБХУК ПОЛУЧЕН ===");
  console.log("Время:", new Date().toISOString());

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

    if (isSuccessfulCall && callId) {
      console.log("ОБНАРУЖЕН УСПЕШНЫЙ ЗВОНОК!");

      const managerName = req.body?.call?.user?.name || "Менеджер не указан";
      const clientName = req.body?.lead?.name || req.body?.contact?.name || "Клиент не указан";
      const organizationName = req.body?.lead?.name || "Организация не указана";
      const phone = req.body?.call?.phone || "Телефон не указан";
      const comment = req.body?.call_result?.comment || "нет комментария";

      // Сначала отправляем текстовое сообщение
      const message = `✅ УСПЕШНЫЙ ЗВОНОК

👤 Менеджер: ${managerName}
👥 Клиент: ${clientName}
🏢 Организация: ${organizationName}
📞 Телефон: ${phone}
🎯 Результат: ${resultName}
⏱️ Длительность: ${callDuration} сек
💬 Комментарий: ${comment}

ID звонка: ${callId}`;

      console.log("📨 Отправляю текстовое сообщение в Telegram...");
      await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        chat_id: TG_CHAT_ID,
        text: message,
        parse_mode: "HTML"
      });

      // Ждем 2 минуты для появления записи
      console.log("Жду 2 минуты, чтобы запись успела появиться...");
      await new Promise((resolve) => setTimeout(resolve, 120000));

      // Пытаемся скачать и отправить аудио
      const audioFilePath = await downloadRecording(callId);
      
      if (audioFilePath) {
        const audioCaption = `🎧 Запись успешного звонка\nID: ${callId}`;
        const audioSent = await sendAudioToTelegram(audioFilePath, callId, audioCaption);
        
        if (audioSent) {
          console.log("Аудио успешно отправлено");
        }
        
        // Удаляем временный файл
        try {
          fs.unlinkSync(audioFilePath);
          console.log("Временный файл удален");
        } catch (err) {
          console.error("Ошибка при удалении файла:", err.message);
        }
      } else {
        console.log("Не удалось скачать запись звонка");
        
        // Отправляем сообщение о том, что запись недоступна
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
          chat_id: TG_CHAT_ID,
          text: `❌ Не удалось получить запись звонка ${callId}`,
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
  console.log(`Ожидаю успешные звонки: ${SUCCESSFUL_RESULT_NAMES.join(", ")}`);
});