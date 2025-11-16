import type { EngineName } from "../../types/enums";
import type { EvaluateGameParams, EvaluatePositionWithUpdateParams, GameEval, PositionEval } from "../../types/eval";
export declare class UciEngine {
    private currentProc;
    private constructor();
    static create(_engineName: EngineName, _enginePublicPath: string): Promise<UciEngine>;
    private ensureBinary;
    private spawnEngine;
    private send;
    private initSession;
    private evaluateFenOnSession;
    evaluatePositionWithUpdate(params: EvaluatePositionWithUpdateParams, onProgress?: (value: number) => void): Promise<PositionEval>;
    evaluateGame(params: EvaluateGameParams, onProgress?: (value: number) => void): Promise<GameEval>;
    getEngineNextMove(fen: string, _elo?: number, depth?: number): Promise<string>;
    stopAllCurrentJobs(): Promise<void>;
    shutdown(): void;
}
//# sourceMappingURL=uciEngine.d.ts.map