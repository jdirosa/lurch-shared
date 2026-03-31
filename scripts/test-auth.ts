import "dotenv/config";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";

interface ChatEntry {
  name: string;
  google_account: string;
  google_tokens: { refresh_token: string; access_token: string; expiry: string };
}

interface Registry {
  chats: Record<string, ChatEntry>;
}

const usersPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../users.json"
);
const registry: Registry = JSON.parse(readFileSync(usersPath, "utf-8"));

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env");
  process.exit(1);
}

const accounts = Object.values(registry.chats).filter(
  (c) => c.google_account && c.google_tokens?.refresh_token
);

if (accounts.length === 0) {
  console.log("No configured Google accounts found in users.json");
  process.exit(0);
}

function makeAuth(tokens: ChatEntry["google_tokens"]) {
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, "http://localhost:3000/callback");
  oauth2.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  });
  return oauth2;
}

let passed = 0;

for (const chat of accounts) {
  console.log(`\nTesting auth for ${chat.name} (${chat.google_account})...`);

  const auth = makeAuth(chat.google_tokens);
  let gmailOk = false;
  let calendarOk = false;

  // Test Gmail
  try {
    const gmail = google.gmail({ version: "v1", auth });
    await gmail.users.messages.list({ userId: "me", maxResults: 1 });
    console.log("  Gmail:    ✓");
    gmailOk = true;
  } catch (err: any) {
    const status = err?.code || err?.response?.status || "?";
    const msg = err?.message || String(err);
    console.log(`  Gmail:    ✗ ${status} — ${msg}`);
  }

  // Test Calendar
  try {
    const calendar = google.calendar({ version: "v3", auth });
    await calendar.calendarList.list({ maxResults: 1 });
    console.log("  Calendar: ✓");
    calendarOk = true;
  } catch (err: any) {
    const status = err?.code || err?.response?.status || "?";
    const msg = err?.message || String(err);
    console.log(`  Calendar: ✗ ${status} — ${msg}`);
  }

  if (gmailOk && calendarOk) passed++;
}

console.log(`\nResults: ${passed}/${accounts.length} accounts fully working`);
