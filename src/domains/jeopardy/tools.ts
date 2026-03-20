import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "../../agent.js";
import type { UserContext } from "../../users.js";
import type { JeopardyGame, Clue, ActiveClue } from "./types.js";
import { loadGame, saveGame, deleteGame } from "./store.js";
import { renderBoard } from "./render.js";

// --- Tool definitions ---

export const jeopardyTools: Anthropic.Tool[] = [
  {
    name: "jeopardy_start",
    description:
      "Start a new Jeopardy game in the current chat. " +
      "Claude generates 5 categories with 5 clues each (scaling in difficulty from $200 to $1000) and passes them in. " +
      "The handler stores the board, randomly places 2 daily doubles (not on $200 clues), and randomly picks who goes first. " +
      "If player2 is omitted, starts a solo game (one player picks and answers everything).",
    input_schema: {
      type: "object" as const,
      properties: {
        player1_id: { type: "number", description: "Telegram userId of player 1" },
        player1_name: { type: "string", description: "Display name of player 1" },
        player2_id: { type: "number", description: "Telegram userId of player 2 (omit for solo mode)" },
        player2_name: { type: "string", description: "Display name of player 2 (omit for solo mode)" },
        categories: {
          type: "array",
          description: "5 categories, each with a name and 5 clues",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Category name (1-2 words, ~10 chars)" },
              clues: {
                type: "array",
                description: "5 clues ordered by difficulty ($200, $400, $600, $800, $1000)",
                items: {
                  type: "object",
                  properties: {
                    question: { type: "string", description: "The clue shown to players" },
                    answer: { type: "string", description: "The correct response" },
                  },
                  required: ["question", "answer"],
                },
              },
            },
            required: ["name", "clues"],
          },
        },
      },
      required: ["player1_id", "player1_name", "categories"],
    },
  },
  {
    name: "jeopardy_pick",
    description:
      "Player selects a clue by category index (0-4) and value index (0-4, where 0=$200 and 4=$1000). " +
      "Returns the clue text, or a daily double prompt if applicable.",
    input_schema: {
      type: "object" as const,
      properties: {
        player_id: { type: "number", description: "Telegram userId of the player picking" },
        category: { type: "number", description: "Category index (0-4)" },
        value_index: { type: "number", description: "Value index (0-4): 0=$200, 1=$400, 2=$600, 3=$800, 4=$1000" },
      },
      required: ["player_id", "category", "value_index"],
    },
  },
  {
    name: "jeopardy_wager",
    description:
      "Place a Daily Double wager. Only valid when there is an active Daily Double clue with no wager yet.",
    input_schema: {
      type: "object" as const,
      properties: {
        player_id: { type: "number", description: "Telegram userId of the wagering player" },
        amount: { type: "number", description: "Wager amount (min $5, max = max(player score, 1000))" },
      },
      required: ["player_id", "amount"],
    },
  },
  {
    name: "jeopardy_answer",
    description:
      "Submit Claude's judgment on the player's answer. Claude sees the player's free-text answer and the stored correct answer, " +
      "judges correctness (accepting reasonable equivalents, misspellings, etc.), and calls this tool with the verdict. " +
      "The tool handles scoring and turn management.",
    input_schema: {
      type: "object" as const,
      properties: {
        correct: { type: "boolean", description: "Whether the player's answer is correct" },
      },
      required: ["correct"],
    },
  },
  {
    name: "jeopardy_status",
    description:
      "Get the current Jeopardy game state for this chat. " +
      "Returns the full board, scores, whose turn it is, and any active clue. " +
      "Returns { active: false } if no game is in progress.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "jeopardy_end",
    description: "End the current Jeopardy game early. Returns final scores and deletes the game.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Handlers ---

const VALUES = [200, 400, 600, 800, 1000];

async function handleStart(input: Record<string, unknown>, ctx: UserContext): Promise<string> {
  const existing = loadGame(ctx.chatId);
  if (existing) {
    return "Error: A Jeopardy game is already active in this chat. Use jeopardy_end to quit first.";
  }

  const categories = input.categories as Array<{ name: string; clues: Array<{ question: string; answer: string }> }>;

  if (categories.length !== 5) return "Error: Exactly 5 categories required.";
  for (const cat of categories) {
    if (cat.clues.length !== 5) return `Error: Category "${cat.name}" must have exactly 5 clues.`;
  }

  // Build the board
  const board: Clue[][] = categories.map((cat) =>
    cat.clues.map((clue, i) => ({
      question: clue.question,
      answer: clue.answer,
      value: VALUES[i],
      answered: false,
      isDailyDouble: false,
    }))
  );

  // Place 2 daily doubles (not on $200 clues, i.e. not index 0)
  const ddPositions: Array<[number, number]> = [];
  while (ddPositions.length < 2) {
    const cat = Math.floor(Math.random() * 5);
    const val = Math.floor(Math.random() * 4) + 1; // indices 1-4
    if (!ddPositions.some(([c, v]) => c === cat && v === val)) {
      ddPositions.push([cat, val]);
      board[cat][val].isDailyDouble = true;
    }
  }

  const p1Id = Number(input.player1_id);
  const solo = !input.player2_id;

  const players: JeopardyGame["players"] = [
    { userId: p1Id, name: String(input.player1_name), score: 0 },
  ];

  if (!solo) {
    players.push({ userId: Number(input.player2_id), name: String(input.player2_name), score: 0 });
  }

  const firstPicker = solo ? p1Id : (Math.random() < 0.5 ? p1Id : players[1].userId);

  const game: JeopardyGame = {
    chatId: ctx.chatId,
    startedAt: new Date().toISOString(),
    players,
    categories: categories.map((c) => c.name),
    board,
    currentPickerId: firstPicker,
    activeClue: null,
    ...(solo && { solo: true }),
  };

  saveGame(ctx.chatId, game);

  return renderBoard(game);
}

async function handlePick(input: Record<string, unknown>, ctx: UserContext): Promise<string> {
  const game = loadGame(ctx.chatId);
  if (!game) return "Error: No active Jeopardy game in this chat.";

  const playerId = Number(input.player_id);
  if (playerId !== game.currentPickerId) {
    const picker = game.players.find((p) => p.userId === game.currentPickerId);
    return `Error: It's ${picker?.name ?? "the other player"}'s turn to pick.`;
  }

  if (game.activeClue) {
    return "Error: There's already an active clue. Answer it first.";
  }

  const catIdx = Number(input.category);
  const valIdx = Number(input.value_index);

  if (catIdx < 0 || catIdx > 4 || valIdx < 0 || valIdx > 4) {
    return "Error: Category and value index must be 0-4.";
  }

  const clue = game.board[catIdx][valIdx];
  if (clue.answered) {
    return `Error: That clue (${game.categories[catIdx]} for $${clue.value}) has already been answered. Pick another.`;
  }

  const active: ActiveClue = {
    categoryIndex: catIdx,
    clueIndex: valIdx,
    playerId,
    wager: null,
    clueText: clue.question,
    correctAnswer: clue.answer,
  };

  if (clue.isDailyDouble) {
    const player = game.players.find((p) => p.userId === playerId)!;
    const maxWager = Math.max(player.score, 1000);
    game.activeClue = active;
    saveGame(ctx.chatId, game);

    return JSON.stringify({
      daily_double: true,
      category: game.categories[catIdx],
      value: clue.value,
      max_wager: maxWager,
      player: player.name,
    });
  }

  active.wager = clue.value;
  game.activeClue = active;
  saveGame(ctx.chatId, game);

  return JSON.stringify({
    category: game.categories[catIdx],
    value: clue.value,
    clue: clue.question,
    correct_answer: clue.answer,
  });
}

async function handleWager(input: Record<string, unknown>, ctx: UserContext): Promise<string> {
  const game = loadGame(ctx.chatId);
  if (!game) return "Error: No active Jeopardy game in this chat.";
  if (!game.activeClue) return "Error: No active clue to wager on.";
  if (game.activeClue.wager !== null) return "Error: Wager already placed.";

  const playerId = Number(input.player_id);
  if (playerId !== game.activeClue.playerId) {
    return "Error: Only the player who picked this Daily Double can wager.";
  }

  const player = game.players.find((p) => p.userId === playerId)!;
  const maxWager = Math.max(player.score, 1000);
  let amount = Number(input.amount);

  if (amount < 5) amount = 5;
  if (amount > maxWager) {
    return `Error: Maximum wager is $${maxWager}. Place a wager between $5 and $${maxWager}.`;
  }

  game.activeClue.wager = amount;
  saveGame(ctx.chatId, game);

  return JSON.stringify({
    category: game.categories[game.activeClue.categoryIndex],
    wager: amount,
    clue: game.activeClue.clueText,
    correct_answer: game.activeClue.correctAnswer,
  });
}

async function handleAnswer(input: Record<string, unknown>, ctx: UserContext): Promise<string> {
  const game = loadGame(ctx.chatId);
  if (!game) return "Error: No active Jeopardy game in this chat.";
  if (!game.activeClue) return "Error: No active clue to judge.";
  if (game.activeClue.wager === null) return "Error: Daily Double wager not yet placed.";

  const correct = Boolean(input.correct);
  const active = game.activeClue;
  const player = game.players.find((p) => p.userId === active.playerId)!;
  const wager = active.wager!;

  if (correct) {
    player.score += wager;
  } else {
    player.score -= wager;
  }

  // Mark clue as answered
  game.board[active.categoryIndex][active.clueIndex].answered = true;
  game.activeClue = null;

  // Switch picker: correct answer = same player picks; wrong = other player picks
  // In solo mode, picker never changes
  if (game.solo) {
    game.currentPickerId = player.userId;
  } else if (correct) {
    game.currentPickerId = player.userId;
  } else {
    const other = game.players.find((p) => p.userId !== player.userId)!;
    game.currentPickerId = other.userId;
  }

  // Check if game is over
  const cluesRemaining = game.board.flat().filter((c) => !c.answered).length;
  const gameOver = cluesRemaining === 0;

  const scores = Object.fromEntries(game.players.map((p) => [p.name, p.score]));

  if (gameOver) {
    let winner: string;
    if (game.solo) {
      winner = game.players[0].name;
    } else {
      const [p1, p2] = game.players;
      winner = p1.score > p2.score ? p1.name : p2.score > p1.score ? p2.name : "Tie";
    }
    deleteGame(ctx.chatId);

    return JSON.stringify({
      correct,
      player: player.name,
      wager,
      scores,
      game_over: true,
      winner,
      clues_remaining: 0,
    });
  }

  saveGame(ctx.chatId, game);

  const picker = game.players.find((p) => p.userId === game.currentPickerId)!;

  return JSON.stringify({
    correct,
    player: player.name,
    wager,
    scores,
    game_over: false,
    next_picker: picker.name,
    clues_remaining: cluesRemaining,
    board: renderBoard(game),
  });
}

async function handleStatus(_input: Record<string, unknown>, ctx: UserContext): Promise<string> {
  const game = loadGame(ctx.chatId);
  if (!game) return JSON.stringify({ active: false });

  const cluesRemaining = game.board.flat().filter((c) => !c.answered).length;

  const result: Record<string, unknown> = {
    active: true,
    board: renderBoard(game),
    scores: Object.fromEntries(game.players.map((p) => [p.name, p.score])),
    clues_remaining: cluesRemaining,
    current_picker: game.players.find((p) => p.userId === game.currentPickerId)?.name,
    solo: game.solo ?? false,
  };

  if (game.activeClue) {
    result.active_clue = {
      category: game.categories[game.activeClue.categoryIndex],
      value: game.board[game.activeClue.categoryIndex][game.activeClue.clueIndex].value,
      clue: game.activeClue.clueText,
      correct_answer: game.activeClue.correctAnswer,
      player: game.players.find((p) => p.userId === game.activeClue!.playerId)?.name,
      awaiting_wager: game.activeClue.wager === null,
    };
  }

  return JSON.stringify(result);
}

async function handleEnd(_input: Record<string, unknown>, ctx: UserContext): Promise<string> {
  const game = loadGame(ctx.chatId);
  if (!game) return "No active Jeopardy game to end.";

  const scores = Object.fromEntries(game.players.map((p) => [p.name, p.score]));
  deleteGame(ctx.chatId);

  return JSON.stringify({ ended: true, final_scores: scores });
}

export const jeopardyHandlers = new Map<string, ToolHandler>([
  ["jeopardy_start", handleStart],
  ["jeopardy_pick", handlePick],
  ["jeopardy_wager", handleWager],
  ["jeopardy_answer", handleAnswer],
  ["jeopardy_status", handleStatus],
  ["jeopardy_end", handleEnd],
]);
