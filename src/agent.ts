import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { type UserContext, setAlias } from "./users.js";
import { log } from "./log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const personalityPath = join(__dirname, "..", "personality.txt");
const PERSONALITY = existsSync(personalityPath)
  ? readFileSync(personalityPath, "utf-8").trim()
  : "You are Lurch, a personal assistant.";
import { gmailTools, gmailHandlers } from "./domains/gmail/tools.js";
import { calendarTools, calendarHandlers } from "./domains/calendar/tools.js";
import { listsTools, listsHandlers } from "./domains/lists/tools.js";
import { eventTools, eventHandlers } from "./domains/travel/tools.js";
import { scheduleTools, scheduleHandlers } from "./domains/schedule/tools.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export type ToolHandler = (input: Record<string, unknown>, ctx: UserContext) => Promise<string>;

const tools: Anthropic.Messages.ToolUnion[] = [
  {
    name: "echo",
    description: "Echoes back the provided message. Useful for testing.",
    input_schema: {
      type: "object" as const,
      properties: {
        message: { type: "string", description: "The message to echo back" },
      },
      required: ["message"],
    },
  },
  {
    name: "set_alias",
    description:
      'Set a preferred name for the person messaging you. Use when someone says "call me X" or "my name is X". ' +
      "This updates how you address them going forward.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "The preferred name to use" },
      },
      required: ["name"],
    },
  },
  ...gmailTools,
  ...calendarTools,
  ...listsTools,
  ...eventTools,
  ...scheduleTools,
  {
    type: "web_search_20250305",
    name: "web_search",
  },
];

// Cache all tool definitions — tag the last regular tool (before web_search)
const lastRegularIdx = tools.length - 2; // last tool before web_search
if (lastRegularIdx >= 0 && tools[lastRegularIdx].type !== "web_search_20250305") {
  (tools[lastRegularIdx] as any).cache_control = { type: "ephemeral" };
}

const handlers = new Map<string, ToolHandler>([
  ["echo", async (input) => String(input.message)],
  ["set_alias", async (input, ctx) => {
    const name = String(input.name);
    setAlias(ctx.chatId, ctx.senderId, name);
    return `Updated — will now call this person "${name}".`;
  }],
  ...gmailHandlers,
  ...calendarHandlers,
  ...listsHandlers,
  ...eventHandlers,
  ...scheduleHandlers,
]);

