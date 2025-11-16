// src/types/lichess.ts

export enum LichessError {
  NotFound = "NOT_FOUND",
}

export interface LichessEvalBody {
  depth: number;
  pvs: Array<{
    moves: string;
    cp?: number;
    mate?: number;
  }>;
}

export interface LichessGame {
  id: string;
  pgn: string;
  createdAt: number;
  lastMoveAt: number;
  status: string;
  winner?: "white" | "black";
  moves?: string;
  clock?: {
    initial: number;
    increment: number;
  };
  players: {
    white: {
      user?: {
        name: string;
        title?: string;
      };
      rating?: number;
    };
    black: {
      user?: {
        name: string;
        title?: string;
      };
      rating?: number;
    };
  };
}

export type LichessResponse<T> =
  | T
  | { error: string };