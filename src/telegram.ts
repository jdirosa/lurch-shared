import TelegramBot from "node-telegram-bot-api";
import { config } from "./config.js";
import { runAgent } from "./agent.js";
import { resolveContext } from "./users.js";

const bot = new TelegramBot(config.telegramBotToken, { polling: true });

bot.on("message", async (msg) => {
  if (!msg.text || !msg.from) return;

  const ctx = resolveContext(msg.from.id, msg.chat.id, msg.from.first_name);
  if (!ctx) return;

  // Show typing indicator (repeats every 4s since it expires after 5s)
  await bot.sendChatAction(msg.chat.id, "typing");
  const typingInterval = setInterval(() => {
    bot.sendChatAction(msg.chat.id, "typing").catch(() => {});
  }, 4000);

  try {
    const reply = await runAgent(msg.text, ctx);
    clearInterval(typingInterval);
    await bot.sendMessage(msg.chat.id, reply);
  } catch (err) {
    clearInterval(typingInterval);
    console.error("Agent error:", err);
    await bot.sendMessage(msg.chat.id, "Something went wrong. Try again.");
  }
});

console.log("Lurch is running.");
