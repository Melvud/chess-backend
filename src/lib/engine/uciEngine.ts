// src/lib/engine/uciEngine.ts
import type { EngineName } from "@/types/enums";
import type {
  EvaluateGameParams,
  EvaluatePositionWithUpdateParams,
  GameEval,
  PositionEval,
} from "@/types/eval";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import os from "node:os";

/* ... (логирование и типы оставлены без изменений) ... */

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

/* ... parseInfoLine и waitForBestmove без изменений ... */

export class UciEngine {
  private engineName!: EngineName;
  private currentProc: ChildProcessWithoutNullStreams | null = null;

  private constructor(engineName: EngineName) {
    this.engineName = engineName;
  }

  /** Фабрика — создаёт UciEngine с использованием нативного бинарника. */
  static async create(engineName: EngineName, _enginePublicPath: string): Promise<UciEngine> {
    const eng = new UciEngine(engineName);
    eng.ensureBinary();
    console.info(`[UciEngine:create:native]`, { engineName, bin: ENGINE_PATH });
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
      console.warn(`[UciEngine] binary:notExecutable`, { bin, hint: `chmod +x "${bin}"` });
    }
  }

  private spawnEngine(): ChildProcessWithoutNullStreams {
    const bin = path.resolve(ENGINE_PATH);
    const proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.currentProc = proc;
    proc.on("exit", (code, sig) => {
      if (this.currentProc === proc) this.currentProc = null;
    });
    proc.stderr.on("data", (b) => console.warn(`[UciEngine] stderr:`, String(b)));
    return proc;
  }

  private send(proc: ChildProcessWithoutNullStreams, cmd: string) {
    proc.stdin.write(cmd + "\n");
  }

  /** Оценка позиции с поддержкой MultiPV — идентично Chesskit. */
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
              const pct = Math.max(0, Math.min(100, Math.round((m.depth / Math.max(1, depth)) * 100)));
              try {
                onProgress(pct);
              } catch {}
            }
          }
        } else if (s.startsWith("bestmove ")) {
          const parts = s.split(/\s+/);
          bestMove = parts[1];
        }
      }
    });

    // инициализация движка
    this.send(proc, "uci");
    this.send(proc, `setoption name Threads value ${threads}`);
    this.send(proc, `setoption name Hash value ${hashMb}`);
    this.send(proc, `setoption name MultiPV value ${multiPv}`);
    if (syzygyPath) this.send(proc, `setoption name SyzygyPath value ${syzygyPath}`);
    this.send(proc, "isready");

    // новый поиск
    this.send(proc, "ucinewgame");
    this.send(proc, `position fen ${fen}`);
    // В Chesskit multipv не передаётся в команду go
    this.send(proc, `go depth ${depth}`);

    await waitForBestmove(proc);

    // завершение
    try {
      proc.stdin.end("quit\n");
    } catch {}
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, 150);

    const ordered = Object.values(lines).sort((a, b) => (a.multiPv! - b.multiPv!));
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

  /** Оценка списка FEN — цикл по позициям. */
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
        } catch {}
      }
    }

    const out: GameEval = {
      positions: positions as any,
      acpl: { white: 0, black: 0 },
      settings: {
        engine: "stockfish-native",
        depth,
        multiPv,
      } as any,
    } as any;

    return out;
  }

  /** Следующий ход — просто bestmove на глубине depth. */
  async getEngineNextMove(fen: string, _elo?: number, depth?: number): Promise<string> {
    const d = Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH;
    const res = await this.evaluatePositionWithUpdate({ fen, depth: d, multiPv: 1 });
    return String(res.bestMove ?? res.lines?.[0]?.pv?.[0] ?? "");
  }

  async stopAllCurrentJobs(): Promise<void> {
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
  }

  shutdown() {
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
  }
}