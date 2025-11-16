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

// ────────────────────────────────────────────────────────────────────
// Вспомогательные типы и функции
// ────────────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────────
// Значения по умолчанию для настроек движка
// ────────────────────────────────────────────────────────────────────

const ENGINE_PATH_ENV =
  process.env.STOCKFISH_PATH || process.env.STOCKFISH_BIN || "./bin/stockfish";
const ENGINE_PATH = resolveEnginePath(ENGINE_PATH_ENV);

const DEFAULT_DEPTH = Number.isFinite(Number(process.env.ENGINE_DEPTH))
  ? Number(process.env.ENGINE_DEPTH)
  : 16;
const DEFAULT_MULTIPV = Number.isFinite(Number(process.env.ENGINE_MULTIPV))
  ? Number(process.env.ENGINE_MULTIPV)
  : 3;
// по умолчанию стараемся занять все ядра (оставлять ядро системе можно с -1, но тут оставим как есть)
const CPU_COUNT = Math.max(1, os.cpus()?.length ?? 1);
const DEFAULT_THREADS = Math.max(1, CPU_COUNT);
const DEFAULT_HASH_MB = Number.isFinite(Number(process.env.ENGINE_HASH_MB))
  ? Number(process.env.ENGINE_HASH_MB)
  : 256;

// «настоящий» уровень навыка Stockfish
const SKILL_LEVEL_MIN = 0;
const SKILL_LEVEL_MAX = 20;

// ────────────────────────────────────────────────────────────────────
// Вспомогательное: резолв бинарника под win/*nix
// ────────────────────────────────────────────────────────────────────

function resolveEnginePath(p: string): string {
  let bin = path.resolve(p);
  if (process.platform === "win32" && !bin.toLowerCase().endsWith(".exe")) {
    const withExe = `${bin}.exe`;
    if (fs.existsSync(withExe)) bin = withExe;
  }
  return bin;
}

export class UciEngine {
  private currentProc: ChildProcessWithoutNullStreams | null = null;

  private constructor() {
  }

  /** Фабрика — создаёт UciEngine с использованием нативного бинарника. */
  static async create(_engineName: EngineName, _enginePublicPath: string): Promise<UciEngine> {
    const eng = new UciEngine();
    eng.ensureBinary();
    return eng;
  }

  /** Проверяем наличие и исполняемость бинарника Stockfish */
  private ensureBinary() {
    const bin = ENGINE_PATH;
    if (!fs.existsSync(bin)) {
      throw new Error(`Stockfish binary not found at ${bin}. Set STOCKFISH_PATH / STOCKFISH_BIN.`);
    }
    try {
      fs.accessSync(bin, fs.constants.X_OK);
    } catch {
      // На некоторых FS X_OK может «падать», но бинарь запускается; оставляем мягко.
    }
  }

  /** Запускаем новый процесс Stockfish и запоминаем текущий */
  private spawnEngine(): ChildProcessWithoutNullStreams {
    const bin = ENGINE_PATH;
    const proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.currentProc = proc;
    proc.on("exit", () => {
      if (this.currentProc === proc) this.currentProc = null;
    });
    // лишний stderr не сыпем в логи
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
      /** «Настоящий» уровень сложности Stockfish 0..20; при наличии имеет приоритет над elo */
      skillLevel?: number;
    },
  ): Promise<void> {
    const threads = Math.max(1, Number.isFinite(opts.threads!) ? Number(opts.threads) : DEFAULT_THREADS);
    const hashMb = Math.max(16, Number.isFinite(opts.hashMb!) ? Number(opts.hashMb) : DEFAULT_HASH_MB);
    const multiPv = Math.max(1, Number.isFinite(opts.multiPv!) ? Number(opts.multiPv) : DEFAULT_MULTIPV);
    const useNNUE = typeof opts.useNNUE === "boolean" ? opts.useNNUE : undefined;
    const elo = Number(opts.elo);
    const hasElo = Number.isFinite(elo);
    const skill = clampToSkill(opts.skillLevel);

    this.send(proc, "uci");
    this.send(proc, `setoption name Threads value ${threads}`);
    this.send(proc, `setoption name Hash value ${hashMb}`);
    this.send(proc, `setoption name MultiPV value ${multiPv}`);
    if (opts.syzygyPath) this.send(proc, `setoption name SyzygyPath value ${opts.syzygyPath}`);
    if (typeof useNNUE === "boolean") {
      // у разных сборок название опции NNUE отличается; самая совместимая — Use NNUE
      this.send(proc, `setoption name Use NNUE value ${useNNUE ? "true" : "false"}`);
    }

    // Приоритет: skillLevel (0..20) — это «нативный» уровень Stockfish.
    if (typeof skill === "number") {
      // Если используем Skill Level, не ограничиваем по UCI_Elo
      this.send(proc, `setoption name UCI_LimitStrength value false`);
      this.send(proc, `setoption name Skill Level value ${skill}`);
    } else if (hasElo) {
      // Иначе — ограничиваем по UCI_Elo (старое поведение)
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
    onDepth?: (d: number, pct: number) => void,
  ): Promise<PositionEval> {
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
    const skillLevel = clampToSkill((params as any).skillLevel);

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

    // Настройка движка (skillLevel имеет приоритет над elo)
    await this.initSession(proc, { threads, hashMb, multiPv, syzygyPath, useNNUE, elo, skillLevel });

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
   * Оценка списка FEN — в рамках **одного процесса** (теплый кэш TT).
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
      skillLevel: clampToSkill((params as any)?.skillLevel),
    });

    const positions: PositionEval[] = [];
    const total = fens.length;

    for (let i = 0; i < total; i++) {
      const fen = String(fens[i] ?? "");

      // Внутри сессии не зовём ucinewgame (сохраняем TT)
      const pe = await this.evaluateFenOnSession(
        proc,
        fen,
        depth,
        undefined, // глубинный прогресс внутри партии не транслируем наружу
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
    const res = await this.evaluatePositionWithUpdate({ fen, depth: d, multiPv: 1 } as any);
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

// ────────────────────────────────────────────────────────────────────
// Внутренние утилиты
// ────────────────────────────────────────────────────────────────────

function clampToSkill(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  const clamped = Math.max(SKILL_LEVEL_MIN, Math.min(SKILL_LEVEL_MAX, Math.round(n)));
  return clamped;
}
