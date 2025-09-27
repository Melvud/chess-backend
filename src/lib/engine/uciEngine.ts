// src/lib/engine/uciEngine.ts
// Реализует UCI-движок через нативный бинарник Stockfish.
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
      // [LOG-VERBOSE] можно раскомментировать, если нужен «сырой» поток stdout:
      // console.debug(`[UciEngine] stdout(chunk):`, str.trim());
      if (str.includes("bestmove")) {
        console.info(`[UciEngine] observed bestmove in stdout`);
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
    console.info(`[UciEngine] create:start`, { engineName });
    eng.ensureBinary();
    console.info(`[UciEngine:create:native]`, { engineName, bin: ENGINE_PATH });
    console.info(`[UciEngine] create:ready`, { engineName });
    return eng;
  }

  /** Проверяем наличие и исполняемость бинарника Stockfish */
  private ensureBinary() {
    const bin = path.resolve(ENGINE_PATH);
    console.info(`[UciEngine] ensureBinary:check`, { bin });
    if (!fs.existsSync(bin)) {
      console.error(`[UciEngine] binary:notFound`, { bin });
      throw new Error(`Stockfish binary not found at ${bin}. Set ENGINE_PATH or STOCKFISH_PATH.`);
    }
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      console.info(`[UciEngine] ensureBinary:ok`, { bin });
    } catch {
      console.warn(`[UciEngine] binary:notExecutable`, { bin, hint: `chmod +x "${bin}"` });
    }
  }

  /** Запускаем новый процесс Stockfish и запоминаем текущий */
  private spawnEngine(): ChildProcessWithoutNullStreams {
    const bin = path.resolve(ENGINE_PATH);
    console.info(`[UciEngine] spawn:start`, { bin });
    const proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.currentProc = proc;
    console.info(`[UciEngine] spawn:ok`, { pid: proc.pid });
    proc.on("exit", (code, sig) => {
      console.info(`[UciEngine] proc:exit`, { pid: proc.pid, code, sig });
      if (this.currentProc === proc) this.currentProc = null;
    });
    proc.stderr.on("data", (b) => console.warn(`[UciEngine] stderr:`, String(b)));
    return proc;
  }

  /** Отправляем команду в stdin движка */
  private send(proc: ChildProcessWithoutNullStreams, cmd: string) {
    // Не логируем полные длинные команды FEN/UCIs для экономии логов
    const short =
      cmd.startsWith("position fen")
        ? `position fen <${cmd.length} chars>`
        : cmd;
    console.debug(`[UciEngine] >>`, short);
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

    console.info(`[UciEngine] evalPosition:start`, {
      depth, multiPv, threads, hashMb, useNNUE, elo: Number.isFinite(elo) ? elo : undefined,
      fenPreview: fen?.slice(0, 30)
    });

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

        // [LOG-VERBOSE] сырые info-строки:
        // if (s.startsWith("info ")) console.debug(`[UciEngine] info:`, s);

        if (s.startsWith("info ")) {
          const m = parseInfoLineForProgress(s);
          if (m?.depth && onProgress && m.depth !== lastDepthReported) {
            lastDepthReported = m.depth;
            const pct = Math.max(0, Math.min(100, Math.round((m.depth / Math.max(1, depth)) * 100)));
            try {
              onProgress(pct);
              if (pct % 10 === 0 || pct >= 95) {
                console.info(`[UciEngine] evalPosition:progress`, { depth: m.depth, pct });
              }
            } catch {}
          }
        } else if (s.startsWith("bestmove")) {
          console.info(`[UciEngine] bestmove:line`, { line: s });
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
    this.send(proc, `go depth ${depth}`);
    console.info(`[UciEngine] go:issued`, { depth });

    // Ждём появления bestmove
    await waitForBestmove(proc);
    console.info(`[UciEngine] evalPosition:bestmove:received`);

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
    console.info(`[UciEngine] evalPosition:done`, {
      gotLines: Array.isArray((parsed as any)?.lines) ? (parsed as any).lines.length : undefined,
      best: (parsed as any)?.bestMove ?? (parsed as any)?.lines?.[0]?.pv?.[0]
    });
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

    console.info(`[UciEngine] evalGame:start`, {
      positions: fens.length, depth, multiPv,
      workersNb: (params as any)?.workersNb,
      useNNUE: (params as any)?.useNNUE,
      elo: (params as any)?.elo
    });

    const positions: PositionEval[] = [];
    const total = fens.length;
    for (let i = 0; i < total; i++) {
      const fen = String(fens[i] ?? "");
      const moveNo = i; // позиция до i-го хода
      if (i === 0 || i === total - 1 || i % 10 === 0) {
        console.info(`[UciEngine] evalGame:pos:start`, { index: i, total, fenPreview: fen.slice(0, 30) });
      }
      const pe = await this.evaluatePositionWithUpdate({
        fen,
        depth,
        multiPv,
        // пробрасываем дополнительные поля
        ...params,
      }, undefined);
      positions.push(pe);
      if (onProgress) {
        const pct = Math.round(((i + 1) / Math.max(1, total)) * 100);
        try {
          onProgress(pct);
          if (pct % 10 === 0 || pct >= 95) {
            console.info(`[UciEngine] evalGame:progress`, { pct, done: i + 1, total });
          }
        } catch {}
      }
      if (i === 0 || i === total - 1 || i % 10 === 0) {
        console.info(`[UciEngine] evalGame:pos:done`, {
          index: i,
          best: (pe as any)?.bestMove ?? (pe as any)?.lines?.[0]?.pv?.[0],
          lines: Array.isArray((pe as any)?.lines) ? (pe as any).lines.length : undefined
        });
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

    console.info(`[UciEngine] evalGame:done`, {
      positions: positions.length,
      depth,
      multiPv,
    });

    return out;
  }

  /** Получить лучший ход для данной позиции. */
  async getEngineNextMove(fen: string, _elo?: number, depth?: number): Promise<string> {
    const d = Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH;
    console.info(`[UciEngine] getBestMove:start`, { depth: d, fenPreview: fen.slice(0, 30) });
    const res = await this.evaluatePositionWithUpdate({ fen, depth: d, multiPv: 1 });
    const best = String(res.bestMove ?? res.lines?.[0]?.pv?.[0] ?? "");
    console.info(`[UciEngine] getBestMove:done`, { best });
    return best;
  }

  /** Остановить текущие задачи (stop), если процесс активен */
  async stopAllCurrentJobs(): Promise<void> {
    const p = this.currentProc;
    if (!p) return;
    console.info(`[UciEngine] stopAllCurrentJobs:send stop`, { pid: p.pid });
    try {
      p.stdin.write("stop\n");
    } catch {}
    setTimeout(() => {
      try {
        console.info(`[UciEngine] stopAllCurrentJobs:kill`, { pid: p.pid });
        p.kill("SIGKILL");
      } catch {}
    }, 100);
    this.currentProc = null;
  }

  /** Полностью завершить работу движка */
  shutdown() {
    const p = this.currentProc;
    if (p) {
      console.info(`[UciEngine] shutdown`, { pid: p.pid });
      try {
        p.stdin.end("quit\n");
      } catch {}
      try {
        p.kill("SIGKILL");
      } catch {}
      this.currentProc = null;
    } else {
      console.info(`[UciEngine] shutdown:no_proc`);
    }
  }
}
