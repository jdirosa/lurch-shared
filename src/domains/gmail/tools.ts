import type Anthropic from "@anthropic-ai/sdk";
import { getGmailClient } from "../google-client.js";
import type { UserContext } from "../../users.js";
import type { ToolHandler } from "../../agent.js";
import { loadUserStore, saveUserStore } from "../store.js";

// Strip CRLF to prevent MIME header injection
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

export const gmailTools: Anthropic.Tool[] = [
  {
    name: "gmail_search",
    description:
      "Search the user's Gmail for emails matching a query. " +
      "Uses Gmail search syntax: 'from:jane', 'subject:deploy', 'after:2024/01/01', 'is:unread'. " +
      "Combine terms: 'from:jane subject:deploy'. " +
      "Set scope to 'all' to search everywhere including archived mail (default), or " +
      "'inbox' only when the user asks about new or unread messages. " +
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
        scope: {
          type: "string",
          enum: ["inbox", "all"],
          description:
            "Where to search: 'all' searches everywhere including archived mail (default), 'inbox' only for new/unread messages",
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
      "CRITICAL: You MUST NOT call this tool until the user has explicitly approved. " +
      "First, present the complete draft to the user in this format:\n" +
      "To: [recipient]\nSubject: [subject]\nBody: [body]\n" +
      "Then ask: 'Should I send this?' — only call this tool after the user says yes.",
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
  {
    name: "gmail_forward",
    description:
      "Forward an existing email to a recipient, preserving attachments. " +
      "CRITICAL: You MUST NOT call this tool until the user has explicitly approved. " +
      "First, tell the user which email you're about to forward and to whom. " +
      "Then ask: 'Should I forward this?' — only call this tool after the user says yes.",
    input_schema: {
      type: "object" as const,
      properties: {
        message_id: {
          type: "string",
          description: "The Gmail message ID to forward (from gmail_search results)",
        },
        to: {
          type: "string",
          description: "Recipient email address",
        },
        note: {
          type: "string",
          description: "Optional note to add above the forwarded message",
        },
      },
      required: ["message_id", "to"],
    },
  },
  {
    name: "gmail_check_recipient",
    description:
      "Check if an email address is on the user's approved recipients list. " +
      "Call this once per recipient when composing an email — do NOT re-check after the user has already confirmed in this conversation. " +
      "If the address is not approved, ask the user to confirm the address before proceeding. " +
      "Once confirmed, call gmail_approve_recipient to add it, then continue to send without checking again.",
    input_schema: {
      type: "object" as const,
      properties: {
        email: {
          type: "string",
          description: "The email address to check",
        },
      },
      required: ["email"],
    },
  },
  {
    name: "gmail_approve_recipient",
    description:
      "Add an email address to the user's approved recipients list. " +
      "Only call this AFTER the user has explicitly confirmed the address is correct.",
    input_schema: {
      type: "object" as const,
      properties: {
        email: {
          type: "string",
          description: "The email address to approve",
        },
      },
      required: ["email"],
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
    q: input.scope === "inbox" ? `in:inbox ${String(input.query)}` : String(input.query),
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

function htmlToText(html: string): string {
  return html
    // Remove style/script blocks entirely
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    // Line breaks for block elements
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Strip remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode common HTML entities
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // Collapse runs of whitespace on the same line (preserve newlines)
    .replace(/[^\S\n]+/g, " ")
    // Collapse 3+ newlines into 2
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractBody(payload: any): string {
  if (!payload) return "(no body)";

  // Check for text/plain first
  if (payload.mimeType === "text/plain" && payload.body?.data && payload.body.data.length > 0) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  // Check for top-level text/html (common in forwarded/marketing emails)
  if (payload.mimeType === "text/html" && payload.body?.data && payload.body.data.length > 0) {
    const html = Buffer.from(payload.body.data, "base64url").toString("utf-8");
    const text = html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (text) return text;
  }

  // Check parts — collect candidates, preferring text/plain over text/html
  if (payload.parts) {
    const textParts: any[] = [];
    const htmlParts: any[] = [];

    for (const part of payload.parts) {
      if (part.mimeType === "text/plain") textParts.push(part);
      else if (part.mimeType === "text/html") htmlParts.push(part);
    }

    // Try text/plain
    for (const part of textParts) {
      if (part.body?.data && part.body.data.length > 0) {
        return Buffer.from(part.body.data, "base64url").toString("utf-8");
      }
    }

    // Try text/html
    for (const part of htmlParts) {
      if (part.body?.data && part.body.data.length > 0) {
        const html = Buffer.from(part.body.data, "base64url").toString("utf-8");
        const text = html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        if (text) return text;
      }
    }

    // Recurse into nested multipart (including message/rfc822 forwarded messages)
    for (const part of payload.parts) {
      if (part.parts) {
        const result = extractBody(part);
        if (result !== "(no body)") return result;
      }
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
  const to = sanitizeHeader(String(input.to));
  const subject = sanitizeHeader(String(input.subject));
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

async function handleGmailForward(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const account = ctx.resources.google_accounts[0];
  if (!account) return "No Google account configured for this user.";

  const gmail = getGmailClient(account);
  const messageId = String(input.message_id);
  const to = sanitizeHeader(String(input.to));
  const note = input.note ? String(input.note) : undefined;

  // Get the original message in raw RFC 2822 format — preserves HTML, attachments, everything
  const original = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "raw",
  });

  const rawBase64 = original.data.raw;
  if (!rawBase64) return "Error: Could not retrieve the original email.";

  // Also get headers for subject/metadata (raw format doesn't parse them)
  const metadata = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "metadata",
    metadataHeaders: ["Subject", "From", "Date", "To"],
  });

  const headers = metadata.data.payload?.headers ?? [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name === name)?.value ?? "";

  const origSubject = getHeader("Subject");
  const origFrom = getHeader("From");
  const origDate = getHeader("Date");
  const origTo = getHeader("To");

  const fwdSubject = sanitizeHeader(
    origSubject.startsWith("Fwd:") ? origSubject : `Fwd: ${origSubject}`
  );

  // Wrap the original raw message as a message/rfc822 attachment
  const boundary = `boundary_${Date.now()}`;
  const noteText = note ? `${note}\n\n` : "";
  const preamble = [
    noteText,
    "---------- Forwarded message ---------",
    `From: ${origFrom}`,
    `Date: ${origDate}`,
    `Subject: ${origSubject}`,
    `To: ${origTo}`,
  ].join("\n");

  // Convert raw from base64url to standard base64
  const rawStdBase64 = rawBase64.replace(/-/g, "+").replace(/_/g, "/");

  const mime = [
    `To: ${to}`,
    `Subject: ${fwdSubject}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    preamble,
    "",
    `--${boundary}`,
    "Content-Type: message/rfc822",
    "Content-Disposition: attachment",
    "Content-Transfer-Encoding: base64",
    "",
    rawStdBase64,
    `--${boundary}--`,
  ].join("\r\n");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: Buffer.from(mime).toString("base64url") },
  });

  return `Forwarded "${origSubject}" to ${to}.`;
}


async function handleCheckRecipient(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const email = String(input.email).toLowerCase();
  const approved = store.approved_emails.some((e) => e.toLowerCase() === email);
  return approved
    ? `"${email}" is an approved recipient.`
    : `"${email}" is NOT on the approved recipients list. Ask the user to confirm this address before sending.`;
}

async function handleApproveRecipient(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const email = String(input.email).toLowerCase();
  if (!store.approved_emails.some((e) => e.toLowerCase() === email)) {
    store.approved_emails.push(email);
    saveUserStore(ctx, store);
  }
  return `"${email}" added to approved recipients.`;
}

export const gmailHandlers = new Map<string, ToolHandler>([
  ["gmail_search", handleGmailSearch],
  ["gmail_read", handleGmailRead],
  ["gmail_send", handleGmailSend],
  ["gmail_forward", handleGmailForward],
  ["gmail_check_recipient", handleCheckRecipient],
  ["gmail_approve_recipient", handleApproveRecipient],
]);
