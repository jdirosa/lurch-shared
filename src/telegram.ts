import TelegramBot from "node-telegram-bot-api";
import { config } from "./config.js";
import { runAgent, clearHistory } from "./agent.js";
import { resolveContext } from "./users.js";
import { markdownToTelegramHtml } from "./format.js";

const bot = new TelegramBot(config.telegramBotToken, { polling: true });
const botMention = `@${config.telegramBotUsername}`;

let botId: number | undefined;
bot.getMe().then((me) => { botId = me.id; });

bot.on("message", async (msg) => {
  if (!msg.text || !msg.from) return;
  if (msg.message_id === 0) {
    console.log(`[msg] skipped — message_id is 0, chatId=${msg.chat.id}`);
    return;
  }

  console.log(`[msg] chatId=${msg.chat.id} userId=${msg.from.id} (${msg.from.first_name})`);

  const ctx = resolveContext(msg.from.id, msg.chat.id, msg.from.first_name);
  if (!ctx) {
    console.log(`[msg] ignored — unrecognized chatId=${msg.chat.id} userId=${msg.from.id} (${msg.from.first_name})`);
    return;
  }

  // Slash commands
  if (msg.text === "/clear") {
    clearHistory(msg.chat.id);
    await bot.sendMessage(msg.chat.id, "Chat history cleared.");
    return;
  }

  let text = msg.text;

  // In group chats, only respond when @mentioned or replied to
  const isGroup = msg.chat.id < 0;
  if (isGroup) {
    const isMentioned = text.toLowerCase().includes(botMention.toLowerCase());
    const isReply = msg.reply_to_message?.from?.id === botId;

    if (!isMentioned && !isReply) return;

    // Strip the @mention from the text
    text = text.replace(new RegExp(botMention, "gi"), "").trim();
    if (!text) return;
  }

  // Show typing indicator (repeats every 4s since it expires after 5s)
  await bot.sendChatAction(msg.chat.id, "typing");
  const typingInterval = setInterval(() => {
    bot.sendChatAction(msg.chat.id, "typing").catch(() => {});
  }, 4000);

  try {
    const reply = await runAgent(text, ctx);
    clearInterval(typingInterval);
    await bot.sendMessage(msg.chat.id, markdownToTelegramHtml(reply), { parse_mode: "HTML" });
  } catch (err) {
    clearInterval(typingInterval);
    console.error("Agent error:", err);
    await bot.sendMessage(msg.chat.id, "Something went wrong. Try again.");
  }
});

console.log("Lurch is running.");
