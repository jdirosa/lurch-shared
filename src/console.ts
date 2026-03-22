import { createInterface } from "readline";
import { runAgent, clearHistory } from "./agent.js";
import { getRegistryChats, resolveContext } from "./users.js";
import type { UserContext } from "./users.js";

const rl = createInterface({ input: process.stdin, output: process.stdout });

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function selectUser(): Promise<UserContext> {
  const chats = getRegistryChats();

  if (chats.length === 0) {
    console.error("No chats configured in users.json.");
    process.exit(1);
  }

  console.log("\nWho are you?\n");
  chats.forEach((chat, i) => {
    console.log(`  ${i + 1}. ${chat.name} (${chat.email || "no email"}) — chat ${chat.chatId}`);
  });

  const choice = await prompt("\nSelect a number: ");
  const index = parseInt(choice, 10) - 1;

  if (index < 0 || index >= chats.length) {
    console.error("Invalid selection.");
    process.exit(1);
  }

  const selected = chats[index];
  const chatId = Number(selected.chatId);
  const ctx = resolveContext(chatId, chatId, selected.name);

  if (!ctx) {
    console.error("Failed to resolve context for this chat.");
    process.exit(1);
  }

  return ctx;
}

async function main() {
  const ctx = await selectUser();
  console.log(`\nChatting as ${ctx.chatName}. Type /clear to reset history, /quit to exit.\n`);

  while (true) {
    const input = await prompt("You: ");
    const text = input.trim();

    if (!text) continue;

    if (text === "/quit" || text === "/exit") {
      console.log("Bye!");
      break;
    }

    if (text === "/clear") {
      clearHistory(ctx.chatId);
      console.log("History cleared.\n");
      continue;
    }

    try {
      const reply = await runAgent(text, ctx);
      console.log(`\nLurch: ${reply}\n`);
    } catch (err) {
      console.error("Agent error:", err instanceof Error ? err.message : err);
    }
  }

  rl.close();
}

main();