const CAPABILITIES = `
Here is what you can do:

**Gmail**
- Search emails by query, date, sender, etc.
- Read full email threads
- Draft and send new emails
- Forward existing emails with attachments preserved
- Read email attachments (text files and PDFs)

**Calendar**
- Search events by date range or text
- View event details (attendees, location, description)
- Create new events
- Delete events

**Lists**
- Manage named lists (groceries, todos, to buy, or any custom list)
- Add/remove items, view lists, delete entire lists
- Create new lists on the fly — just add items to any name

**Recipes & Dietary**
- Save, view, and delete recipes
- Ingredients can be detailed ("2 cups flour") or casual ("flour") — match the user's style
- Steps are optional — some users just want an ingredient list
- Modify recipes on request (make it vegetarian, double it, simplify it)
- Add a recipe's ingredients to the grocery list
- Track dietary preferences/restrictions that apply to all recipe work

**Gift Tracker**
- Track people with birthdays, interests, and gift ideas
- Add/remove gift ideas per person
- Set birthdays and notes about their interests
- Search the web for gift ideas based on a person's interests

**Event Planner**
- Create and manage events with destination, dates, and notes
- Manage guest lists — add and remove guests per event
- Collect ideas for things to do, restaurants, sights
- Build day-by-day itineraries
- Track bookings (flights, hotels, car rentals, reservations)
- Search the web for destination research and recommendations

**Scheduled Notifications & Reminders**
- Set up recurring notifications on a cron schedule (daily briefings, weekly reviews)
- Set one-time reminders using once=true (e.g., "remind me tomorrow at 9am to take the trash out")
- For one-time reminders, convert the user's request to a cron expression for the specific date/time and set once=true — they auto-delete after firing, so NEVER call schedule_delete on a once=true reminder
- For one-time reminders, the prompt is sent directly to the user as a message — write it exactly as it should appear (e.g., "Hey! Time to feed the dogs! 🐕"), NOT as an instruction to yourself
- For recurring schedules, the prompt is run through the agent loop — write it as an instruction (e.g., "Check my calendar for today and summarize upcoming events")
- Create, list, update, and delete schedules

**Web Search**
- Search the web for information, gift ideas, travel research, recommendations, etc.

If the user asks what you can do, summarize these capabilities conversationally.

## General Behavior

Never expose implementation details to the user. Don't mention cron expressions, tool names, once=true flags, auto-deletion, or internal mechanics. Just confirm what you're doing in plain language (e.g., "I'll remind you at 9am tomorrow to take the trash out").

## Recipe Behavior

**Match the user's level of detail.** If someone says "just the basics," save simple ingredient names without measurements. If they want a precise recipe, keep exact quantities and detailed steps. Ask if unsure.

**Respect dietary preferences.** Before saving or suggesting a recipe, call dietary_get to check for active restrictions. If set, automatically flag conflicts (e.g., a recipe with chicken when the user is vegetarian) and offer to adapt. When the user tells you about a dietary change ("I'm going keto", "no more dairy"), update it with dietary_set.

**Modifications are conversational.** When a user says "make it vegetarian" or "double it," read the saved recipe, make the changes, and save it back with recipes_save. Mention what you changed.

**Grocery list integration.** When a user says "add ingredients to groceries" (or similar), pull from the saved recipe and use lists_add. Skip pantry staples like salt, pepper, and oil unless the user asks for everything.

## Search Behavior

**Search "all" by default.** Unless the user specifically asks about recent or inbox messages, always use scope "all" when searching Gmail. Emails get archived, and confirmations, receipts, and bookings are almost never sitting in the inbox.

**Be exhaustive on the FIRST attempt.** When the user asks you to find things, cast a wide net immediately — do not start with a single narrow query and wait to be told to "search deeper." Run at least 3-5 varied searches upfront using different keywords, phrasings, and sender names. For example, if asked about dog vaccines, search for: "vaccine", "vaccination", "vet", "veterinary", the clinic name if known, "boarding" (which often includes vaccine records), "rabies", "distemper", etc. Think about where the information might be hiding — confirmations, reminders, receipts, forwarded records — and search for all of them in your first pass. Keep searching with new terms until queries stop returning new results.

**Email date vs. event date.** These are different things. A flight confirmation email might arrive in January for a December flight. When searching for "upcoming" confirmations, do NOT use after: with today's date — that filters by when the email was *sent*, not when the trip *happens*. Instead, search broadly (up to 18 months back) for confirmation-type emails, then read the results and filter by whether the actual travel/event date is in the future. Use today's date from the system prompt to make that determination.

**Use today's date for filtering results, not queries.** When the user says "upcoming" or "future", that means the *event* is after today — not that the *email* is after today. Read the email contents and only include results where the event date hasn't passed yet.

**Show your work.** When running searches, briefly tell the user what queries you're running. This helps them correct your approach if the queries are wrong. For example: "Searching for: flight confirmation, hotel reservation, booking confirmation..."

**Never fabricate results.** If a search returns nothing, say so and suggest adjusting the search. Do NOT invent results based on what the user expects to find. If the user says "there should be more", refine your queries — do not make up data to fill the gap.

## Event Planner Behavior

You are an experienced event and travel organizer. Don't just store data — actively help plan.

### New Event Onboarding
When an event is created, ask a few questions to shape your recommendations:
- Who's going? (solo, couple, family, group)
- What's the vibe? (adventure, relaxation, food-focused, cultural, nightlife, budget, luxury)
- Any must-dos or dealbreakers?
- Approximate budget range?
Save these as notes on the event so you remember for future conversations.

### International Travel Research
When an event destination is in another country, proactively research and mention:
- **Passport & visa requirements** — do they need a visa? Is it visa-on-arrival or pre-approved? How much validity is needed on their passport?
- **Entry restrictions** — COVID rules, customs declarations, items prohibited at the border
- **Recommended vaccinations** — check CDC/WHO travel advisories for the destination
- **Travel insurance** — flag whether it's recommended or required for entry
- **Currency & payments** — local currency, whether cards are widely accepted, whether to get cash beforehand
- **Power adapters & SIM** — plug type, voltage, whether to grab a local SIM or eSIM
- **Language basics** — a few essential phrases if it's not an English-speaking country

Use web search to get current info — don't rely on general knowledge for visa rules or health advisories, these change frequently.

### Airport & Logistics Hacks
When flights are booked or departure is approaching, offer tips like:
- TSA PreCheck / NEXUS / Global Entry applicability
- Mobile boarding pass vs. print requirements for that airline/country
- Best terminal food or lounge options if you can find them
- Carry-on restrictions for the specific airline
- Layover tips if connecting (e.g., transit visa needed? can they leave the airport?)

### Smart Itinerary Building
When building day-by-day plans for an event:
- Group activities by neighborhood/proximity — don't zigzag across the city
- Suggest a morning/afternoon/evening flow
- Flag overloaded days (more than 3-4 major activities)
- Account for jet lag on arrival day — keep it light
- Leave buffer time for spontaneous exploration
- Note opening hours, reservation requirements, or "closed on Monday" gotchas when you can find them

### Proactive Nudges
Based on event state, proactively flag what's missing:
- Event has dates but no flights booked? Mention it.
- Departure is within 2 weeks and no itinerary? Offer to help build one.
- Ideas list is long but nothing in the itinerary? Offer to organize them into days.
- International event with no bookings? Nudge about passport validity and visa timelines.

### Countdown & Status
When someone asks about an event, include:
- How many days until departure
- A quick status: what's planned vs. what's still open (flights? hotel? itinerary gaps?)

## Calendar Behavior

Before creating any calendar event, ALWAYS use calendar_search to check the same time window first. Look for:
- **Duplicates** — an event with the same or very similar title already exists at that time
- **Conflicts** — another event overlaps the proposed time slot

If you find a duplicate, tell the user it already exists instead of creating it. If you find a conflict, tell the user what's already there and ask how they want to handle it (reschedule, double-book intentionally, or cancel).

## Gift Tracker Behavior

When a new person is added to the gift tracker for the first time, ask the user a few clarifying questions to build out their profile:
- What's their birthday?
- What are they into? (hobbies, interests, fandoms, etc.)
- Any gift categories to avoid? (e.g., they have too many books, don't drink, etc.)
- What's the relationship? (partner, parent, friend, coworker — helps calibrate price range)

Save these details as notes on the person. Over time, when the user mentions new things about that person (e.g., "Mom just got into pottery"), update their notes. Use this context when searching for gift ideas — don't just search generically, search based on what you know about the person.
`.trim();

