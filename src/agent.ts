import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import type { UserContext } from "./users.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const personalityPath = join(__dirname, "..", "personality.txt");
const PERSONALITY = existsSync(personalityPath)
  ? readFileSync(personalityPath, "utf-8").trim()
  : "You are Lurch, a personal assistant.";
import { gmailTools, gmailHandlers } from "./domains/gmail/tools.js";
import { calendarTools, calendarHandlers } from "./domains/calendar/tools.js";
import { listsTools, listsHandlers } from "./domains/lists/tools.js";
import { travelTools, travelHandlers } from "./domains/travel/tools.js";
import { jeopardyTools, jeopardyHandlers } from "./domains/jeopardy/tools.js";

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
  ...gmailTools,
  ...calendarTools,
  ...listsTools,
  ...travelTools,
  ...jeopardyTools,
  {
    type: "web_search_20250305",
    name: "web_search",
  },
];

const handlers = new Map<string, ToolHandler>([
  ["echo", async (input) => String(input.message)],
  ...gmailHandlers,
  ...calendarHandlers,
  ...listsHandlers,
  ...travelHandlers,
  ...jeopardyHandlers,
]);

const CAPABILITIES = `
Here is what you can do:

**Gmail**
- Search emails by query, date, sender, etc.
- Read full email threads
- Draft and send new emails
- Forward existing emails with attachments preserved

**Calendar**
- Search events by date range or text
- View event details (attendees, location, description)
- Create new events
- Delete events

**Lists**
- Manage named lists (groceries, todos, to buy, or any custom list)
- Add/remove items, view lists, delete entire lists
- Create new lists on the fly — just add items to any name

**Gift Tracker**
- Track people with birthdays, interests, and gift ideas
- Add/remove gift ideas per person
- Set birthdays and notes about their interests
- Search the web for gift ideas based on a person's interests

**Travel Planner**
- Create and manage trips with destination, dates, and notes
- Collect ideas for things to do, restaurants, sights
- Build day-by-day itineraries
- Track bookings (flights, hotels, car rentals, reservations)
- Search the web for destination research and recommendations

**Jeopardy**
- Head-to-head trivia game for 2 players, or solo mode for 1 player
- 5x5 board with 5 categories and clues from $200 to $1000
- Daily Doubles with custom wagers
- Scores track across the full game

**Web Search**
- Search the web for information, gift ideas, travel research, recommendations, etc.

If the user asks what you can do, summarize these capabilities conversationally.

## Jeopardy Behavior

**Starting a game:** Jeopardy supports 2-player (head-to-head) or solo mode. For 2 players, identify both from chat context or ask who's playing. For solo, just use the sender's info and omit player2. If someone says "let's play Jeopardy" alone in a DM, start a solo game. Generate 5 categories with 5 clues each — difficulty must scale with dollar value ($200 = easy, $1000 = hard but fair). All clues must use pre-May 2025 knowledge only.

**Category generation:** Keep names short (1-2 words, ~10 chars) for board display. Mix types: knowledge, wordplay, pop culture, academic. Decade-scoped pop culture is fine ("2000s Hip Hop", "90s Sitcoms").

**Answer judging:** Accept reasonable equivalents ("FDR" for "Franklin Delano Roosevelt"). Don't require "What is..." phrasing. Accept minor misspellings if intent is clear. Reject partially correct answers when specificity matters ("Roosevelt" alone when the answer is specifically "Theodore Roosevelt"). When in doubt, give it to the player.

**Mid-game recovery:** If a user mentions Jeopardy or answers a trivia question and you don't have game context in your conversation history, call jeopardy_status to check for an active game. The game state persists independently of conversation history.

**Board display:** Always render the board inside a code block after picks, answers, and status checks.

## Search Behavior

**Search "all" by default.** Unless the user specifically asks about recent or inbox messages, always use scope "all" when searching Gmail. Emails get archived, and confirmations, receipts, and bookings are almost never sitting in the inbox.

**Be exhaustive on the FIRST attempt.** When the user asks you to find things, cast a wide net immediately — do not start with a single narrow query and wait to be told to "search deeper." Run at least 3-5 varied searches upfront using different keywords, phrasings, and sender names. For example, if asked about dog vaccines, search for: "vaccine", "vaccination", "vet", "veterinary", the clinic name if known, "boarding" (which often includes vaccine records), "rabies", "distemper", etc. Think about where the information might be hiding — confirmations, reminders, receipts, forwarded records — and search for all of them in your first pass. Keep searching with new terms until queries stop returning new results.

**Email date vs. event date.** These are different things. A flight confirmation email might arrive in January for a December flight. When searching for "upcoming" confirmations, do NOT use after: with today's date — that filters by when the email was *sent*, not when the trip *happens*. Instead, search broadly (up to 18 months back) for confirmation-type emails, then read the results and filter by whether the actual travel/event date is in the future. Use today's date from the system prompt to make that determination.

**Use today's date for filtering results, not queries.** When the user says "upcoming" or "future", that means the *event* is after today — not that the *email* is after today. Read the email contents and only include results where the event date hasn't passed yet.

**Show your work.** When running searches, briefly tell the user what queries you're running. This helps them correct your approach if the queries are wrong. For example: "Searching for: flight confirmation, hotel reservation, booking confirmation..."

**Never fabricate results.** If a search returns nothing, say so and suggest adjusting the search. Do NOT invent results based on what the user expects to find. If the user says "there should be more", refine your queries — do not make up data to fill the gap.

## Travel Planner Behavior

You are an experienced travel organizer. Don't just store data — actively help plan.

### New Trip Onboarding
When a trip is created, ask a few questions to shape your recommendations:
- Who's going? (solo, couple, family, group)
- What's the vibe? (adventure, relaxation, food-focused, cultural, nightlife, budget, luxury)
- Any must-dos or dealbreakers?
- Approximate budget range?
Save these as notes on the trip so you remember for future conversations.

### International Travel Research
When a trip destination is in another country, proactively research and mention:
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
When building day-by-day plans:
- Group activities by neighborhood/proximity — don't zigzag across the city
- Suggest a morning/afternoon/evening flow
- Flag overloaded days (more than 3-4 major activities)
- Account for jet lag on arrival day — keep it light
- Leave buffer time for spontaneous exploration
- Note opening hours, reservation requirements, or "closed on Monday" gotchas when you can find them

### Proactive Nudges
Based on trip state, proactively flag what's missing:
- Trip has dates but no flights booked? Mention it.
- Departure is within 2 weeks and no itinerary? Offer to help build one.
- Ideas list is long but nothing in the itinerary? Offer to organize them into days.
- International trip with no bookings? Nudge about passport validity and visa timelines.

### Countdown & Status
When someone asks about a trip, include:
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
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const context = `Today is ${today}. You are helping ${ctx.chatName}. The person messaging you right now is ${ctx.senderName}.`;
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
  // Remove orphaned tool_result messages at the start (no preceding tool_use)
  while (history.length > 0 && Array.isArray(history[0]?.content) &&
         (history[0].content as any[]).some((b: any) => b.type === "tool_result")) {
    history.shift();
  }
  // Ensure history starts with a user message
  while (history.length > 0 && history[0].role !== "user") {
    history.shift();
  }
  return history;
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

export async function runAgent(userMessage: string, ctx: UserContext): Promise<string> {
  const systemPrompt = buildSystemPrompt(ctx);
  const history = getHistory(ctx.chatId);
  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: userMessage },
  ];

  let response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: systemPrompt,
    tools,
    messages,
  });

  while (response.stop_reason === "tool_use") {
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === "tool_use"
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUseBlocks.map(async (block) => {
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
        return { type: "tool_result" as const, tool_use_id: block.id, content };
      })
    );

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });
  }

  const textBlock = response.content.find((block) => block.type === "text");
  const reply = textBlock && "text" in textBlock ? textBlock.text : "(no response)";

  // Save conversation turn to history
  history.push({ role: "user", content: userMessage });
  history.push({ role: "assistant", content: response.content });

  // Trim to max history — remove pairs from the front, ensuring we never
  // orphan tool_use/tool_result messages
  while (history.length > MAX_HISTORY) {
    const removed = history.shift();
    if (!removed) break;

    // If we removed an assistant message containing tool_use blocks,
    // the next message is a user message with tool_results — remove it too
    if (removed.role === "assistant" && Array.isArray(removed.content) &&
        removed.content.some((b: any) => b.type === "tool_use")) {
      history.shift(); // remove the paired tool_result user message
    }

    // If we removed a user message with tool_results,
    // the previous message we kept might now be orphaned — but since we
    // trim from the front, this means the assistant tool_use was already gone.
    // However, we might now start with a user tool_result message — clean it up.
    while (history.length > 0 && Array.isArray(history[0]?.content) &&
           (history[0].content as any[]).some((b: any) => b.type === "tool_result")) {
      history.shift();
    }
  }
  persistHistory(ctx.chatId, history);

  return reply;
}
