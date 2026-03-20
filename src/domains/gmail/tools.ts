import type Anthropic from "@anthropic-ai/sdk";
import { getGmailClient } from "../google-client.js";
import type { UserContext } from "../../users.js";
import type { ToolHandler } from "../../agent.js";
import { loadUserStore, saveUserStore } from "../store.js";

// Strip CRLF to prevent MIME header injection
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

// Sanitize attachment filenames for safe MIME interpolation
function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"]/g, "_");
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

function logMimeStructure(payload: any, depth = 0): void {
  if (!payload) return;
  const indent = "  ".repeat(depth);
  const hasData = payload.body?.data ? `data=${payload.body.data.length}chars` : "no data";
  const attId = payload.body?.attachmentId ? ` attachmentId=${payload.body.attachmentId}` : "";
  console.log(`${indent}${payload.mimeType} (${hasData}${attId})`);
  if (payload.parts) {
    for (const part of payload.parts) {
      logMimeStructure(part, depth + 1);
    }
  }
}

function extractBody(payload: any): string {
  if (!payload) return "(no body)";

  // Check for text/plain first
  if (payload.mimeType === "text/plain" && payload.body?.data && payload.body.data.length > 0) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
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

  // Get the original message in raw format
  const original = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = original.data.payload?.headers ?? [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name === name)?.value ?? "";

  const origFrom = getHeader("From");
  const origDate = getHeader("Date");
  const origSubject = getHeader("Subject");
  const origTo = getHeader("To");

  // Build the forwarded subject
  const fwdSubject = sanitizeHeader(
    origSubject.startsWith("Fwd:") ? origSubject : `Fwd: ${origSubject}`
  );

  // Extract body and attachments from the original message
  console.log("[forward] MIME structure:");
  logMimeStructure(original.data.payload);
  const body = extractBody(original.data.payload);
  console.log(`[forward] extractBody result: "${body.substring(0, 200)}"`);
  const attachments = await extractAttachments(gmail, messageId, original.data.payload);

  // Build forwarded body
  const forwardHeader = [
    "---------- Forwarded message ---------",
    `From: ${origFrom}`,
    `Date: ${origDate}`,
    `Subject: ${origSubject}`,
    `To: ${origTo}`,
    "",
  ].join("\n");

  const fullBody = [
    note ? `${note}\n\n` : "",
    "👻 Forwarded by Lurch\n\n",
    forwardHeader,
    body,
  ].join("");

  // Build MIME message
  const boundary = `boundary_${Date.now()}`;

  if (attachments.length === 0) {
    // Simple message, no attachments
    const raw = [
      `To: ${to}`,
      `Subject: ${fwdSubject}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      fullBody,
    ].join("\r\n");

    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: Buffer.from(raw).toString("base64url") },
    });
  } else {
    // Multipart message with attachments
    const parts: string[] = [
      `To: ${to}`,
      `Subject: ${fwdSubject}`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      fullBody,
    ];

    for (const att of attachments) {
      parts.push(
        `--${boundary}`,
        `Content-Type: ${sanitizeHeader(att.mimeType)}; name="${sanitizeFilename(att.filename)}"`,
        `Content-Disposition: attachment; filename="${sanitizeFilename(att.filename)}"`,
        "Content-Transfer-Encoding: base64",
        "",
        att.data
      );
    }

    parts.push(`--${boundary}--`);

    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: Buffer.from(parts.join("\r\n")).toString("base64url") },
    });
  }

  return `Forwarded "${origSubject}" to ${to}${attachments.length > 0 ? ` with ${attachments.length} attachment(s)` : ""}.`;
}

interface Attachment {
  filename: string;
  mimeType: string;
  data: string; // base64
}

async function extractAttachments(
  gmail: ReturnType<typeof getGmailClient>,
  messageId: string,
  payload: any
): Promise<Attachment[]> {
  const attachments: Attachment[] = [];
  if (!payload) return attachments;

  async function walk(part: any) {
    if (part.filename && part.body?.attachmentId) {
      const att = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: part.body.attachmentId,
      });
      if (att.data.data) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType ?? "application/octet-stream",
          // Gmail API returns base64url, convert to standard base64 for MIME
          data: att.data.data.replace(/-/g, "+").replace(/_/g, "/"),
        });
      }
    }
    if (part.parts) {
      for (const child of part.parts) {
        await walk(child);
      }
    }
  }

  await walk(payload);
  return attachments;
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