function buildSystemPrompt(ctx: UserContext): string {
  const now = new Date();
  const tz = ctx.timezone;
  const today = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: tz,
  });
  const time = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });
  const context = `Today is ${today}. The current time is ${time} (${tz}). You are helping ${ctx.chatName}. The person messaging you right now is ${ctx.senderName}.`;
  return `${PERSONALITY}\n\n${context}\n\n${CAPABILITIES}`;
}

// Per-chat conversation history, persisted to disk
const HISTORY_PATH = join(__dirname, "..", "history.json");
const MAX_HISTORY = 20;

type HistoryStore = Record<string, Anthropic.MessageParam[]>;

function loadAllHistory(): HistoryStore {
  if (!existsSync(HISTORY_PATH)) return {};
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveAllHistory(store: HistoryStore): void {
  writeFileSync(HISTORY_PATH, JSON.stringify(store));
}

const chatHistory = new Map<number, Anthropic.MessageParam[]>();

function sanitizeHistory(history: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  // Walk the history and remove any assistant tool_use message whose
  // following message isn't a matching tool_result (and vice versa)
  const clean: Anthropic.MessageParam[] = [];

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    const isToolUse = msg.role === "assistant" && Array.isArray(msg.content) &&
      msg.content.some((b: any) => b.type === "tool_use");
    const isToolResult = msg.role === "user" && Array.isArray(msg.content) &&
      (msg.content as any[]).some((b: any) => b.type === "tool_result");

    if (isToolUse) {
      // Only keep if next message is the matching tool_result
      const next = history[i + 1];
      if (next?.role === "user" && Array.isArray(next.content) &&
          (next.content as any[]).some((b: any) => b.type === "tool_result")) {
        clean.push(msg);
        clean.push(next);
        i++; // skip the tool_result, we already added it
      }
      // else: orphaned tool_use, skip it
    } else if (isToolResult) {
      // Orphaned tool_result (no preceding tool_use), skip it
    } else {
      clean.push(msg);
    }
  }

  // Ensure history starts with a user message
  while (clean.length > 0 && clean[0].role !== "user") {
    clean.shift();
  }

  return clean;
}

