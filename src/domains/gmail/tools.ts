import type Anthropic from "@anthropic-ai/sdk";
import { PDFParse } from "pdf-parse";
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
    name: "gmail_get_attachment",
    description:
      "Download and read an email attachment. " +
      "Supports text files (.txt, .csv, .json, .html, .xml, .md, .log) and PDFs. " +
      "Use gmail_read first to see the list of attachments with their IDs. " +
      "Returns the extracted text content of the attachment.",
    input_schema: {
      type: "object" as const,
      properties: {
        message_id: {
          type: "string",
          description: "The Gmail message ID that contains the attachment",
        },
        attachment_id: {
          type: "string",
          description: "The attachment ID (from gmail_read output)",
        },
        filename: {
          type: "string",
          description: "The attachment filename (for determining how to parse it)",
        },
      },
      required: ["message_id", "attachment_id", "filename"],
    },
  },
  {
    name: "email_watch_enable",
    description:
      "Start the inbox watcher. Every 10 minutes, Lurch will scan the user's inbox for new emails and ping them about reservations, bookings, confirmations, travel updates, and other actionable items. Routine mail (newsletters, receipts, notifications) is silently archived from the scan. " +
      "Only call this tool when the user explicitly asks Lurch to start watching their email. " +
      "Confirm to the user afterwards with a short sentence.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "email_watch_disable",
    description:
      "Stop the inbox watcher. Only call when the user explicitly asks to stop watching their email.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "email_watch_status",
    description:
      "Report whether the inbox watcher is currently enabled, and since when.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
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
  const attachments = extractAttachments(res.data.payload, String(input.message_id));

  const lines = [
    `From: ${get("From")}`,
    `To: ${get("To")}`,
    `Subject: ${get("Subject")}`,
    `Date: ${get("Date")}`,
    "",
    body,
  ];

  if (attachments.length > 0) {
    lines.push("", "--- Attachments ---");
    for (const att of attachments) {
      const sizeKB = Math.round(att.size / 1024);
      lines.push(`- ${att.filename} (${att.mimeType}, ${sizeKB} KB) [attachmentId: ${att.attachmentId}]`);
    }
    lines.push("", "Use gmail_get_attachment with the message_id and attachment_id to read an attachment.");
  }

  return lines.join("\n");
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

interface AttachmentInfo {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
  messageId: string;
}

function extractAttachments(payload: any, messageId: string): AttachmentInfo[] {
  const attachments: AttachmentInfo[] = [];

  function walk(part: any) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body.size ?? 0,
        attachmentId: part.body.attachmentId,
        messageId,
      });
    }
    if (part.parts) {
      for (const child of part.parts) walk(child);
    }
  }

  walk(payload);
  return attachments;
}

