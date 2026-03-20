export interface Player {
  userId: number;
  name: string;
  score: number;
}

export interface Clue {
  question: string;
  answer: string;
  value: number;
  answered: boolean;
  isDailyDouble: boolean;
}

export interface ActiveClue {
  categoryIndex: number;
  clueIndex: number;
  playerId: number;
  wager: number | null;
  clueText: string;
  correctAnswer: string;
}

export interface JeopardyGame {
  chatId: number;
  startedAt: string;
  players: Player[];
  categories: string[];
  board: Clue[][];
  currentPickerId: number;
  activeClue: ActiveClue | null;
  solo?: boolean;
}
