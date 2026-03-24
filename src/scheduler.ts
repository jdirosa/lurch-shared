import cron, { type ScheduledTask } from "node-cron";
import type TelegramBot from "node-telegram-bot-api";
import { markdownToTelegramHtml } from "./format.js";
import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { log } from "./log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(__dirname, "..", "lists.json");

export interface Schedule {
  id: string;
  label: string;
  cron: string;
  prompt: string;
  timezone?: string;
  once?: boolean;
}

// Active cron tasks keyed by `${chatId}:${scheduleId}`
const activeTasks = new Map<string, ScheduledTask>();

let botInstance: TelegramBot;
let onRemoveCallback: ((chatId: number, scheduleId: string) => void) | undefined;

function taskKey(chatId: number, scheduleId: string): string {
  return `${chatId}:${scheduleId}`;
}

function registerJob(chatId: number, schedule: Schedule): void {
  const key = taskKey(chatId, schedule.id);

  // Stop existing job if re-registering
  activeTasks.get(key)?.stop();

  const task = cron.schedule(schedule.cron, async () => {
    log(`[scheduler] firing "${schedule.label}" for chat ${chatId}`);
    try {
      if (schedule.once) {
        // One-time reminders: send the prompt directly as a message
        await botInstance.sendMessage(chatId, markdownToTelegramHtml(schedule.prompt), { parse_mode: "HTML" });
      } else {
        // Recurring schedules: run through the agent (e.g. daily briefings that query APIs)
        const { resolveContext } = await import("./users.js");
        const { runAgent } = await import("./agent.js");
        const ctx = resolveContext(chatId, chatId);
        if (!ctx) {
          log(`[scheduler] no context for chat ${chatId}, skipping`);
          return;
        }
        const reply = await runAgent(schedule.prompt, ctx);
        await botInstance.sendMessage(chatId, markdownToTelegramHtml(reply), { parse_mode: "HTML" });
      }
    } catch (err) {
      log(`[scheduler] error for "${schedule.label}" chat ${chatId}: ${err}`);
    }

    if (schedule.once) {
      log(`[scheduler] one-time schedule "${schedule.label}" fired, removing`);
      unregisterJob(chatId, schedule.id);
      onRemoveCallback?.(chatId, schedule.id);
    }
  }, {
    timezone: schedule.timezone ?? "America/Toronto",
  });

  activeTasks.set(key, task);
  log(`[scheduler] registered "${schedule.label}" (${schedule.cron}) for chat ${chatId}`);
}

function unregisterJob(chatId: number, scheduleId: string): void {
  const key = taskKey(chatId, scheduleId);
  const task = activeTasks.get(key);
  if (task) {
    task.stop();
    activeTasks.delete(key);
  }
}

function loadSchedulesFromStore(): Array<{ chatId: number; schedules: Schedule[] }> {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const all = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
    const results: Array<{ chatId: number; schedules: Schedule[] }> = [];
    for (const [chatId, store] of Object.entries(all)) {
      const schedules = (store as any).schedules;
      if (Array.isArray(schedules) && schedules.length > 0) {
        results.push({ chatId: Number(chatId), schedules });
      }
    }
    return results;
  } catch {
    return [];
  }
}

export function initScheduler(
  bot: TelegramBot,
  onRemove?: (chatId: number, scheduleId: string) => void,
): void {
  botInstance = bot;
  onRemoveCallback = onRemove;

  // Re-register all persisted schedules
  const allSchedules = loadSchedulesFromStore();
  let count = 0;
  for (const { chatId, schedules } of allSchedules) {
    for (const schedule of schedules) {
      if (cron.validate(schedule.cron)) {
        registerJob(chatId, schedule);
        count++;
      } else {
        log(`[scheduler] invalid cron "${schedule.cron}" for "${schedule.label}", skipping`);
      }
    }
  }
  log(`[scheduler] initialized — ${count} job(s) restored`);
}

export function addSchedule(chatId: number, schedule: Schedule): string {
  if (!cron.validate(schedule.cron)) {
    return `Invalid cron expression: "${schedule.cron}"`;
  }
  registerJob(chatId, schedule);
  return `Scheduled "${schedule.label}" (${schedule.cron})`;
}

export function removeSchedule(chatId: number, scheduleId: string): void {
  unregisterJob(chatId, scheduleId);
}

export function getActiveCount(): number {
  return activeTasks.size;
}
