// src/lib/engine/uciEngine.ts
// Реализует UCI‑движок через нативный бинарник Stockfish.
// В отличие от браузерной версии Chesskit, здесь нет Web Worker,
// поэтому мы напрямую читаем stdout процесса, накапливаем сообщения
// и затем используем parseEvaluationResults для разбора оценок и bestmove.

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

// Импортируем парсер результатов из Chesskit
import { parseEvaluationResults } from "@/lib/engine/helpers/parseResults";

// Вспомогательный тип строки info (для отслеживания прогресса)
interface LineEvalProgress {
  pv: string[];
  cp?: number;
  mate?: number;
  depth?: number;
  multiPv?: number;
}

// Парсим строку info для обновления прогресса. В отличие от Chesskit,
// используем только для прогресса, а сами результаты парсятся через parseResults.
function parseInfoLineForProgress(s: string): LineEvalProgress | null {
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
  const line: LineEvalProgress = { pv, depth, multiPv };
  if (typeof mate === "number") line.mate = mate;
  if (typeof cp === "number") line.cp = cp;
  return line;
}

// Асинхронно ждём появления bestmove в stdout движка и резолвим промис.
function waitForBestmove(proc: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    const handler = (chunk: Buffer) => {
      const str = chunk.toString("utf8");
      if (str.includes("bestmove")) {
        proc.stdout.off("data", handler);
        resolve();
      }
    };
    proc.stdout.on("data", handler);
  });
}

// Значения по умолчанию для настроек движка
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

  /** Проверяем наличие и исполняемость бинарника Stockfish */
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

  /** Запускаем новый процесс Stockfish и запоминаем текущий */
  private spawnEngine(): ChildProcessWithoutNullStreams {
    const bin = path.resolve(ENGINE_PATH);
    const proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.currentProc = proc;
    proc.on("exit", (_code, _sig) => {
      if (this.currentProc === proc) this.currentProc = null;
    });
    proc.stderr.on("data", (b) => console.warn(`[UciEngine] stderr:`, String(b)));
    return proc;
  }

  /** Отправляем команду в stdin движка */
  private send(proc: ChildProcessWithoutNullStreams, cmd: string) {
    proc.stdin.write(cmd + "\n");
  }

  /**
   * Оценивает текущую позицию с поддержкой MultiPV. Возвращает объект PositionEval.
   * В отличие от первоначального варианта, здесь мы накапливаем все сообщения от
   * движка и используем parseEvaluationResults() для разбора оценок и лучшего хода.
   */
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
    const useNNUE = (params as any).useNNUE as boolean | undefined;
    const elo = Number((params as any).elo);

    const proc = this.spawnEngine();
    const results: string[] = [];
    let lastDepthReported = 0;

    // Слушаем stdout: сохраняем все строки и обновляем прогресс
    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const raw of text.split(/\r?\n/)) {
        const s = raw.trim();
        if (!s) continue;
        results.push(s);
        if (s.startsWith("info ")) {
          const m = parseInfoLineForProgress(s);
          if (m?.depth && onProgress && m.depth !== lastDepthReported) {
            lastDepthReported = m.depth;
            const pct = Math.max(0, Math.min(100, Math.round((m.depth / Math.max(1, depth)) * 100)));
            try {
              onProgress(pct);
            } catch {}
          }
        }
      }
    });

    // Настройка движка
    this.send(proc, "uci");
    this.send(proc, `setoption name Threads value ${threads}`);
    this.send(proc, `setoption name Hash value ${hashMb}`);
    this.send(proc, `setoption name MultiPV value ${multiPv}`);
    if (syzygyPath) this.send(proc, `setoption name SyzygyPath value ${syzygyPath}`);
    if (typeof useNNUE === "boolean") {
      this.send(proc, `setoption name Use NNUE value ${useNNUE ? "true" : "false"}`);
    }
    if (Number.isFinite(elo)) {
      this.send(proc, `setoption name UCI_LimitStrength value true`);
      this.send(proc, `setoption name UCI_Elo value ${elo}`);
    }
    this.send(proc, "isready");

    // Новый поиск
    this.send(proc, "ucinewgame");
    this.send(proc, `position fen ${fen}`);
    // MultiPV уже установлен, поэтому multipv не передаём в go
    this.send(proc, `go depth ${depth}`);

    // Ждём появления bestmove
    await waitForBestmove(proc);

    // Завершаем работу движка
    try {
      this.send(proc, "quit");
      proc.stdin.end();
    } catch {}
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, 150);

    // Разбираем результаты с помощью Chesskit парсера
    const parsed = parseEvaluationResults(results, fen);
    // parseEvaluationResults может инвертировать cp для хода чёрных
    return parsed;
  }

  /**
   * Оценка списка FEN — цикл по позициям. Аналогично Chesskit, но без воркеров.
   */
  async evaluateGame(params: EvaluateGameParams, onProgress?: (value: number) => void): Promise<GameEval> {
    const fens = Array.isArray(params.fens) ? params.fens : [];
    const depth = Number.isFinite(params.depth) ? Number(params.depth) : DEFAULT_DEPTH;
    const multiPv = Number.isFinite(params.multiPv) ? Number(params.multiPv) : DEFAULT_MULTIPV;

    const positions: PositionEval[] = [];
    const total = fens.length;
    for (let i = 0; i < total; i++) {
      const fen = String(fens[i] ?? "");
      const pe = await this.evaluatePositionWithUpdate({
        fen,
        depth,
        multiPv,
        // пробрасываем дополнительные поля
        ...params,
      });
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

  /** Получить лучший ход для данной позиции. */
  async getEngineNextMove(fen: string, _elo?: number, depth?: number): Promise<string> {
    const d = Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH;
    const res = await this.evaluatePositionWithUpdate({ fen, depth: d, multiPv: 1 });
    return String(res.bestMove ?? res.lines?.[0]?.pv?.[0] ?? "");
  }

  /** Остановить текущие задачи (stop), если процесс активен */
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

  /** Полностью завершить работу движка */
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