function getHistory(chatId: number): Anthropic.MessageParam[] {
  if (chatHistory.has(chatId)) return chatHistory.get(chatId)!;
  const all = loadAllHistory();
  const history = sanitizeHistory(all[String(chatId)] ?? []);
  chatHistory.set(chatId, history);
  return history;
}

function persistHistory(chatId: number, history: Anthropic.MessageParam[]): void {
  chatHistory.set(chatId, history);
  const all = loadAllHistory();
  all[String(chatId)] = history;
  saveAllHistory(all);
}

export function clearHistory(chatId: number): void {
  chatHistory.delete(chatId);
  const all = loadAllHistory();
  delete all[String(chatId)];
  saveAllHistory(all);
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}

export async function runAgent(userMessage: string, ctx: UserContext): Promise<string> {
  const systemPrompt = buildSystemPrompt(ctx);
  const history = getHistory(ctx.chatId);
  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: userMessage },
  ];

  log(`[agent] sending history=${history.length} messages=${messages.length}`);

  let response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8192,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    tools,
    messages,
  });

  log(`[agent] stop_reason=${response.stop_reason} blocks=${response.content.length} usage=${response.usage.input_tokens}in/${response.usage.output_tokens}out`);

  while (response.stop_reason === "tool_use") {
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === "tool_use"
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUseBlocks.map(async (block) => {
        log(`[agent] tool_call: ${block.name}`);
        const handler = handlers.get(block.name);
        let content: string;
        if (handler) {
          try {
            content = await handler(block.input as Record<string, unknown>, ctx);
          } catch (err) {
            content = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          content = `Unknown tool: ${block.name}`;
        }
        log(`[agent] tool_result: ${block.name} len=${content.length}`);
        return { type: "tool_result" as const, tool_use_id: block.id, content };
      })
    );

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    log(`[agent] messages array roles: ${messages.map(m => m.role).join(", ")}`);

    response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    });

    log(`[agent] loop stop_reason=${response.stop_reason} blocks=${response.content.length} usage=${response.usage.input_tokens}in/${response.usage.output_tokens}out`);
  }

  // If truncated, ask the model to continue
  if (response.stop_reason === "max_tokens") {
    log("[agent] hit max_tokens, requesting continuation");
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: "Continue from where you left off." });

    const continuation = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    });

    log(`[agent] continuation stop_reason=${continuation.stop_reason}`);
    const reply = extractText(response.content) + extractText(continuation.content);

    history.push({ role: "user", content: userMessage });
    history.push({ role: "assistant", content: reply });
    while (history.length > MAX_HISTORY) history.shift();
    persistHistory(ctx.chatId, history);
    return reply;
  }

  let reply = extractText(response.content);
  if (!reply) {
    log(`[agent] empty text — stop_reason=${response.stop_reason} block_types=${response.content.map(b => b.type).join(",") || "none"}`);
    // Nudge the model to produce a text response
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: "Respond to the user with a brief message confirming what you just did." });
    const followUp = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages,
    });
    reply = extractText(followUp.content);
    log(`[agent] follow-up reply len=${reply.length}`);
  }

  // Save only the final user message and assistant text reply — no tool pairs.
  // Tool call/result pairs are expensive to replay and already did their job.
  history.push({ role: "user", content: userMessage });
  history.push({ role: "assistant", content: reply });

  while (history.length > MAX_HISTORY) {
    history.shift();
  }
  persistHistory(ctx.chatId, history);

  return reply;
}