export function extractBody(payload: any): string {
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

  // Get the original raw RFC 2822 message
  const original = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "raw",
  });

  const rawBase64 = original.data.raw;
  if (!rawBase64) return "Error: Could not retrieve the original email.";

  // Decode the raw message
  const rawMessage = Buffer.from(rawBase64, "base64url").toString("utf-8");

  // Split into headers and body at the first blank line
  const headerBodySplit = rawMessage.indexOf("\r\n\r\n");
  const originalHeaders = rawMessage.substring(0, headerBodySplit);
  const originalBody = rawMessage.substring(headerBodySplit); // includes the \r\n\r\n

  // Extract headers we need from the original
  const headerLines = originalHeaders.split(/\r\n(?!\s)/); // handle folded headers
  const getOrigHeader = (name: string): string => {
    const line = headerLines.find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ":"));
    return line ? line.substring(name.length + 1).trim() : "";
  };

  const origSubject = getOrigHeader("Subject");
  const origFrom = getOrigHeader("From");
  const origDate = getOrigHeader("Date");
  const origTo = getOrigHeader("To");
  const origContentType = getOrigHeader("Content-Type");

  const fwdSubject = sanitizeHeader(
    origSubject.startsWith("Fwd:") ? origSubject : `Fwd: ${origSubject}`
  );

  // Keep only the Content-Type and Content-Transfer-Encoding from original headers
  // (these describe the body format), replace everything else with new headers
  const preservedHeaders: string[] = [];
  for (const line of headerLines) {
    const lower = line.toLowerCase();
    if (lower.startsWith("content-type:") || lower.startsWith("content-transfer-encoding:") || lower.startsWith("mime-version:")) {
      preservedHeaders.push(line);
    }
  }

  // If the original is not multipart, we can just add a note as a prefix.
  // If it IS multipart, we need to wrap it.
  const isMultipart = origContentType.toLowerCase().includes("multipart");

  let forwardedMessage: string;

  if (isMultipart) {
    // For multipart emails, wrap in a new multipart/mixed with the note + original
    const boundary = `fwd_${Date.now()}`;
    const noteSection = note ? `${note}\n\n` : "";
    const fwdHeader = [
      noteSection + "---------- Forwarded message ---------",
      `From: ${origFrom}`,
      `Date: ${origDate}`,
      `Subject: ${origSubject}`,
      `To: ${origTo}`,
    ].join("\n");

    forwardedMessage = [
      `To: ${to}`,
      `Subject: ${fwdSubject}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      fwdHeader,
      "",
      `--${boundary}`,
      // Re-attach original Content-Type so the body is interpreted correctly
      ...preservedHeaders.filter((h) => !h.toLowerCase().startsWith("mime-version:")),
      originalBody.trimStart(),
      `--${boundary}--`,
    ].join("\r\n");
  } else {
    // Simple (non-multipart) email — just swap headers, keep body as-is
    const newHeaders = [
      `To: ${to}`,
      `Subject: ${fwdSubject}`,
      "MIME-Version: 1.0",
      ...preservedHeaders.filter((h) => !h.toLowerCase().startsWith("mime-version:")),
    ].join("\r\n");

    forwardedMessage = newHeaders + originalBody;
  }

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: Buffer.from(forwardedMessage).toString("base64url") },
  });

  return `Forwarded "${origSubject}" to ${to}.`;
}


const TEXT_EXTENSIONS = new Set([
  ".txt", ".csv", ".json", ".html", ".htm", ".xml", ".md",
  ".log", ".yaml", ".yml", ".tsv", ".ini", ".cfg", ".conf",
  ".js", ".ts", ".py", ".rb", ".sh", ".sql", ".css",
]);

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_TEXT_CHARS = 50_000; // ~12k tokens

async function handleGetAttachment(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const account = ctx.resources.google_accounts[0];
  if (!account) return "No Google account configured for this user.";

  const gmail = getGmailClient(account);
  const messageId = String(input.message_id);
  const attachmentId = String(input.attachment_id);
  const filename = String(input.filename);
  const ext = filename.includes(".") ? "." + filename.split(".").pop()!.toLowerCase() : "";

  const res = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });

  const base64Data = res.data.data;
  if (!base64Data) return "Error: Could not retrieve attachment data.";

  const buffer = Buffer.from(base64Data, "base64url");

  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    return `Attachment "${filename}" is too large (${Math.round(buffer.length / 1024 / 1024)} MB). Max supported size is 10 MB.`;
  }

  // PDF
  if (ext === ".pdf") {
    try {
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const result = await parser.getText();
        const text = result.text.trim();
        if (!text) return `PDF "${filename}" contains no extractable text (may be scanned/image-based).`;
        if (text.length > MAX_TEXT_CHARS) {
          return `Content of "${filename}" (truncated to ${MAX_TEXT_CHARS} chars):\n\n${text.slice(0, MAX_TEXT_CHARS)}\n\n[... truncated, full document is ${text.length} chars]`;
        }
        return `Content of "${filename}":\n\n${text}`;
      } finally {
        await parser.destroy();
      }
    } catch (err) {
      return `Error reading PDF "${filename}": ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Text files
  if (TEXT_EXTENSIONS.has(ext)) {
    const text = buffer.toString("utf-8");
    if (text.length > MAX_TEXT_CHARS) {
      return `Content of "${filename}" (truncated to ${MAX_TEXT_CHARS} chars):\n\n${text.slice(0, MAX_TEXT_CHARS)}\n\n[... truncated, full file is ${text.length} chars]`;
    }
    return `Content of "${filename}":\n\n${text}`;
  }

  return `Cannot read "${filename}" (${ext || "unknown"} format). Supported formats: text files (${[...TEXT_EXTENSIONS].join(", ")}) and PDFs.`;
}

const DEFAULT_WATCH_LABEL = "lurch/ingested";

async function handleEmailWatchEnable(
  _input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const account = ctx.resources.google_accounts[0];
  if (!account) return "No Google account configured for this chat — can't start the watcher.";

  const store = loadUserStore(ctx);
  if (store.email_watch?.enabled) {
    return `Inbox watcher is already running (since ${store.email_watch.since}).`;
  }

  store.email_watch = {
    enabled: true,
    since: new Date().toISOString(),
    label: store.email_watch?.label ?? DEFAULT_WATCH_LABEL,
  };
  saveUserStore(ctx, store);
  return `Inbox watcher enabled. I'll check every 10 minutes and ping you about reservations, bookings, confirmations, and other actionable emails.`;
}

async function handleEmailWatchDisable(
  _input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  if (!store.email_watch?.enabled) {
    return "Inbox watcher is already off.";
  }
  store.email_watch.enabled = false;
  saveUserStore(ctx, store);
  return "Inbox watcher disabled.";
}

async function handleEmailWatchStatus(
  _input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const w = store.email_watch;
  if (!w?.enabled) return "Inbox watcher: OFF.";
  return `Inbox watcher: ON (watching since ${w.since}, label "${w.label}").`;
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
  ["gmail_get_attachment", handleGetAttachment],
  ["gmail_check_recipient", handleCheckRecipient],
  ["gmail_approve_recipient", handleApproveRecipient],
  ["email_watch_enable", handleEmailWatchEnable],
  ["email_watch_disable", handleEmailWatchDisable],
  ["email_watch_status", handleEmailWatchStatus],
]);
