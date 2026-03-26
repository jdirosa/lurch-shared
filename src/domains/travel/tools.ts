import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "../../agent.js";
import type { UserContext } from "../../users.js";
import { loadUserStore, saveUserStore } from "../store.js";
import type { EventEntry } from "../store.js";

// --- Helpers ---

function findEvent(events: Record<string, EventEntry>, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(events).find((k) => k.toLowerCase() === lower);
}

function formatEvent(name: string, event: EventEntry): string {
  const lines = [name];
  lines.push(`Destination: ${event.destination}`);
  if (event.start_date) lines.push(`Dates: ${event.start_date}${event.end_date ? ` → ${event.end_date}` : ""}`);
  if (event.notes) lines.push(`Notes: ${event.notes}`);

  if (event.guests && event.guests.length > 0) {
    lines.push("Guests:");
    event.guests.forEach((guest, i) => lines.push(`  ${i + 1}. ${guest}`));
  }

  if (event.ideas.length > 0) {
    lines.push("Ideas:");
    event.ideas.forEach((idea, i) => lines.push(`  ${i + 1}. ${idea}`));
  }

  if (event.itinerary.length > 0) {
    lines.push("Itinerary:");
    for (const day of event.itinerary) {
      lines.push(`  ${day.day}:`);
      day.items.forEach((item) => lines.push(`    - ${item}`));
    }
  }

  if (event.bookings.length > 0) {
    lines.push("Bookings:");
    event.bookings.forEach((b) => lines.push(`  [${b.category}] ${b.details}`));
  }

  return lines.join("\n");
}

// --- Tool definitions ---

export const eventTools: Anthropic.Tool[] = [
  {
    name: "event_view",
    description:
      "View all events or a specific event's full details (dates, ideas, itinerary, bookings, guests).",
    input_schema: {
      type: "object" as const,
      properties: {
        event: {
          type: "string",
          description: "Name of the event to view. Omit to see all events.",
        },
      },
      required: [],
    },
  },
  {
    name: "event_create",
    description: "Create a new event with a name and destination.",
    input_schema: {
      type: "object" as const,
      properties: {
        event: {
          type: "string",
          description: "Name for the event (e.g., 'Japan 2026', 'Christmas at Mom's')",
        },
        destination: {
          type: "string",
          description: "Destination (city, country, or description)",
        },
        start_date: {
          type: "string",
          description: "Start date (e.g., '2026-07-01', 'July 1')",
        },
        end_date: {
          type: "string",
          description: "End date (e.g., '2026-07-14', 'July 14')",
        },
      },
      required: ["event", "destination"],
    },
  },
  {
    name: "event_update",
    description:
      "Update an event's details — destination, dates, or notes. " +
      "Only provided fields are updated.",
    input_schema: {
      type: "object" as const,
      properties: {
        event: { type: "string", description: "Name of the event" },
        destination: { type: "string", description: "New destination" },
        start_date: { type: "string", description: "New start date" },
        end_date: { type: "string", description: "New end date" },
        notes: { type: "string", description: "Free-text notes (replaces existing)" },
      },
      required: ["event"],
    },
  },
  {
    name: "event_add_ideas",
    description:
      "Add ideas to an event — things to do, restaurants, sights, activities.",
    input_schema: {
      type: "object" as const,
      properties: {
        event: { type: "string", description: "Name of the event" },
        ideas: {
          type: "array",
          items: { type: "string" },
          description: "Ideas to add",
        },
      },
      required: ["event", "ideas"],
    },
  },
  {
    name: "event_remove_ideas",
    description:
      "Remove ideas from an event by matching text (case-insensitive, partial match).",
    input_schema: {
      type: "object" as const,
      properties: {
        event: { type: "string", description: "Name of the event" },
        ideas: {
          type: "array",
          items: { type: "string" },
          description: "Ideas to remove (partial match)",
        },
      },
      required: ["event", "ideas"],
    },
  },
  {
    name: "event_set_itinerary",
    description:
      "Set the planned activities for a specific day of an event. " +
      "Replaces any existing items for that day.",
    input_schema: {
      type: "object" as const,
      properties: {
        event: { type: "string", description: "Name of the event" },
        day: {
          type: "string",
          description: "Day label (e.g., 'Day 1', 'July 2', 'Monday')",
        },
        items: {
          type: "array",
          items: { type: "string" },
          description: "Planned activities for that day",
        },
      },
      required: ["event", "day", "items"],
    },
  },
  {
    name: "event_add_booking",
    description:
      "Add a booking or reservation to an event (flight, hotel, car rental, activity, etc.).",
    input_schema: {
      type: "object" as const,
      properties: {
        event: { type: "string", description: "Name of the event" },
        category: {
          type: "string",
          description: "Booking category (e.g., 'flight', 'hotel', 'car', 'restaurant', 'activity')",
        },
        details: {
          type: "string",
          description: "Booking details (airline, confirmation #, hotel name, dates, etc.)",
        },
      },
      required: ["event", "category", "details"],
    },
  },
  {
    name: "event_remove_booking",
    description:
      "Remove a booking from an event by matching text in the details (case-insensitive, partial match).",
    input_schema: {
      type: "object" as const,
      properties: {
        event: { type: "string", description: "Name of the event" },
        match: {
          type: "string",
          description: "Text to match against booking details (partial, case-insensitive)",
        },
      },
      required: ["event", "match"],
    },
  },
  {
    name: "event_add_guests",
    description:
      "Add guests to an event.",
    input_schema: {
      type: "object" as const,
      properties: {
        event: { type: "string", description: "Name of the event" },
        guests: {
          type: "array",
          items: { type: "string" },
          description: "Guest names to add",
        },
      },
      required: ["event", "guests"],
    },
  },
  {
    name: "event_remove_guests",
    description:
      "Remove guests from an event by matching name (case-insensitive, partial match).",
    input_schema: {
      type: "object" as const,
      properties: {
        event: { type: "string", description: "Name of the event" },
        guests: {
          type: "array",
          items: { type: "string" },
          description: "Guest names to remove (partial match)",
        },
      },
      required: ["event", "guests"],
    },
  },
  {
    name: "event_delete",
    description: "Delete an event entirely.",
    input_schema: {
      type: "object" as const,
      properties: {
        event: { type: "string", description: "Name of the event to delete" },
      },
      required: ["event"],
    },
  },
];

