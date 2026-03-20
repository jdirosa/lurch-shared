import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { JeopardyGame } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAMES_DIR = join(__dirname, "..", "..", "..", "data", "games");

function gamePath(chatId: number): string {
  return join(GAMES_DIR, `${chatId}.json`);
}

export function loadGame(chatId: number): JeopardyGame | null {
  const path = gamePath(chatId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function saveGame(chatId: number, game: JeopardyGame): void {
  if (!existsSync(GAMES_DIR)) {
    mkdirSync(GAMES_DIR, { recursive: true });
  }
  writeFileSync(gamePath(chatId), JSON.stringify(game, null, 2));
}

export function deleteGame(chatId: number): void {
  const path = gamePath(chatId);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
