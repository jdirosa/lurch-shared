import type Anthropic from "@anthropic-ai/sdk";
import { getCalendarClient } from "../google-client.js";
import type { UserContext } from "../../users.js";

type ToolHandler = (input: Record<string, unknown>, ctx: UserContext) => Promise<string>;

export const calendarTools: Anthropic.Tool[] = [
  {
    name: "calendar_search",
    description:
      "Search calendar events by date range and/or text query. " +
      "Returns a list of matching events with id, title, start time, end time, and location. " +
      "Provide time_min and/or time_max as ISO 8601 strings (e.g., '2026-03-19T00:00:00Z'). " +
      "Optionally provide a text query to filter by event title or description. " +
      "Searches across all calendars available to the user.",
    input_schema: {
      type: "object" as const,
      properties: {
        time_min: {
          type: "string",
          description: "Start of time range (ISO 8601). Defaults to now.",
        },
        time_max: {
          type: "string",
          description: "End of time range (ISO 8601). Defaults to 7 days from now.",
        },
        query: {
          type: "string",
          description: "Text to search for in event title and description",
        },
      },
      required: [],
    },
  },
  {
    name: "calendar_read",
    description:
      "Get full details of a specific calendar event by its ID. " +
      "Returns title, start, end, location, description, and attendees. " +
      "Use calendar_search first to find the event ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        event_id: {
          type: "string",
          description: "The calendar event ID (from calendar_search results)",
        },
        calendar_id: {
          type: "string",
          description: "The calendar ID the event belongs to (from calendar_search results)",
        },
      },
      required: ["event_id", "calendar_id"],
    },
  },
  {
    name: "calendar_create",
    description:
      "Create a new calendar event. " +
      "Provide title, start time, and end time at minimum. " +
      "Optionally include location and description.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Event title" },
        start: {
          type: "string",
          description: "Start time as ISO 8601 (e.g., '2026-03-20T10:00:00-04:00')",
        },
        end: {
          type: "string",
          description: "End time as ISO 8601 (e.g., '2026-03-20T11:00:00-04:00')",
        },
        location: { type: "string", description: "Event location (optional)" },
        description: { type: "string", description: "Event description (optional)" },
      },
      required: ["title", "start", "end"],
    },
  },
];

// --- Handlers ---

async function handleCalendarSearch(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const calendarIds = ctx.resources.calendar_ids.filter((id) => id);
  if (calendarIds.length === 0) return "No calendars configured for this user.";

  const account = ctx.resources.google_accounts[0];
  if (!account) return "No Google account configured for this user.";

  const calendar = getCalendarClient(account);
  const now = new Date().toISOString();
  const weekFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const timeMin = input.time_min ? String(input.time_min) : now;
  const timeMax = input.time_max ? String(input.time_max) : weekFromNow;
  const query = input.query ? String(input.query) : undefined;

  const allResults: string[] = [];

  for (const calId of calendarIds) {
    try {
      const res = await calendar.events.list({
        calendarId: calId,
        timeMin,
        timeMax,
        q: query,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 20,
      });

      const events = res.data.items ?? [];
      for (const event of events) {
        const start = event.start?.dateTime ?? event.start?.date ?? "";
        const end = event.end?.dateTime ?? event.end?.date ?? "";
        allResults.push(
          [
            `ID: ${event.id}`,
            `Calendar: ${calId}`,
            `Title: ${event.summary ?? "(no title)"}`,
            `Start: ${start}`,
            `End: ${end}`,
            `Location: ${event.location ?? ""}`,
          ].join("\n")
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      allResults.push(`[Error reading calendar ${calId}: ${msg}]`);
    }
  }

  if (allResults.length === 0) {
    return `No events found between ${timeMin} and ${timeMax}${query ? ` matching "${query}"` : ""}`;
  }

  return allResults.join("\n---\n");
}

async function handleCalendarRead(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const account = ctx.resources.google_accounts[0];
  if (!account) return "No Google account configured for this user.";

  const calendar = getCalendarClient(account);

  const res = await calendar.events.get({
    calendarId: String(input.calendar_id),
    eventId: String(input.event_id),
  });

  const event = res.data;
  const start = event.start?.dateTime ?? event.start?.date ?? "";
  const end = event.end?.dateTime ?? event.end?.date ?? "";
  const attendees = (event.attendees ?? [])
    .map((a) => `${a.displayName ?? a.email} (${a.responseStatus})`)
    .join(", ");

  return [
    `Title: ${event.summary ?? "(no title)"}`,
    `Start: ${start}`,
    `End: ${end}`,
    `Location: ${event.location ?? ""}`,
    `Description: ${event.description ?? ""}`,
    `Attendees: ${attendees || "none"}`,
  ].join("\n");
}

async function handleCalendarCreate(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const calendarIds = ctx.resources.calendar_ids.filter((id) => id);
  if (calendarIds.length === 0) return "No calendars configured for this user.";

  const account = ctx.resources.google_accounts[0];
  if (!account) return "No Google account configured for this user.";

  const calendar = getCalendarClient(account);
  const primaryCalendar = calendarIds[0];

  const description = input.description
    ? `${String(input.description)}\n\n👻 Ghostwritten by Lurch`
    : "👻 Ghostwritten by Lurch";

  const res = await calendar.events.insert({
    calendarId: primaryCalendar,
    requestBody: {
      summary: String(input.title),
      start: { dateTime: String(input.start) },
      end: { dateTime: String(input.end) },
      location: input.location ? String(input.location) : undefined,
      description,
    },
  });

  return `Event created: "${res.data.summary}" on ${res.data.start?.dateTime ?? res.data.start?.date}`;
}

export const calendarHandlers = new Map<string, ToolHandler>([
  ["calendar_search", handleCalendarSearch],
  ["calendar_read", handleCalendarRead],
  ["calendar_create", handleCalendarCreate],
]);
