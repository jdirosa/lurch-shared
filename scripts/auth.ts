import "dotenv/config";
import { createServer } from "http";
import { createInterface } from "readline";
import { google } from "googleapis";
import open from "open";
import {
  getRegistryChats,
  updateTokensByChatId,
} from "../src/users.js";
import type { GoogleTokens } from "../src/users.js";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env");
  process.exit(1);
}

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
];

const REDIRECT_URI = "http://localhost:3000/callback";

const rl = createInterface({ input: process.stdin, output: process.stdout });
function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function main() {
  const chats = getRegistryChats();

  console.log("\nAvailable chats:");
  chats.forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.name} (chatId: ${c.chatId}, email: ${c.email || "not set"})`);
  });

  const choice = await ask("\nWhich chat to authorize? (number): ");
  const index = parseInt(choice.trim(), 10) - 1;
  const chat = chats[index];

  if (!chat) {
    console.error("Invalid selection.");
    process.exit(1);
  }

  const confirm = await ask(`Authorize ${chat.name}? (y/n): `);
  if (confirm.toLowerCase() !== "y") {
    console.log("Cancelled.");
    process.exit(0);
  }

  rl.close();

  const label = `${chat.name} (${chat.email || "no email set"})`;

  // OAuth flow
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  console.log(`\nAuthorizing ${label}...`);
  console.log("Opening browser for Google sign-in...\n");

  // Start temp server to catch the callback
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "", `http://localhost:3000`);
      const authCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Authorization failed</h1><p>You can close this tab.</p>");
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (authCode) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Authorization successful!</h1><p>You can close this tab.</p>");
        server.close();
        resolve(authCode);
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(3000, () => {
      open(authUrl);
    });
  });

  // Exchange code for tokens
  const { tokens } = await oauth2.getToken(code);

  const googleTokens: GoogleTokens = {
    refresh_token: tokens.refresh_token ?? "",
    access_token: tokens.access_token ?? "",
    expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : "",
  };

  updateTokensByChatId(chat.chatId, googleTokens);
  console.log(`\nTokens saved for ${label}.`);
}

main().catch((err) => {
  console.error("Auth failed:", err.message);
  process.exit(1);
});
