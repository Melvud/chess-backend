import { PositionEval } from "../types/eval";
import { LichessResponse } from "../types/lichess";
import { LoadedGame } from "../types/game";
export declare const getLichessEval: (fen: string, multiPv?: number) => Promise<PositionEval>;
export declare const getLichessUserRecentGames: (username: string, signal?: AbortSignal) => Promise<LoadedGame[]>;
export declare const fetchLichessGame: (gameId: string, signal?: AbortSignal) => Promise<LichessResponse<string>>;
//# sourceMappingURL=lichess.d.ts.map