// --- Handlers ---

async function handleEventView(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const eventInput = input.event ? String(input.event) : undefined;

  if (!eventInput) {
    const entries = Object.entries(store.events);
    if (entries.length === 0) return "No events planned yet.";
    return entries
      .map(([name, event]) => {
        const dates = event.start_date
          ? ` (${event.start_date}${event.end_date ? ` → ${event.end_date}` : ""})`
          : "";
        return `${name} — ${event.destination}${dates}`;
      })
      .join("\n");
  }

  const key = findEvent(store.events, eventInput);
  if (!key) return `No event named "${eventInput}".`;
  return formatEvent(key, store.events[key]);
}

async function handleEventCreate(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const name = String(input.event);
  const destination = String(input.destination);

  if (findEvent(store.events, name)) return `Event "${name}" already exists.`;

  const event: EventEntry = {
    destination,
    start_date: input.start_date ? String(input.start_date) : undefined,
    end_date: input.end_date ? String(input.end_date) : undefined,
    ideas: [],
    itinerary: [],
    bookings: [],
  };

  store.events[name] = event;
  saveUserStore(ctx, store);

  return `Created event "${name}" to ${destination}.`;
}

async function handleEventUpdate(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const key = findEvent(store.events, String(input.event));
  if (!key) return `No event named "${input.event}".`;

  const event = store.events[key];
  const updated: string[] = [];

  if (input.destination) { event.destination = String(input.destination); updated.push("destination"); }
  if (input.start_date) { event.start_date = String(input.start_date); updated.push("start date"); }
  if (input.end_date) { event.end_date = String(input.end_date); updated.push("end date"); }
  if (input.notes !== undefined) { event.notes = String(input.notes); updated.push("notes"); }

  saveUserStore(ctx, store);
  return `Updated ${key}: ${updated.join(", ")}.`;
}

async function handleEventAddIdeas(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const key = findEvent(store.events, String(input.event));
  if (!key) return `No event named "${input.event}".`;

  const ideas = input.ideas as string[];
  store.events[key].ideas.push(...ideas);
  saveUserStore(ctx, store);

  return `Added ${ideas.length} idea${ideas.length === 1 ? "" : "s"} to "${key}" (${store.events[key].ideas.length} total).`;
}

