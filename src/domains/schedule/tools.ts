import type Anthropic from "@anthropic-ai/sdk";
import type { UserContext } from "../../users.js";
import type { ToolHandler } from "../../agent.js";
import { loadUserStore, saveUserStore } from "../store.js";
import { addSchedule, removeSchedule } from "../../scheduler.js";

export const scheduleTools: Anthropic.Tool[] = [
  {
    name: "schedule_set",
    description:
      "Create or update a scheduled notification. Lurch will run the given prompt on the cron schedule and send the result to the user. " +
      "Use this for daily briefings, reminders, periodic check-ins, etc. Set once=true for one-time reminders. " +
      "The prompt should be a natural language instruction for what Lurch should do when the schedule fires — " +
      'e.g., "Give me a morning briefing: check my calendar for today, any important unread emails, and upcoming trip countdowns." ' +
      "If a schedule with the same id already exists, it will be replaced. " +
      "Cron format: minute hour day-of-month month day-of-week (e.g., '30 7 * * 1-5' = 7:30 AM weekdays).",
    input_schema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description:
            "Unique identifier for this schedule (e.g., 'morning-briefing', 'weekly-review'). Use lowercase with hyphens.",
        },
        label: {
          type: "string",
          description:
            "Human-readable name shown when listing schedules (e.g., 'Morning Briefing', 'Weekly Review')",
        },
        cron: {
          type: "string",
          description:
            "Cron expression: minute hour day-of-month month day-of-week. Examples: '30 7 * * *' (daily 7:30 AM), '0 9 * * 1' (Mondays 9 AM), '0 18 * * 5' (Fridays 6 PM)",
        },
        prompt: {
          type: "string",
          description:
            "The instruction Lurch will execute when this schedule fires. Be specific about what to check/summarize.",
        },
        timezone: {
          type: "string",
          description:
            "IANA timezone (default: America/Toronto). Examples: America/New_York, Europe/London, Asia/Tokyo",
        },
        once: {
          type: "boolean",
          description:
            "If true, this schedule fires once and is automatically deleted. Use for one-time reminders.",
        },
      },
      required: ["id", "label", "cron", "prompt"],
    },
  },
  {
    name: "schedule_list",
    description: "List all active scheduled notifications for this user.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "schedule_delete",
    description: "Delete a scheduled notification by its id.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The schedule id to delete",
        },
      },
      required: ["id"],
    },
  },
];

async function handleScheduleSet(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const id = String(input.id);
  const label = String(input.label);
  const cronExpr = String(input.cron);
  const prompt = String(input.prompt);
  const timezone = input.timezone ? String(input.timezone) : ctx.timezone;
  const once = input.once === true;

  const schedule = { id, label, cron: cronExpr, prompt, timezone, once: once || undefined };

  // Register the cron job (validates the expression)
  const result = addSchedule(ctx.chatId, schedule);
  if (result.startsWith("Invalid")) return result;

  // Persist to store
  const store = loadUserStore(ctx);
  const idx = store.schedules.findIndex((s) => s.id === id);
  if (idx >= 0) {
    store.schedules[idx] = schedule;
  } else {
    store.schedules.push(schedule);
  }
  saveUserStore(ctx, store);

  return result;
}

async function handleScheduleList(
  _input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  if (store.schedules.length === 0) {
    return "No scheduled notifications. Use schedule_set to create one.";
  }

  return store.schedules
    .map((s) => {
      const tz = s.timezone || "America/Toronto";
      return `- **${s.label}** (id: ${s.id})\n  Schedule: ${s.cron} (${tz})\n  Prompt: "${s.prompt}"`;
    })
    .join("\n\n");
}

async function handleScheduleDelete(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const id = String(input.id);

  const store = loadUserStore(ctx);
  const idx = store.schedules.findIndex((s) => s.id === id);
  if (idx < 0) return `No schedule found with id "${id}".`;

  const label = store.schedules[idx].label;
  store.schedules.splice(idx, 1);
  saveUserStore(ctx, store);

  removeSchedule(ctx.chatId, id);

  return `Deleted schedule "${label}" (${id}).`;
}

export const scheduleHandlers = new Map<string, ToolHandler>([
  ["schedule_set", handleScheduleSet],
  ["schedule_list", handleScheduleList],
  ["schedule_delete", handleScheduleDelete],
]);
