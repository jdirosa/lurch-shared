import TelegramBot from "node-telegram-bot-api";
import { config } from "./config.js";
import { runAgent } from "./agent.js";
import { resolveContext } from "./users.js";

const bot = new TelegramBot(config.telegramBotToken, { polling: true });

bot.on("message", async (msg) => {
  if (!msg.text || !msg.from) return;

  const ctx = resolveContext(msg.from.id, msg.chat.id, msg.from.first_name);
  if (!ctx) return;

  try {
    const reply = await runAgent(msg.text, ctx);
    await bot.sendMessage(msg.chat.id, reply);
  } catch (err) {
    console.error("Agent error:", err);
    await bot.sendMessage(msg.chat.id, "Something went wrong. Try again.");
  }
});

console.log("Lurch is running.");
