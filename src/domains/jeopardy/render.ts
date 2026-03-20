import type { JeopardyGame } from "./types.js";

export function renderBoard(game: JeopardyGame): string {
  const lines: string[] = ["JEOPARDY BOARD", "─────────────────────"];

  const maxCatLen = Math.max(...game.categories.map((c) => c.length));

  for (let cat = 0; cat < 5; cat++) {
    const label = game.categories[cat].toUpperCase().padEnd(maxCatLen);
    const cells = game.board[cat]
      .map((clue) => (clue.answered ? "X" : "."))
      .join("  ");
    lines.push(`${label}:  ${cells}`);
  }

  const padding = " ".repeat(maxCatLen + 2);
  lines.push(`${padding} 2  4  6  8  10 (x$100)`);
  lines.push("");

  const scoreLine = game.players
    .map((p) => `${p.name}: $${p.score.toLocaleString()}`)
    .join("  |  ");
  lines.push(scoreLine);

  if (!game.solo) {
    const picker = game.players.find((p) => p.userId === game.currentPickerId);
    if (picker) {
      lines.push(`${picker.name} picks next.`);
    }
  }

  return lines.join("\n");
}
