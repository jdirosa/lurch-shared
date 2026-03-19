import { google } from "googleapis";
import { config } from "../config.js";
import { getTokensForAccount, updateTokens } from "../users.js";
import type { GoogleTokens } from "../users.js";

export function getGoogleClient(accountEmail: string) {
  if (!accountEmail) {
    throw new Error("No Google account configured. Update users.json.");
  }

  const tokens = getTokensForAccount(accountEmail);
  if (!tokens) {
    throw new Error(
      `Google account ${accountEmail} not authorized. Run: npm run auth`
    );
  }

  if (!config.googleClientId || !config.googleClientSecret) {
    throw new Error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env");
  }

  const oauth2 = new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    "http://localhost:3000/callback"
  );

  oauth2.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  });

  // Auto-refresh and persist new tokens
  oauth2.on("tokens", (newTokens) => {
    const updated: GoogleTokens = {
      refresh_token: newTokens.refresh_token ?? tokens.refresh_token,
      access_token: newTokens.access_token ?? tokens.access_token,
      expiry: newTokens.expiry_date
        ? new Date(newTokens.expiry_date).toISOString()
        : tokens.expiry,
    };
    updateTokens(accountEmail, updated);
  });

  return oauth2;
}

export function getGmailClient(accountEmail: string) {
  const auth = getGoogleClient(accountEmail);
  return google.gmail({ version: "v1", auth });
}

export function getCalendarClient(accountEmail: string) {
  const auth = getGoogleClient(accountEmail);
  return google.calendar({ version: "v3", auth });
}
