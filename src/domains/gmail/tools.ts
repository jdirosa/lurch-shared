import type Anthropic from "@anthropic-ai/sdk";
import { getGmailClient } from "../google-client.js";
import type { UserContext } from "../../users.js";
import type { ToolHandler } from "../../agent.js";

export const gmailTools: Anthropic.Tool[] = [
  {
    name: "gmail_search",
    description:
      "Search the user's Gmail for emails matching a query. " +
      "Uses Gmail search syntax: 'from:sarah', 'subject:deploy', 'after:2024/01/01', 'is:unread'. " +
      "Combine terms: 'from:sarah subject:deploy'. " +
      "Returns a list of matching emails with id, subject, sender, date, and snippet (max 10). " +
      "Use gmail_read with a specific email id to get the full body.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Gmail search query using Gmail operators (from:, subject:, after:, before:, is:unread, etc.)",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (1-10, default 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "gmail_read",
    description:
      "Read a specific email by its message ID. " +
      "Returns the full email including sender, recipients, subject, date, and body text. " +
      "Use gmail_search first to find the message ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        message_id: {
          type: "string",
          description: "The Gmail message ID (from gmail_search results)",
        },
      },
      required: ["message_id"],
    },
  },
  {
    name: "gmail_send",
    description:
      "Send an email on behalf of the user. " +
      "IMPORTANT: Before calling this tool, ALWAYS present the full draft (to, subject, body) " +
      "to the user and ask for explicit confirmation. Only call this tool after the user approves.",
    input_schema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body text" },
      },
      required: ["to", "subject", "body"],
    },
  },
];

// --- Handlers ---

async function handleGmailSearch(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const account = ctx.resources.google_accounts[0];
  if (!account) return "No Google account configured for this user.";

  const gmail = getGmailClient(account);
  const maxResults = Math.min(Number(input.max_results) || 10, 10);

  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: `in:inbox ${String(input.query)}`,
    maxResults,
  });

  const messages = listRes.data.messages;
  if (!messages || messages.length === 0) {
    return `No emails found matching: ${input.query}`;
  }

  const results = await Promise.all(
    messages.map(async (msg) => {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "Date"],
      });

      const headers = detail.data.payload?.headers ?? [];
      const get = (name: string) =>
        headers.find((h) => h.name === name)?.value ?? "";

      return [
        `ID: ${msg.id}`,
        `From: ${get("From")}`,
        `Subject: ${get("Subject")}`,
        `Date: ${get("Date")}`,
        `Snippet: ${detail.data.snippet ?? ""}`,
      ].join("\n");
    })
  );

  return results.join("\n---\n");
}

async function handleGmailRead(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const account = ctx.resources.google_accounts[0];
  if (!account) return "No Google account configured for this user.";

  const gmail = getGmailClient(account);

  const res = await gmail.users.messages.get({
    userId: "me",
    id: String(input.message_id),
    format: "full",
  });

  const headers = res.data.payload?.headers ?? [];
  const get = (name: string) =>
    headers.find((h) => h.name === name)?.value ?? "";

  const body = extractBody(res.data.payload);

  return [
    `From: ${get("From")}`,
    `To: ${get("To")}`,
    `Subject: ${get("Subject")}`,
    `Date: ${get("Date")}`,
    "",
    body,
  ].join("\n");
}

function extractBody(payload: any): string {
  if (!payload) return "(no body)";

  // Check for text/plain first
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  // Check parts
  if (payload.parts) {
    // Prefer text/plain
    const textPart = payload.parts.find(
      (p: any) => p.mimeType === "text/plain"
    );
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, "base64url").toString("utf-8");
    }

    // Fall back to text/html with tags stripped
    const htmlPart = payload.parts.find(
      (p: any) => p.mimeType === "text/html"
    );
    if (htmlPart?.body?.data) {
      const html = Buffer.from(htmlPart.body.data, "base64url").toString(
        "utf-8"
      );
      return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    }

    // Recurse into nested multipart
    for (const part of payload.parts) {
      const result = extractBody(part);
      if (result !== "(no body)") return result;
    }
  }

  return "(no body)";
}

async function handleGmailSend(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const account = ctx.resources.google_accounts[0];
  if (!account) return "No Google account configured for this user.";

  const gmail = getGmailClient(account);
  const to = String(input.to);
  const subject = String(input.subject);
  const body = String(input.body) + "\n\n👻 Ghostwritten by Lurch";

  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");

  const encoded = Buffer.from(raw).toString("base64url");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded },
  });

  return `Email sent to ${to} with subject "${subject}"`;
}

export const gmailHandlers = new Map<string, ToolHandler>([
  ["gmail_search", handleGmailSearch],
  ["gmail_read", handleGmailRead],
  ["gmail_send", handleGmailSend],
]);
