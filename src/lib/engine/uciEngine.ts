// src/lib/engine/uciEngine.ts
import type { EngineName } from "@/types/enums";
import type {
  EvaluateGameParams as EvaluateGameParamsBase,
  EvaluatePositionWithUpdateParams,
  GameEval,
  PositionEval,
} from "@/types/eval";

import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import os from "node:os";

/** Префикс для консольных логов этого модуля */
const L = (scope: string, extra?: unknown) =>
  extra !== undefined ? console.debug(`[UciEngine:${scope}]`, extra) : console.debug(`[UciEngine:${scope}]`);
const LI = (scope: string, extra?: unknown) =>
  extra !== undefined ? console.info(`[UciEngine:${scope}]`, extra) : console.info(`[UciEngine:${scope}]`);
const LW = (scope: string, extra?: unknown) =>
  extra !== undefined ? console.warn(`[UciEngine:${scope}]`, extra) : console.warn(`[UciEngine:${scope}]`);
const LE = (scope: string, extra?: unknown) =>
  extra !== undefined ? console.error(`[UciEngine:${scope}]`, extra) : console.error(`[UciEngine:${scope}]`);

// Локальные алиасы на случай одноимённых методов внутри класса
const __LOG_L = L;
const __LOG_LI = LI;
const __LOG_LW = LW;
const __LOG_LE = LE;

/* ------------------------------------------------------------------ */
/* Расширения типов                                                    */
/* ------------------------------------------------------------------ */

type PlayersRatings = { white?: number; black?: number };

/** Базовый тип из вашего проекта + локальное расширение полем playersRatings */
type EvaluateGameParams = EvaluateGameParamsBase & {
  playersRatings?: PlayersRatings;
};

/* ------------------------------------------------------------------ */
/* Вспомогательные утилиты                                             */
/* ------------------------------------------------------------------ */

const ENGINE_PATH =
    process.env.STOCKFISH_PATH || path.resolve("./bin/stockfish");
const DEFAULT_DEPTH = Number.isFinite(Number(process.env.ENGINE_DEPTH))
  ? Number(process.env.ENGINE_DEPTH)
  : 16;
const DEFAULT_MULTIPV = Number.isFinite(Number(process.env.ENGINE_MULTIPV))
  ? Number(process.env.ENGINE_MULTIPV)
  : 3;
const DEFAULT_THREADS = Math.max(1, Math.min(4, (os.cpus()?.length ?? 2) - 1));
const DEFAULT_HASH_MB = Number.isFinite(Number(process.env.ENGINE_HASH_MB))
  ? Number(process.env.ENGINE_HASH_MB)
  : 256;

type LineEval = {
  pv: string[];
  cp?: number;
  mate?: number;
  depth?: number;
  multiPv?: number;
};

function parseInfoLine(s: string): LineEval | null {
  const get = (key: string) => {
    const re = new RegExp(`(?:^| )${key}\\s+(-?\\d+)`);
    const m = s.match(re);
    return m ? Number(m[1]) : undefined;
  };
  const depth = get("depth");
  const multiPv = get("multipv") ?? get("multiPv");
  const mate = get("mate");
  const cp = mate === undefined ? get("cp") : undefined;
  const pvIdx = s.indexOf(" pv ");
  const pv = pvIdx >= 0 ? s.slice(pvIdx + 4).trim().split(/\s+/) : [];
  if (!multiPv) return null;
  const line: LineEval = { pv, depth, multiPv };
  if (typeof mate === "number") line.mate = mate;
  if (typeof cp === "number") line.cp = cp;
  return line;
}

function waitForBestmove(proc: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    const handler = (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("bestmove")) {
        proc.stdout.off("data", handler);
        resolve();
      }
    };
    proc.stdout.on("data", handler);
  });
}

/* ------------------------------------------------------------------ */
/* Основной класс — публичный API оставлен прежним                     */
/* ------------------------------------------------------------------ */

export class UciEngine {
  private engineName!: EngineName;
  private currentProc: ChildProcessWithoutNullStreams | null = null;

  // --- логи совместимы с исходником ---
  private L(scope: string, extra?: unknown): void {
    try {
      __LOG_L(scope, extra);
    } catch {}
  }
  private LI(scope: string, extra?: unknown): void {
    try {
      __LOG_LI(scope, extra);
    } catch {}
  }
  private LW(scope: string, extra?: unknown): void {
    try {
      __LOG_LW(scope, extra);
    } catch {}
  }
  private LE(scope: string, extra?: unknown): void {
    try {
      __LOG_LE(scope, extra);
    } catch {}
  }

  private constructor(engineName: EngineName) {
    this.engineName = engineName;
  }

  /** Фабрика — сохраняем совместимую сигнатуру */
  static async create(engineName: EngineName, _enginePublicPath: string): Promise<UciEngine> {
    const eng = new UciEngine(engineName);
    eng.ensureBinary();
    LI("create:native", { engineName, bin: ENGINE_PATH });
    return eng;
  }

  private ensureBinary() {
    const bin = path.resolve(ENGINE_PATH);
    if (!fs.existsSync(bin)) {
      throw new Error(`Stockfish binary not found at ${bin}. Set ENGINE_PATH or STOCKFISH_PATH.`);
    }
    try {
      fs.accessSync(bin, fs.constants.X_OK);
    } catch {
      this.LW("binary:notExecutable", { bin, hint: `chmod +x "${bin}"` });
    }
  }

  private spawnEngine(): ChildProcessWithoutNullStreams {
    const bin = path.resolve(ENGINE_PATH);
    const proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.currentProc = proc;
    proc.on("exit", (code, sig) => {
      this.L("proc.exit", { code, sig });
      if (this.currentProc === proc) this.currentProc = null;
    });
    proc.stderr.on("data", (b) => this.L("proc.stderr", String(b)));
    return proc;
  }