async function handleEventRemoveIdeas(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const key = findEvent(store.events, String(input.event));
  if (!key) return `No event named "${input.event}".`;

  const patterns = (input.ideas as string[]).map((s) => s.toLowerCase());
  const before = store.events[key].ideas.length;
  store.events[key].ideas = store.events[key].ideas.filter(
    (idea) => !patterns.some((p) => idea.toLowerCase().includes(p))
  );
  const removed = before - store.events[key].ideas.length;
  saveUserStore(ctx, store);

  return `Removed ${removed} idea${removed === 1 ? "" : "s"} from "${key}".`;
}

async function handleEventSetItinerary(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const key = findEvent(store.events, String(input.event));
  if (!key) return `No event named "${input.event}".`;

  const day = String(input.day);
  const items = input.items as string[];

  const existing = store.events[key].itinerary.find((d) => d.day.toLowerCase() === day.toLowerCase());
  if (existing) {
    existing.day = day;
    existing.items = items;
  } else {
    store.events[key].itinerary.push({ day, items });
  }

  saveUserStore(ctx, store);
  return `Set itinerary for ${day} on "${key}" (${items.length} activities).`;
}

async function handleEventAddBooking(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const key = findEvent(store.events, String(input.event));
  if (!key) return `No event named "${input.event}".`;

  const booking = {
    category: String(input.category),
    details: String(input.details),
  };
  store.events[key].bookings.push(booking);
  saveUserStore(ctx, store);

  return `Added ${booking.category} booking to "${key}".`;
}

async function handleEventRemoveBooking(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const key = findEvent(store.events, String(input.event));
  if (!key) return `No event named "${input.event}".`;

  const match = String(input.match).toLowerCase();
  const before = store.events[key].bookings.length;
  store.events[key].bookings = store.events[key].bookings.filter(
    (b) => !b.details.toLowerCase().includes(match) && !b.category.toLowerCase().includes(match)
  );
  const removed = before - store.events[key].bookings.length;
  saveUserStore(ctx, store);

  return `Removed ${removed} booking${removed === 1 ? "" : "s"} from "${key}".`;
}

async function handleEventAddGuests(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const key = findEvent(store.events, String(input.event));
  if (!key) return `No event named "${input.event}".`;

  const guests = input.guests as string[];
  if (!store.events[key].guests) store.events[key].guests = [];
  store.events[key].guests!.push(...guests);
  saveUserStore(ctx, store);

  return `Added ${guests.length} guest${guests.length === 1 ? "" : "s"} to "${key}" (${store.events[key].guests!.length} total).`;
}

async function handleEventRemoveGuests(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const key = findEvent(store.events, String(input.event));
  if (!key) return `No event named "${input.event}".`;

  if (!store.events[key].guests) store.events[key].guests = [];
  const patterns = (input.guests as string[]).map((s) => s.toLowerCase());
  const before = store.events[key].guests!.length;
  store.events[key].guests = store.events[key].guests!.filter(
    (guest) => !patterns.some((p) => guest.toLowerCase().includes(p))
  );
  const removed = before - store.events[key].guests!.length;
  saveUserStore(ctx, store);

  return `Removed ${removed} guest${removed === 1 ? "" : "s"} from "${key}".`;
}

async function handleEventDelete(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const key = findEvent(store.events, String(input.event));
  if (!key) return `No event named "${input.event}".`;

  delete store.events[key];
  saveUserStore(ctx, store);

  return `Deleted event "${key}".`;
}

export const eventHandlers = new Map<string, ToolHandler>([
  ["event_view", handleEventView],
  ["event_create", handleEventCreate],
  ["event_update", handleEventUpdate],
  ["event_add_ideas", handleEventAddIdeas],
  ["event_remove_ideas", handleEventRemoveIdeas],
  ["event_set_itinerary", handleEventSetItinerary],
  ["event_add_booking", handleEventAddBooking],
  ["event_remove_booking", handleEventRemoveBooking],
  ["event_add_guests", handleEventAddGuests],
  ["event_remove_guests", handleEventRemoveGuests],
  ["event_delete", handleEventDelete],
]);
