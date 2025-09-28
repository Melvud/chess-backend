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
      if (str.includes("bestmove")) {
        // console.info(`[UciEngine] observed bestmove in stdout`);
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
// по умолчанию стараемся занять все ядра, но оставим одно ядро системе
const DEFAULT_THREADS = Math.max(1, Math.min(os.cpus()?.length ?? 2, (os.cpus()?.length ?? 2) - 0));
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
    // console.info(`[UciEngine] create:start`, { engineName });
    eng.ensureBinary();
    // console.info(`[UciEngine:create:native]`, { engineName, bin: ENGINE_PATH });
    // console.info(`[UciEngine] create:ready`, { engineName });
    return eng;
  }

  /** Проверяем наличие и исполняемость бинарника Stockfish */
  private ensureBinary() {
    const bin = path.resolve(ENGINE_PATH);
    // console.info(`[UciEngine] ensureBinary:check`, { bin });
    if (!fs.existsSync(bin)) {
      // console.error(`[UciEngine] binary:notFound`, { bin });
      throw new Error(`Stockfish binary not found at ${bin}. Set ENGINE_PATH or STOCKFISH_PATH.`);
    }
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      // console.info(`[UciEngine] ensureBinary:ok`, { bin });
    } catch {
      // console.warn(`[UciEngine] binary:notExecutable`, { bin, hint: `chmod +x "${bin}"` });
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
    // перенапряжённый stderr не нужен в прод-логах:
    proc.stderr.on("data", () => {});
    return proc;
  }

  /** Отправляем команду в stdin движка */
  private send(proc: ChildProcessWithoutNullStreams, cmd: string) {
    proc.stdin.write(cmd + "\n");
  }

  // ---------- ВНУТРЕННИЕ ПОМОЩНИКИ ДЛЯ СЕССИИ ОДНОГО ПРОЦЕССА ----------

  /** Инициализация процесса и общих опций (вызывается один раз на сессию) */
  private async initSession(
    proc: ChildProcessWithoutNullStreams,
    opts: {
      threads?: number;
      hashMb?: number;
      multiPv?: number;
      syzygyPath?: string;
      useNNUE?: boolean;
      elo?: number;
    },
  ): Promise<void> {
    const threads = Math.max(1, Number.isFinite(opts.threads!) ? Number(opts.threads) : DEFAULT_THREADS);
    const hashMb = Math.max(16, Number.isFinite(opts.hashMb!) ? Number(opts.hashMb) : DEFAULT_HASH_MB);
    const multiPv = Math.max(1, Number.isFinite(opts.multiPv!) ? Number(opts.multiPv) : DEFAULT_MULTIPV);
    const useNNUE = typeof opts.useNNUE === "boolean" ? opts.useNNUE : undefined;
    const elo = Number(opts.elo);

    this.send(proc, "uci");
    this.send(proc, `setoption name Threads value ${threads}`);
    this.send(proc, `setoption name Hash value ${hashMb}`);
    this.send(proc, `setoption name MultiPV value ${multiPv}`);
    if (opts.syzygyPath) this.send(proc, `setoption name SyzygyPath value ${opts.syzygyPath}`);
    if (typeof useNNUE === "boolean") {
      // у разных сборок название опции NNUE отличается; самая совместимая — Use NNUE
      this.send(proc, `setoption name Use NNUE value ${useNNUE ? "true" : "false"}`);
    }
    if (Number.isFinite(elo)) {
      this.send(proc, `setoption name UCI_LimitStrength value true`);
      this.send(proc, `setoption name UCI_Elo value ${elo}`);
    }
    this.send(proc, "isready");
    this.send(proc, "ucinewgame"); // старт новой партии
  }

  /** Оценка одной позиции в рамках уже инициализированной сессии */
  private async evaluateFenOnSession(
    proc: ChildProcessWithoutNullStreams,
    fen: string,
    depth: number,
    multiPv: number,
    onDepth?: (d: number, pct: number) => void,
  ): Promise<PositionEval> {
    // собираем только свои строки этой позиции
    const lines: string[] = [];
    let lastReportDepth = 0;

    const onStdout = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const raw of text.split(/\r?\n/)) {
        const s = raw.trim();
        if (!s) continue;
        lines.push(s);
        if (s.startsWith("info ")) {
          const m = parseInfoLineForProgress(s);
          if (m?.depth && onDepth && m.depth !== lastReportDepth) {
            lastReportDepth = m.depth;
            const pct = Math.max(0, Math.min(100, Math.round((m.depth / Math.max(1, depth)) * 100)));
            onDepth(m.depth, pct);
          }
        }
      }
    };

    proc.stdout.on("data", onStdout);

    // Устанавливаем позицию и запускаем поиск
    this.send(proc, `position fen ${fen}`);
    this.send(proc, `go depth ${depth}`);

    // ждём bestmove — конец поиска по этой позиции
    await waitForBestmove(proc);

    // снимаем обработчик и парсим накопленное
    proc.stdout.off("data", onStdout);
    const parsed = parseEvaluationResults(lines, fen);
    return parsed;
  }

  // ------------------- ПУБЛИЧНЫЕ МЕТОДЫ -------------------

  /**
   * Оценивает текущую позицию с поддержкой MultiPV. Возвращает объект PositionEval.
   * Для единичных вызовов — отдельный процесс (изолированная, «короткоживущая» сессия).
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

    // Сбор stdout и прогресс
    const results: string[] = [];
    let lastDepthReported = 0;
    const onStdout = (chunk: Buffer) => {
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
            try { onProgress(pct); } catch {}
          }
        }
      }
    };
    proc.stdout.on("data", onStdout);

    // Настройка движка
    await this.initSession(proc, { threads, hashMb, multiPv, syzygyPath, useNNUE, elo });

    // Новый поиск — отдельная позиция
    this.send(proc, `position fen ${fen}`);
    this.send(proc, `go depth ${depth}`);

    // Ждём появления bestmove
    await waitForBestmove(proc);

    // Завершаем работу движка
    try { this.send(proc, "quit"); proc.stdin.end(); } catch {}
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 150);

    proc.stdout.off("data", onStdout);

    // Разбираем результаты
    const parsed = parseEvaluationResults(results, fen);
    return parsed;
  }

  /**
   * Оценка списка FEN — теперь в рамках **одного процесса**.
   * Это значительно сокращает накладные расходы и позволяет использовать
   * тёплый кэш (TT) между позициями одной партии.
   */
  async evaluateGame(params: EvaluateGameParams, onProgress?: (value: number) => void): Promise<GameEval> {
    const fens = Array.isArray(params.fens) ? params.fens : [];
    const depth = Number.isFinite(params.depth) ? Number(params.depth) : DEFAULT_DEPTH;
    const multiPv = Number.isFinite(params.multiPv) ? Number(params.multiPv) : DEFAULT_MULTIPV;

    // Старт одной «сессии» движка на всю партию
    const proc = this.spawnEngine();
    await this.initSession(proc, {
      threads: (params as any)?.threads ?? DEFAULT_THREADS,
      hashMb: (params as any)?.hashMb ?? DEFAULT_HASH_MB,
      multiPv,
      syzygyPath: (params as any)?.syzygyPath,
      useNNUE: (params as any)?.useNNUE,
      elo: (params as any)?.elo,
    });

    const positions: PositionEval[] = [];
    const total = fens.length;

    for (let i = 0; i < total; i++) {
      const fen = String(fens[i] ?? "");

      // Внутри сессии не зовём ucinewgame (сохраняем TT), просто меняем позицию
      const pe = await this.evaluateFenOnSession(
        proc,
        fen,
        depth,
        multiPv,
        undefined, // глубинный прогресс по одной позиции внутри партии не транслируем наружу
      );
      positions.push(pe);

      if (onProgress) {
        const pct = Math.round(((i + 1) / Math.max(1, total)) * 100);
        try { onProgress(pct); } catch {}
      }
    }

    // Закрываем процесс после окончания партии
    try { this.send(proc, "quit"); proc.stdin.end(); } catch {}
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 150);

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
    const best = String(res.bestMove ?? res.lines?.[0]?.pv?.[0] ?? "");
    return best;
  }

  /** Остановить текущие задачи (stop), если процесс активен */
  async stopAllCurrentJobs(): Promise<void> {
    const p = this.currentProc;
    if (!p) return;
    try { p.stdin.write("stop\n"); } catch {}
    setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 100);
    this.currentProc = null;
  }

  /** Полностью завершить работу движка */
  shutdown() {
    const p = this.currentProc;
    if (p) {
      try { p.stdin.end("quit\n"); } catch {}
      try { p.kill("SIGKILL"); } catch {}
      this.currentProc = null;
    }
  }
}
