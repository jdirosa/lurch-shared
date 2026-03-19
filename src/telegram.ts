import TelegramBot from "node-telegram-bot-api";
import { config } from "./config.js";
import { runAgent } from "./agent.js";

const bot = new TelegramBot(config.telegramBotToken, { polling: true });

bot.on("message", async (msg) => {
  if (!msg.text) return;

  try {
    const reply = await runAgent(msg.text);
    await bot.sendMessage(msg.chat.id, reply);
  } catch (err) {
    console.error("Agent error:", err);
    await bot.sendMessage(msg.chat.id, "Something went wrong. Try again.");
  }
});

console.log("Lurch is running.");
