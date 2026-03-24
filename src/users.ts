import { readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Types ---

export interface GoogleTokens {
  refresh_token: string;
  access_token: string;
  expiry: string;
}

interface ChatEntry {
  name: string;
  google_account: string;
  google_tokens: GoogleTokens;
  calendar_id: string;
  dropbox_root: string;
  timezone: string;
}

interface ChatRegistry {
  chats: Record<string, ChatEntry>;
}

export interface UserContext {
  chatName: string;
  chatId: number;
  senderId: number;
  senderName: string;
  timezone: string;
  resources: {
    google_accounts: string[];
    calendar_ids: string[];
    dropbox_roots: string[];
  };
}

// --- Load and validate ---

function loadRegistry(): ChatRegistry {
  const registryPath = resolve(__dirname, "../users.json");
  let raw: string;
  try {
    raw = readFileSync(registryPath, "utf-8");
  } catch {
    throw new Error("Missing users.json — copy users.example.json and fill in your values");
  }

  const registry = JSON.parse(raw) as ChatRegistry;

  if (!registry.chats || typeof registry.chats !== "object") {
    throw new Error("users.json: missing or invalid 'chats' object");
  }

  for (const [id, entry] of Object.entries(registry.chats)) {
    if (typeof entry.name !== "string" || !entry.name) {
      throw new Error(`users.json: chat ${id} missing or invalid 'name'`);
    }
  }

  return registry;
}

const registry = loadRegistry();

// Log loaded chats at startup
for (const [id, entry] of Object.entries(registry.chats)) {
  console.log(`[config] chat ${id} → ${entry.name} (${entry.google_account || "no email"})`);
}

// --- Token lookup and update ---

export function getTokensForAccount(email: string): GoogleTokens | null {
  if (!email) return null;

  for (const entry of Object.values(registry.chats)) {
    if (entry.google_account === email) {
      if (!entry.google_tokens.refresh_token) return null;
      return entry.google_tokens;
    }
  }

  return null;
}

export function updateTokens(email: string, tokens: GoogleTokens): void {
  for (const entry of Object.values(registry.chats)) {
    if (entry.google_account === email) {
      entry.google_tokens = tokens;
      writeRegistry();
      return;
    }
  }

  throw new Error(`No account found for ${email}`);
}

function writeRegistry(): void {
  const registryPath = resolve(__dirname, "../users.json");
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
}

export function getRegistryChats(): Array<{ chatId: string; name: string; email: string }> {
  return Object.entries(registry.chats).map(([id, entry]) => ({
    chatId: id,
    name: entry.name,
    email: entry.google_account,
  }));
}

export function updateTokensByChatId(chatId: string, tokens: GoogleTokens): void {
  const entry = registry.chats[chatId];
  if (!entry) throw new Error(`No chat found with ID ${chatId}`);
  entry.google_tokens = tokens;
  writeRegistry();
}

// --- Context resolution ---

export function resolveContext(
  fromId: number,
  chatId: number,
  fromName?: string
): UserContext | null {
  const chat = registry.chats[String(chatId)];
  if (!chat) return null;

  const account = chat.google_account;
  return {
    chatName: chat.name,
    chatId,
    senderId: fromId,
    senderName: fromName ?? "Unknown",
    timezone: chat.timezone || "America/Toronto",
    resources: {
      google_accounts: [account].filter(Boolean),
      calendar_ids: [chat.calendar_id].filter(Boolean),
      dropbox_roots: [chat.dropbox_root].filter(Boolean),
    },
  };
}
