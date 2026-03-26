import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const USAGE_PATH = join(__dirname, "..", "token-usage.json");

// Anthropic pricing per million tokens (Sonnet 4)
const PRICE = {
  input: 3.0,
  output: 15.0,
  cache_create: 3.75,
  cache_read: 0.30,
};

interface UsageRecord {
  ts: string; // ISO 8601
  chatId: number;
  input: number;
  output: number;
  cache_create: number;
  cache_read: number;
}

function loadRecords(): UsageRecord[] {
  if (!existsSync(USAGE_PATH)) return [];
  try {
    return JSON.parse(readFileSync(USAGE_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function saveRecords(records: UsageRecord[]): void {
  writeFileSync(USAGE_PATH, JSON.stringify(records));
}

export function recordUsage(
  chatId: number,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  },
): void {
  const records = loadRecords();
  records.push({
    ts: new Date().toISOString(),
    chatId,
    input: usage.input_tokens,
    output: usage.output_tokens,
    cache_create: usage.cache_creation_input_tokens ?? 0,
    cache_read: usage.cache_read_input_tokens ?? 0,
  });
  saveRecords(records);
}

function costForTokens(input: number, output: number, cacheCreate: number, cacheRead: number): number {
  return (
    (input * PRICE.input +
      output * PRICE.output +
      cacheCreate * PRICE.cache_create +
      cacheRead * PRICE.cache_read) /
    1_000_000
  );
}

export function queryUsage(period: string, chatId?: number): string {
  const now = new Date();
  let since: Date;

  switch (period) {
    case "today":
      since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case "yesterday": {
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      const endOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return summarize(loadRecords().filter((r) => {
        const t = new Date(r.ts);
        return t >= yesterday && t < endOfYesterday && (!chatId || r.chatId === chatId);
      }), "yesterday");
    }
    case "week":
      since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case "month":
      since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case "all":
      since = new Date(0);
      break;
    default:
      since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
  }

  const filtered = loadRecords().filter((r) => {
    return new Date(r.ts) >= since && (!chatId || r.chatId === chatId);
  });

  return summarize(filtered, period);
}

function summarize(records: UsageRecord[], label: string): string {
  if (records.length === 0) return `No usage data for ${label}.`;

  const totals = records.reduce(
    (acc, r) => ({
      input: acc.input + r.input,
      output: acc.output + r.output,
      cache_create: acc.cache_create + r.cache_create,
      cache_read: acc.cache_read + r.cache_read,
      calls: acc.calls + 1,
    }),
    { input: 0, output: 0, cache_create: 0, cache_read: 0, calls: 0 },
  );

  const cost = costForTokens(totals.input, totals.output, totals.cache_create, totals.cache_read);

  return [
    `Period: ${label}`,
    `API calls: ${totals.calls}`,
    `Input tokens: ${totals.input.toLocaleString()}`,
    `Output tokens: ${totals.output.toLocaleString()}`,
    `Cache create tokens: ${totals.cache_create.toLocaleString()}`,
    `Cache read tokens: ${totals.cache_read.toLocaleString()}`,
    `Estimated cost: $${cost.toFixed(4)}`,
  ].join("\n");
}
