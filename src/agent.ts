import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

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
];

const handlers = new Map<string, ToolHandler>([
  ["echo", async (input) => String(input.message)],
]);

const SYSTEM_PROMPT = "You are Lurch, a personal assistant.";

export async function runAgent(userMessage: string): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools,
    messages,
  });

  while (response.stop_reason === "tool_use") {
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ContentBlockParam & { type: "tool_use" } =>
        block.type === "tool_use"
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const handler = handlers.get(block.name);
        let content: string;
        if (handler) {
          try {
            content = await handler(block.input as Record<string, unknown>);
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
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
  }

  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock && "text" in textBlock ? textBlock.text : "(no response)";
}
