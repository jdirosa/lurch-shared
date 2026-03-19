import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { UserContext } from "./users.js";
import { gmailTools, gmailHandlers } from "./domains/gmail/tools.js";
import { calendarTools, calendarHandlers } from "./domains/calendar/tools.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export type ToolHandler = (input: Record<string, unknown>, ctx: UserContext) => Promise<string>;

const tools: Anthropic.Tool[] = [
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
];

const handlers = new Map<string, ToolHandler>([
  ["echo", async (input) => String(input.message)],
  ...gmailHandlers,
  ...calendarHandlers,
]);

function buildSystemPrompt(ctx: UserContext): string {
  if (ctx.type === "private") {
    return `You are Lurch, a personal assistant. You are helping ${ctx.userName}.`;
  }
  return "You are Lurch, a personal assistant. You are helping the household.";
}

// Per-chat conversation history (in-memory, lost on restart)
const chatHistory = new Map<number, Anthropic.MessageParam[]>();
const MAX_HISTORY = 20; // keep last 20 messages per chat

export async function runAgent(userMessage: string, ctx: UserContext): Promise<string> {
  const systemPrompt = buildSystemPrompt(ctx);
  const history = chatHistory.get(ctx.chatId) ?? [];
  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: userMessage },
  ];

  let response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
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
      max_tokens: 1024,
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

  // Trim to max history
  while (history.length > MAX_HISTORY) {
    history.shift();
  }
  chatHistory.set(ctx.chatId, history);

  return reply;
}
