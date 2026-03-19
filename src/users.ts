import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Types ---

export interface ResourceBindings {
  google_accounts: string[];
  calendar_ids: string[];
  dropbox_roots: string[];
}

interface PrivateContext {
  type: "private";
  userName: string;
  userId: number;
  chatId: number;
  resources: ResourceBindings;
}

interface SharedContext {
  type: "shared";
  userName: string;
  userId: number;
  chatId: number;
  resources: ResourceBindings;
}

export type UserContext = PrivateContext | SharedContext;

// --- Registry shape (matches users.json) ---

interface GoogleTokens {
  refresh_token: string;
  access_token: string;
  expiry: string;
}

interface UserEntry {
  name: string;
  google_account: string;
  google_tokens: GoogleTokens;
  calendar_id: string;
  dropbox_root: string;
}

interface SharedEntry {
  google_account: string;
  google_tokens: GoogleTokens;
  calendar_id: string;
  dropbox_root: string;
}

interface UserRegistry {
  users: Record<string, UserEntry>;
  shared: SharedEntry;
  group_chat_id: number;
}

// --- Load and validate ---

function loadRegistry(): UserRegistry {
  const registryPath = resolve(__dirname, "../users.json");
  let raw: string;
  try {
    raw = readFileSync(registryPath, "utf-8");
  } catch {
    throw new Error("Missing users.json — copy users.example.json and fill in your values");
  }

  const registry = JSON.parse(raw) as UserRegistry;

  if (!registry.users || typeof registry.users !== "object") {
    throw new Error("users.json: missing or invalid 'users' object");
  }
  if (!registry.shared || typeof registry.shared !== "object") {
    throw new Error("users.json: missing or invalid 'shared' object");
  }
  if (typeof registry.group_chat_id !== "number") {
    throw new Error("users.json: missing or invalid 'group_chat_id'");
  }

  for (const [id, entry] of Object.entries(registry.users)) {
    if (typeof entry.name !== "string" || !entry.name) {
      throw new Error(`users.json: user ${id} missing or invalid 'name'`);
    }
    if (typeof entry.google_account !== "string") {
      throw new Error(`users.json: user ${id} missing or invalid 'google_account'`);
    }
  }

  return registry;
}

const registry = loadRegistry();

// --- Context resolution ---

export function resolveContext(
  fromId: number,
  chatId: number,
  fromName?: string
): UserContext | null {
  const sharedResources: ResourceBindings = {
    google_accounts: [registry.shared.google_account],
    calendar_ids: [registry.shared.calendar_id],
    dropbox_roots: [registry.shared.dropbox_root],
  };

  // Group chat → shared context
  if (chatId === registry.group_chat_id) {
    const user = registry.users[String(fromId)];
    return {
      type: "shared",
      userName: user?.name ?? fromName ?? "Unknown",
      userId: fromId,
      chatId,
      resources: sharedResources,
    };
  }

  // DM → check if known user
  const user = registry.users[String(fromId)];
  if (!user) return null;

  return {
    type: "private",
    userName: user.name,
    userId: fromId,
    chatId,
    resources: {
      google_accounts: [user.google_account, registry.shared.google_account],
      calendar_ids: [user.calendar_id, registry.shared.calendar_id],
      dropbox_roots: [user.dropbox_root, registry.shared.dropbox_root],
    },
  };
}