  private send(proc: ChildProcessWithoutNullStreams, cmd: string) {
    this.L("uci.send", cmd);
    proc.stdin.write(cmd + "\n");
  }

  /** Позиционная оценка с периодическими обновлениями */
  async evaluatePositionWithUpdate(
    params: EvaluatePositionWithUpdateParams,
    onProgress?: (value: number) => void,
  ): Promise<PositionEval> {
    const { fen } = params;
    const depth = Number.isFinite(params.depth) ? Number(params.depth) : DEFAULT_DEPTH;
    const multiPv = Number.isFinite(params.multiPv) ? Number(params.multiPv) : DEFAULT_MULTIPV;
    const threads = Number.isFinite((params as any).threads) ? Number((params as any).threads) : DEFAULT_THREADS;
    const hashMb = Number.isFinite((params as any).hashMb) ? Number((params as any).hashMb) : DEFAULT_HASH_MB;
    const syzygyPath = (params as any).syzygyPath as string | undefined;

    const proc = this.spawnEngine();
    const lines: Record<number, LineEval> = {};
    let bestMove: string | undefined;

    let lastDepthReported = 0;
    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const raw of text.split(/\r?\n/)) {
        const s = raw.trim();
        if (!s) continue;
        if (s.startsWith("info ")) {
          const m = parseInfoLine(s);
          if (m?.multiPv) {
            lines[m.multiPv] = m;
            if (onProgress && m.depth && m.depth !== lastDepthReported) {
              lastDepthReported = m.depth;
              // грубый прогресс по глубине (0..depth)
              const pct = Math.max(0, Math.min(100, Math.round((m.depth / Math.max(1, depth)) * 100)));
              try {
                onProgress(pct);
              } catch (e) {
                this.LW("onProgress:error", e);
              }
            }
          }
        } else if (s.startsWith("bestmove ")) {
          const parts = s.split(/\s+/);
          bestMove = parts[1];
        }
      }
    });

    // init UCI
    this.send(proc, "uci");
    this.send(proc, `setoption name Threads value ${threads}`);
    this.send(proc, `setoption name Hash value ${hashMb}`);
    this.send(proc, `setoption name MultiPV value ${multiPv}`);
    if (syzygyPath) this.send(proc, `setoption name SyzygyPath value ${syzygyPath}`);
    this.send(proc, "isready");

    // go
    this.send(proc, "ucinewgame");
    this.send(proc, `position fen ${fen}`);
    this.send(proc, `go depth ${depth} multipv ${multiPv}`);

    await waitForBestmove(proc);

    // graceful quit
    try {
      proc.stdin.end("quit\n");
    } catch {}
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, 150);

    const ordered = Object.values(lines).sort((a, b) => (a.multiPv! - b.multiPv!));
    // Приводим к PositionEval проекта
    const result: PositionEval = {
      lines: ordered.map((l) => ({
        pv: l.pv,
        cp: l.cp,
        mate: l.mate,
        depth: l.depth,
        multiPv: l.multiPv,
      })) as any,
      bestMove,
    } as any;

    return result;
  }

  /** Оценка целой партии/набора FEN */
  async evaluateGame(params: EvaluateGameParams, onProgress?: (value: number) => void): Promise<GameEval> {
    const fens = Array.isArray(params.fens) ? params.fens : [];
    const depth = Number.isFinite(params.depth) ? Number(params.depth) : DEFAULT_DEPTH;
    const multiPv = Number.isFinite(params.multiPv) ? Number(params.multiPv) : DEFAULT_MULTIPV;

    const positions: PositionEval[] = [];
    const total = fens.length;

    for (let i = 0; i < total; i++) {
      const fen = String(fens[i] ?? "");
      const pe = await this.evaluatePositionWithUpdate({ fen, depth, multiPv });
      positions.push(pe);
      if (onProgress) {
        const pct = Math.round(((i + 1) / Math.max(1, total)) * 100);
        try {
          onProgress(pct);
        } catch (e) {
          this.LW("onProgress:error", e);
        }
      }
    }

    // Минимально совместимый объект GameEval:
    const out: GameEval = {
      positions: positions as any,
      acpl: { white: 0, black: 0 }, // при необходимости можно вычислить отдельно
      settings: {
        engine: "stockfish-native",
        depth,
        multiPv,
      } as any,
    } as any;

    return out;
  }

  /** Следующий ход движка (упрощённо — bestmove на текущей глубине) */
  async getEngineNextMove(fen: string, _elo?: number, depth?: number): Promise<string> {
    const d = Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH;
    const res = await this.evaluatePositionWithUpdate({ fen, depth: d, multiPv: 1 });
    return String(res.bestMove ?? res.lines?.[0]?.pv?.[0] ?? "");
  }

  /** Останов текущих вычислений */
  async stopAllCurrentJobs(): Promise<void> {
    this.LI("stopAllCurrentJobs:start");
    const p = this.currentProc;
    if (!p) return;
    try {
      p.stdin.write("stop\n");
    } catch {}
    setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {}
    }, 100);
    this.currentProc = null;
    this.LI("stopAllCurrentJobs:done");
  }

  /** Отключение/освобождение ресурсов */
  shutdown() {
    this.LI("shutdown:start");
    const p = this.currentProc;
    if (p) {
      try {
        p.stdin.end("quit\n");
      } catch {}
      try {
        p.kill("SIGKILL");
      } catch {}
      this.currentProc = null;
    }
    this.LI("shutdown:terminated");
  }
}
