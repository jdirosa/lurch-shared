import Anthropic from "@anthropic-ai/sdk";
import cron from "node-cron";
import type TelegramBot from "node-telegram-bot-api";
import { config } from "../../config.js";
import { resolveContext } from "../../users.js";
import { log } from "../../log.js";
import { recordUsage } from "../../token-tracker.js";
import { markdownToTelegramHtml, splitMessage } from "../../format.js";
import { appendAssistantMessage } from "../../agent.js";
import { getGmailClient } from "../google-client.js";
import { loadAllStores } from "../store.js";
import type { EmailWatch } from "../store.js";
import { extractBody } from "./tools.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// Cache resolved label IDs per account to avoid a list call every tick.
const labelIdCache = new Map<string, string>();

// Per-chat mutex — don't stack ticks if a previous one is still running.
const inFlight = new Set<number>();

const MAX_CANDIDATES_PER_TICK = 25;
const MAX_BODY_CHARS = 3000;

interface EmailCandidate {
  id: string;
  from: string;
  subject: string;
  date: string;
  body: string;
}

interface Classification {
  actionable: Array<{ id: string; category: string; summary: string }>;
  ping: string | null;
}

async function ensureLabel(gmail: any, name: string, account: string): Promise<string> {
  const cached = labelIdCache.get(account);
  if (cached) return cached;

  const list = await gmail.users.labels.list({ userId: "me" });
  const existing = list.data.labels?.find((l: any) => l.name === name);
  if (existing?.id) {
    labelIdCache.set(account, existing.id);
    return existing.id;
  }

  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name,
      labelListVisibility: "labelHide",
      messageListVisibility: "show",
    },
  });
  const id = created.data.id!;
  labelIdCache.set(account, id);
  return id;
}

async function fetchCandidates(
  gmail: any,
  watch: EmailWatch
): Promise<EmailCandidate[]> {
  const afterSec = Math.floor(new Date(watch.since).getTime() / 1000);
  const query = `in:inbox -label:${watch.label} after:${afterSec}`;

  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: MAX_CANDIDATES_PER_TICK,
  });

  const ids = (listRes.data.messages ?? []).map((m: any) => m.id as string);
  if (ids.length === 0) return [];

  return Promise.all(
    ids.map(async (id: string) => {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "full",
      });
      const headers = detail.data.payload?.headers ?? [];
      const get = (n: string) =>
        headers.find((h: any) => h.name === n)?.value ?? "";
      const body = extractBody(detail.data.payload).slice(0, MAX_BODY_CHARS);
      return {
        id,
        from: get("From"),
        subject: get("Subject"),
        date: get("Date"),
        body,
      };
    })
  );
}

async function classifyEmails(
  emails: EmailCandidate[],
  chatId: number
): Promise<Classification> {
  const serialized = emails
    .map(
      (e) =>
        `---\nID: ${e.id}\nFrom: ${e.from}\nDate: ${e.date}\nSubject: ${e.subject}\n\n${e.body}`
    )
    .join("\n");

  const prompt = `You are triaging new inbox emails for the user.

For each email, decide if it is actionable — meaning it contains a reservation, booking, event, confirmation, travel update, appointment, delivery, invitation, bill due, or similar item that the user might want to add to their calendar, log to a trip, or act on. Ignore routine mail: newsletters, marketing, generic receipts with no action required, social notifications, and system emails.

Return ONLY a single JSON object in exactly this shape, with no prose, no markdown fences, no commentary:

{
  "actionable": [
    { "id": "<gmail message id>", "category": "reservation|event|confirmation|booking|travel|appointment|delivery|invitation|bill|other", "summary": "one-sentence summary with key details like date/time/place" }
  ],
  "ping": "<a friendly Telegram message to the user summarizing the actionable items and asking what to do — e.g. add to calendar, log to a trip, etc. Use markdown. Keep it under 10 lines. Refer to items so they can reply naturally.>"
}

If nothing is actionable, return {"actionable": [], "ping": null}.

Emails:
${serialized}`;

  const res = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });
  recordUsage(chatId, res.usage);

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    log(`[watcher] classifier returned no JSON: ${text.slice(0, 200)}`);
    return { actionable: [], ping: null };
  }
  try {
    const parsed = JSON.parse(match[0]);
    return {
      actionable: Array.isArray(parsed.actionable) ? parsed.actionable : [],
      ping: typeof parsed.ping === "string" && parsed.ping.trim() ? parsed.ping : null,
    };
  } catch (err) {
    log(`[watcher] classifier JSON parse failed: ${err}`);
    return { actionable: [], ping: null };
  }
}

