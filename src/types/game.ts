// src/types/game.ts

export interface Player {
  name: string;
  rating?: number;
  title?: string;
}

export interface Game {
  id: string;
  pgn: string;
  event?: string;
  site?: string;
  date?: string;
  round?: string;
  white: Player;
  black: Player;
  result?: string;
  termination?: string;
  timeControl?: string;
}

export interface LoadedGame {
  id: string;
  pgn: string;
  white: Player;
  black: Player;
  result?: string;
  timeControl?: string;
  date?: string;
  movesNb?: number;
  url?: string;
}