import { EvaluateGameParams, LineEval, PositionEval } from "../types/eval";
import { Game, Player } from "../types/game";
import { Chess, Square } from "chess.js";
import { Color } from "../types/enums";
export declare const getEvaluateGameParams: (game: Chess) => EvaluateGameParams;
export declare const getGameFromPgn: (pgn: string) => Chess;
export declare const formatGameToDatabase: (game: Chess) => Omit<Game, "id">;
export declare const getGameToSave: (game: Chess, board: Chess) => Chess;
export declare const setGameHeaders: (game: Chess, params?: {
    white?: Player;
    black?: Player;
    resigned?: Color;
}) => Chess;
export declare const moveLineUciToSan: (fen: string) => ((moveUci: string) => string);
export declare const getEvaluationBarValue: (position: PositionEval) => {
    whiteBarPercentage: number;
    label: string;
};
export declare const getIsStalemate: (fen: string) => boolean;
export declare const getWhoIsCheckmated: (fen: string) => "w" | "b" | null;
export declare const uciMoveParams: (uciMove: string) => {
    from: Square;
    to: Square;
    promotion?: string | undefined;
};
export declare const isSimplePieceRecapture: (fen: string, uciMoves: [string, string]) => boolean;
export declare const getIsPieceSacrifice: (fen: string, playedMove: string, bestLinePvToPlay: string[]) => boolean;
export declare const getMaterialDifference: (fen: string) => number;
export declare const isCheck: (fen: string) => boolean;
export declare const getLineEvalLabel: (line: Pick<LineEval, "cp" | "mate">) => string;
export declare const formatUciPv: (fen: string, uciMoves: string[]) => string[];
//# sourceMappingURL=chess.d.ts.map