async function runOne(
  bot: TelegramBot,
  chatId: number,
  watch: EmailWatch
): Promise<void> {
  if (inFlight.has(chatId)) {
    log(`[watcher] chat ${chatId} still in flight, skipping this tick`);
    return;
  }
  inFlight.add(chatId);
  try {
    const ctx = resolveContext(chatId, chatId);
    if (!ctx) {
      log(`[watcher] no context for chat ${chatId}, skipping`);
      return;
    }
    const account = ctx.resources.google_accounts[0];
    if (!account) {
      log(`[watcher] no google account for chat ${chatId}, skipping`);
      return;
    }

    const gmail = getGmailClient(account);

    // Diagnostic: verify we're actually authenticated as the expected account.
    // If expected != actual, that's the source of any inbox-crossing bugs.
    try {
      const profile = await gmail.users.getProfile({ userId: "me" });
      const actual = profile.data.emailAddress;
      if (actual && actual.toLowerCase() !== account.toLowerCase()) {
        log(`[watcher] MISMATCH chat ${chatId}: expected=${account} actual=${actual} — skipping tick`);
        return;
      }
      log(`[watcher] chat ${chatId}: authed as ${actual}`);
    } catch (err) {
      log(`[watcher] chat ${chatId}: getProfile failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const candidates = await fetchCandidates(gmail, watch);
    if (candidates.length === 0) return;

    log(`[watcher] chat ${chatId}: ${candidates.length} candidate(s)`);

    const classification = await classifyEmails(candidates, chatId);

    // Label all candidates first — even non-actionable ones — so they don't
    // get re-classified next tick. If label application fails, we want to
    // know before pinging (otherwise we'd ping again on the next run).
    const labelId = await ensureLabel(gmail, watch.label, account);
    await gmail.users.messages.batchModify({
      userId: "me",
      requestBody: {
        ids: candidates.map((c) => c.id),
        addLabelIds: [labelId],
      },
    });

    if (!classification.ping) {
      log(`[watcher] chat ${chatId}: nothing actionable, staying silent`);
      return;
    }

    const html = markdownToTelegramHtml(classification.ping);
    for (const chunk of splitMessage(html)) {
      await bot.sendMessage(chatId, chunk, { parse_mode: "HTML" });
    }
    // Seed chat history so follow-up replies have context.
    appendAssistantMessage(chatId, classification.ping);
    log(`[watcher] chat ${chatId}: pinged with ${classification.actionable.length} actionable item(s)`);
  } catch (err) {
    log(`[watcher] error for chat ${chatId}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    inFlight.delete(chatId);
  }
}

export function initEmailWatcher(bot: TelegramBot): void {
  cron.schedule("*/10 * * * *", async () => {
    const stores = loadAllStores();
    const targets: Array<{ chatId: number; watch: EmailWatch }> = [];
    for (const [chatIdStr, store] of Object.entries(stores)) {
      if (store.email_watch?.enabled) {
        targets.push({ chatId: Number(chatIdStr), watch: store.email_watch });
      }
    }
    if (targets.length === 0) return;
    log(`[watcher] tick — ${targets.length} chat(s) watching`);
    for (const { chatId, watch } of targets) {
      await runOne(bot, chatId, watch);
    }
  });
  log("[watcher] initialized — checking inboxes every 10 minutes");
}
