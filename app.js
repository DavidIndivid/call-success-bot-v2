require("dotenv").config();
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");

const app = express();
const PORT = process.env.PORT || 3000;

const SUCCESSFUL_RESULT_NAMES = process.env.SUCCESSFUL_RESULT_NAMES
  ? process.env.SUCCESSFUL_RESULT_NAMES.split(",")
  : ["Горячий", "Горячая", "Hot", "Успех"];

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

app.use(express.json());

const processedCallIds = new Set();

app.get("/", (req, res) => {
  res.send("CallSuccess AI Processor is running");
});

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

async function sendAudioToTelegram(callId, caption) {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return false;

    const recordingUrl = https://api.skorozvon.ru/api/v2/calls/${callId}.mp3?access_token=${accessToken};

    const audioResponse = await axios({
      method: "GET",
      url: recordingUrl,
      responseType: "stream",
      timeout: 30000,
    });

    const formData = new FormData();
    formData.append("chat_id", TG_CHAT_ID);
    formData.append("audio", audioResponse.data);
    formData.append("caption", caption);
    formData.append("parse_mode", "HTML");

    await axios.post(
      https://api.telegram.org/bot${TG_BOT_TOKEN}/sendAudio,
      formData,
      {
        headers: formData.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );

    return true;
  } catch (error) {
    console.error("Audio send error:", error.message);
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

app.post("/webhook", async (req, res) => {
  const callId = req.body?.call?.id;
  const resultName = req.body?.call_result?.result_name;

  if (processedCallIds.has(callId)) {
    console.log("Duplicate webhook skipped:", callId);
    return res.sendStatus(200);
  }
  processedCallIds.add(callId);

  setTimeout(() => processedCallIds.delete(callId), 24 * 60 * 60 * 1000);

  const isSuccessfulCall =
    resultName &&
    SUCCESSFUL_RESULT_NAMES.some((name) =>
      resultName.toLowerCase().includes(name.toLowerCase())
    );

  if (isSuccessfulCall && callId) {
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

Дата: ${formattedDate}
ID звонка: ${callId}`;

    await new Promise((resolve) => setTimeout(resolve, 120000));

    const audioSent = await sendAudioToTelegram(callId, message);

    if (!audioSent) {
      await axios.post(
        https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage,
        {
          chat_id: TG_CHAT_ID,
          text: message + "\n\n❌ Запись недоступна",
          parse_mode: "HTML",
        }
      );
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(Server running on port ${PORT});
  console.log(Webhook: http://localhost:${PORT}/webhook);
});