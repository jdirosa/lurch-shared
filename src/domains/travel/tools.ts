import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "../../agent.js";
import type { UserContext } from "../../users.js";
import { loadUserStore, saveUserStore } from "../store.js";
import type { TripEntry } from "../store.js";

// --- Helpers ---

function findTrip(trips: Record<string, TripEntry>, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(trips).find((k) => k.toLowerCase() === lower);
}

function formatTrip(name: string, trip: TripEntry): string {
  const lines = [name];
  lines.push(`Destination: ${trip.destination}`);
  if (trip.start_date) lines.push(`Dates: ${trip.start_date}${trip.end_date ? ` → ${trip.end_date}` : ""}`);
  if (trip.notes) lines.push(`Notes: ${trip.notes}`);

  if (trip.ideas.length > 0) {
    lines.push("Ideas:");
    trip.ideas.forEach((idea, i) => lines.push(`  ${i + 1}. ${idea}`));
  }

  if (trip.itinerary.length > 0) {
    lines.push("Itinerary:");
    for (const day of trip.itinerary) {
      lines.push(`  ${day.day}:`);
      day.items.forEach((item) => lines.push(`    - ${item}`));
    }
  }

  if (trip.bookings.length > 0) {
    lines.push("Bookings:");
    trip.bookings.forEach((b) => lines.push(`  [${b.category}] ${b.details}`));
  }

  return lines.join("\n");
}

// --- Tool definitions ---

export const travelTools: Anthropic.Tool[] = [
  {
    name: "travel_view",
    description:
      "View all trips or a specific trip's full details (dates, ideas, itinerary, bookings).",
    input_schema: {
      type: "object" as const,
      properties: {
        trip: {
          type: "string",
          description: "Name of the trip to view. Omit to see all trips.",
        },
      },
      required: [],
    },
  },
  {
    name: "travel_create",
    description: "Create a new trip with a name and destination.",
    input_schema: {
      type: "object" as const,
      properties: {
        trip: {
          type: "string",
          description: "Name for the trip (e.g., 'Japan 2026', 'Christmas at Mom's')",
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
      required: ["trip", "destination"],
    },
  },
  {
    name: "travel_update",
    description:
      "Update a trip's details — destination, dates, or notes. " +
      "Only provided fields are updated.",
    input_schema: {
      type: "object" as const,
      properties: {
        trip: { type: "string", description: "Name of the trip" },
        destination: { type: "string", description: "New destination" },
        start_date: { type: "string", description: "New start date" },
        end_date: { type: "string", description: "New end date" },
        notes: { type: "string", description: "Free-text notes (replaces existing)" },
      },
      required: ["trip"],
    },
  },
  {
    name: "travel_add_ideas",
    description:
      "Add ideas to a trip — things to do, restaurants, sights, activities.",
    input_schema: {
      type: "object" as const,
      properties: {
        trip: { type: "string", description: "Name of the trip" },
        ideas: {
          type: "array",
          items: { type: "string" },
          description: "Ideas to add",
        },
      },
      required: ["trip", "ideas"],
    },
  },
  {
    name: "travel_remove_ideas",
    description:
      "Remove ideas from a trip by matching text (case-insensitive, partial match).",
    input_schema: {
      type: "object" as const,
      properties: {
        trip: { type: "string", description: "Name of the trip" },
        ideas: {
          type: "array",
          items: { type: "string" },
          description: "Ideas to remove (partial match)",
        },
      },
      required: ["trip", "ideas"],
    },
  },
  {
    name: "travel_set_itinerary",
    description:
      "Set the planned activities for a specific day of a trip. " +
      "Replaces any existing items for that day.",
    input_schema: {
      type: "object" as const,
      properties: {
        trip: { type: "string", description: "Name of the trip" },
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
      required: ["trip", "day", "items"],
    },
  },
  {
    name: "travel_add_booking",
    description:
      "Add a booking or reservation to a trip (flight, hotel, car rental, activity, etc.).",
    input_schema: {
      type: "object" as const,
      properties: {
        trip: { type: "string", description: "Name of the trip" },
        category: {
          type: "string",
          description: "Booking category (e.g., 'flight', 'hotel', 'car', 'restaurant', 'activity')",
        },
        details: {
          type: "string",
          description: "Booking details (airline, confirmation #, hotel name, dates, etc.)",
        },
      },
      required: ["trip", "category", "details"],
    },
  },
  {
    name: "travel_remove_booking",
    description:
      "Remove a booking from a trip by matching text in the details (case-insensitive, partial match).",
    input_schema: {
      type: "object" as const,
      properties: {
        trip: { type: "string", description: "Name of the trip" },
        match: {
          type: "string",
          description: "Text to match against booking details (partial, case-insensitive)",
        },
      },
      required: ["trip", "match"],
    },
  },
  {
    name: "travel_delete",
    description: "Delete a trip entirely.",
    input_schema: {
      type: "object" as const,
      properties: {
        trip: { type: "string", description: "Name of the trip to delete" },
      },
      required: ["trip"],
    },
  },
];

// --- Handlers ---

async function handleTravelView(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const tripInput = input.trip ? String(input.trip) : undefined;

  if (!tripInput) {
    const entries = Object.entries(store.trips);
    if (entries.length === 0) return "No trips planned yet.";
    return entries
      .map(([name, trip]) => {
        const dates = trip.start_date
          ? ` (${trip.start_date}${trip.end_date ? ` → ${trip.end_date}` : ""})`
          : "";
        return `${name} — ${trip.destination}${dates}`;
      })
      .join("\n");
  }

  const key = findTrip(store.trips, tripInput);
  if (!key) return `No trip named "${tripInput}".`;
  return formatTrip(key, store.trips[key]);
}

async function handleTravelCreate(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const name = String(input.trip);
  const destination = String(input.destination);

  if (findTrip(store.trips, name)) return `Trip "${name}" already exists.`;

  const trip: TripEntry = {
    destination,
    start_date: input.start_date ? String(input.start_date) : undefined,
    end_date: input.end_date ? String(input.end_date) : undefined,
    ideas: [],
    itinerary: [],
    bookings: [],
  };

  store.trips[name] = trip;
  saveUserStore(ctx, store);

  return `Created trip "${name}" to ${destination}.`;
}

async function handleTravelUpdate(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const key = findTrip(store.trips, String(input.trip));
  if (!key) return `No trip named "${input.trip}".`;

  const trip = store.trips[key];
  const updated: string[] = [];

  if (input.destination) { trip.destination = String(input.destination); updated.push("destination"); }
  if (input.start_date) { trip.start_date = String(input.start_date); updated.push("start date"); }
  if (input.end_date) { trip.end_date = String(input.end_date); updated.push("end date"); }
  if (input.notes !== undefined) { trip.notes = String(input.notes); updated.push("notes"); }

  saveUserStore(ctx, store);
  return `Updated ${key}: ${updated.join(", ")}.`;
}

async function handleTravelAddIdeas(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const key = findTrip(store.trips, String(input.trip));
  if (!key) return `No trip named "${input.trip}".`;

  const ideas = input.ideas as string[];
  store.trips[key].ideas.push(...ideas);
  saveUserStore(ctx, store);

  return `Added ${ideas.length} idea${ideas.length === 1 ? "" : "s"} to "${key}" (${store.trips[key].ideas.length} total).`;
}

async function handleTravelRemoveIdeas(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const key = findTrip(store.trips, String(input.trip));
  if (!key) return `No trip named "${input.trip}".`;

  const patterns = (input.ideas as string[]).map((s) => s.toLowerCase());
  const before = store.trips[key].ideas.length;
  store.trips[key].ideas = store.trips[key].ideas.filter(
    (idea) => !patterns.some((p) => idea.toLowerCase().includes(p))
  );
  const removed = before - store.trips[key].ideas.length;
  saveUserStore(ctx, store);

  return `Removed ${removed} idea${removed === 1 ? "" : "s"} from "${key}".`;
}

async function handleTravelSetItinerary(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const key = findTrip(store.trips, String(input.trip));
  if (!key) return `No trip named "${input.trip}".`;

  const day = String(input.day);
  const items = input.items as string[];

  const existing = store.trips[key].itinerary.find((d) => d.day.toLowerCase() === day.toLowerCase());
  if (existing) {
    existing.day = day;
    existing.items = items;
  } else {
    store.trips[key].itinerary.push({ day, items });
  }

  saveUserStore(ctx, store);
  return `Set itinerary for ${day} on "${key}" (${items.length} activities).`;
}

async function handleTravelAddBooking(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const key = findTrip(store.trips, String(input.trip));
  if (!key) return `No trip named "${input.trip}".`;

  const booking = {
    category: String(input.category),
    details: String(input.details),
  };
  store.trips[key].bookings.push(booking);
  saveUserStore(ctx, store);

  return `Added ${booking.category} booking to "${key}".`;
}

async function handleTravelRemoveBooking(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const key = findTrip(store.trips, String(input.trip));
  if (!key) return `No trip named "${input.trip}".`;

  const match = String(input.match).toLowerCase();
  const before = store.trips[key].bookings.length;
  store.trips[key].bookings = store.trips[key].bookings.filter(
    (b) => !b.details.toLowerCase().includes(match) && !b.category.toLowerCase().includes(match)
  );
  const removed = before - store.trips[key].bookings.length;
  saveUserStore(ctx, store);

  return `Removed ${removed} booking${removed === 1 ? "" : "s"} from "${key}".`;
}

async function handleTravelDelete(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const key = findTrip(store.trips, String(input.trip));
  if (!key) return `No trip named "${input.trip}".`;

  delete store.trips[key];
  saveUserStore(ctx, store);

  return `Deleted trip "${key}".`;
}

export const travelHandlers = new Map<string, ToolHandler>([
  ["travel_view", handleTravelView],
  ["travel_create", handleTravelCreate],
  ["travel_update", handleTravelUpdate],
  ["travel_add_ideas", handleTravelAddIdeas],
  ["travel_remove_ideas", handleTravelRemoveIdeas],
  ["travel_set_itinerary", handleTravelSetItinerary],
  ["travel_add_booking", handleTravelAddBooking],
  ["travel_remove_booking", handleTravelRemoveBooking],
  ["travel_delete", handleTravelDelete],
]);
