// src/lib/engine/uciEngine.ts
// Реализует UCI-движок через нативный бинарник Stockfish.
// ОПТИМИЗИРОВАНО для 8 vCPU и 8 GB RAM

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

// Парсим строку info для обновления прогресса
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

// Асинхронно ждём появления bestmove в stdout движка
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
// Значения по умолчанию для настроек движка (ОПТИМИЗИРОВАНО для 8 vCPU)
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

// ✅ ОПТИМИЗАЦИЯ: Используем все 8 ядер
const CPU_COUNT = Math.max(1, os.cpus()?.length ?? 1);
const DEFAULT_THREADS = Math.min(8, CPU_COUNT); // Максимум 8 потоков

// ✅ ОПТИМИЗАЦИЯ: Увеличиваем Hash до 2 GB для 8 GB RAM (оставляем запас системе)
const DEFAULT_HASH_MB = Number.isFinite(Number(process.env.ENGINE_HASH_MB))
  ? Number(process.env.ENGINE_HASH_MB)
  : 2048; // 2 GB Hash Table

// Уровень навыка Stockfish
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
  private keepAlive: boolean = false;
  private sessionProc: ChildProcessWithoutNullStreams | null = null;
  private sessionInitialized: boolean = false;
  private sessionParams: any = null;

  private constructor(keepAlive: boolean = false) {
    this.keepAlive = keepAlive;
  }

  /** Фабрика — создаёт UciEngine с использованием нативного бинарника. */
  static async create(_engineName: EngineName, _enginePublicPath: string, keepAlive: boolean = false): Promise<UciEngine> {
    const eng = new UciEngine(keepAlive);
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

  /** Запускаем новый процесс Stockfish */
  private spawnEngine(): ChildProcessWithoutNullStreams {
    const bin = ENGINE_PATH;
    const proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.currentProc = proc;
    proc.on("exit", () => {
      if (this.currentProc === proc) this.currentProc = null;
    });
    // Игнорируем stderr
    proc.stderr.on("data", () => {});
    return proc;
  }

  /** Отправляем команду в stdin движка */
  private send(proc: ChildProcessWithoutNullStreams, cmd: string) {
    proc.stdin.write(cmd + "\n");
  }

  /**
   * ✅ КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Получить или создать долгоживущий процесс для сессии
   * Это устраняет задержку 10-15 секунд при каждом анализе!
   */
  private async getOrCreateSessionProc(opts: {
    threads?: number;
    hashMb?: number;
    multiPv?: number;
    syzygyPath?: string;
    useNNUE?: boolean;
    elo?: number;
    skillLevel?: number;
  }): Promise<ChildProcessWithoutNullStreams> {
    // Проверяем, можно ли переиспользовать существующий процесс
    const paramsMatch = this.sessionInitialized &&
      this.sessionProc &&
      !this.sessionProc.killed &&
      JSON.stringify(this.sessionParams) === JSON.stringify(opts);

    if (paramsMatch) {
      // ✅ Переиспользуем существующий процесс (устраняет задержку!)
      return this.sessionProc!;
    }

    // Закрываем старый процесс если параметры изменились
    if (this.sessionProc && !this.sessionProc.killed) {
      try {
        this.send(this.sessionProc, "quit");
        this.sessionProc.stdin.end();
      } catch {}
      setTimeout(() => {
        try { this.sessionProc?.kill("SIGKILL"); } catch {}
      }, 100);
    }

    // Создаем новый процесс и инициализируем его
    const proc = this.spawnEngine();
    await this.initSession(proc, opts);

    // Сохраняем для переиспользования
    this.sessionProc = proc;
    this.sessionInitialized = true;
    this.sessionParams = { ...opts };

    return proc;
  }

  // ---------- ВНУТРЕННИЕ ПОМОЩНИКИ ДЛЯ СЕССИИ ОДНОГО ПРОЦЕССА ----------

  /** Инициализация процесса и общих опций */
  private async initSession(
    proc: ChildProcessWithoutNullStreams,
    opts: {
      threads?: number;
      hashMb?: number;
      multiPv?: number;
      syzygyPath?: string;
      useNNUE?: boolean;
      elo?: number;
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
    
    // ✅ ОПТИМИЗАЦИЯ: Отключаем Ponder для быстрого анализа
    this.send(proc, "setoption name Ponder value false");
    
    if (opts.syzygyPath) this.send(proc, `setoption name SyzygyPath value ${opts.syzygyPath}`);
    if (typeof useNNUE === "boolean") {
      this.send(proc, `setoption name Use NNUE value ${useNNUE ? "true" : "false"}`);
    }

    // Приоритет: skillLevel (0..20) — это «нативный» уровень Stockfish
    if (typeof skill === "number") {
      this.send(proc, `setoption name UCI_LimitStrength value false`);
      this.send(proc, `setoption name Skill Level value ${skill}`);
    } else if (hasElo) {
      this.send(proc, `setoption name UCI_LimitStrength value true`);
      this.send(proc, `setoption name UCI_Elo value ${elo}`);
    }

    this.send(proc, "isready");
    
    // ✅ Ждем готовности движка
    await new Promise<void>((resolve) => {
      const handler = (chunk: Buffer) => {
        if (chunk.toString("utf8").includes("readyok")) {
          proc.stdout.off("data", handler);
          resolve();
        }
      };
      proc.stdout.on("data", handler);
    });
    
    this.send(proc, "ucinewgame");
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

    // Ждём bestmove
    await waitForBestmove(proc);

    // Снимаем обработчик и парсим накопленное
    proc.stdout.off("data", onStdout);
    const parsed = parseEvaluationResults(lines, fen);
    return parsed;
  }

  // ------------------- ПУБЛИЧНЫЕ МЕТОДЫ -------------------

  /**
   * Оценивает текущую позицию с поддержкой MultiPV
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

    // Настройка движка
    await this.initSession(proc, { threads, hashMb, multiPv, syzygyPath, useNNUE, elo, skillLevel });

    // Новый поиск
    this.send(proc, `position fen ${fen}`);
    this.send(proc, `go depth ${depth}`);

    // Ждём bestmove
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
   * ✅ ИСПРАВЛЕНО: Оценка списка FEN с поддержкой прогресса глубины
   * ✅ КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Переиспользуем процесс если keepAlive = true
   */
  async evaluateGame(params: EvaluateGameParams, onProgress?: (value: number) => void): Promise<GameEval> {
    const fens = Array.isArray(params.fens) ? params.fens : [];
    const depth = Number.isFinite(params.depth) ? Number(params.depth) : DEFAULT_DEPTH;
    const multiPv = Number.isFinite(params.multiPv) ? Number(params.multiPv) : DEFAULT_MULTIPV;

    const sessionOpts = {
      threads: (params as any)?.threads ?? DEFAULT_THREADS,
      hashMb: (params as any)?.hashMb ?? DEFAULT_HASH_MB,
      multiPv,
      syzygyPath: (params as any)?.syzygyPath,
      useNNUE: (params as any)?.useNNUE,
      elo: (params as any)?.elo,
      skillLevel: clampToSkill((params as any)?.skillLevel),
    };

    // ✅ КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Используем долгоживущий процесс если keepAlive = true
    // Это устраняет задержку 10-15 секунд при каждом анализе!
    let proc: ChildProcessWithoutNullStreams;
    if (this.keepAlive) {
      proc = await this.getOrCreateSessionProc(sessionOpts);
    } else {
      proc = this.spawnEngine();
      await this.initSession(proc, sessionOpts);
    }

    const positions: PositionEval[] = [];
    const total = fens.length;

    for (let i = 0; i < total; i++) {
      const fen = String(fens[i] ?? "");

      // ✅ ИСПРАВЛЕНИЕ: Передаем прогресс глубины
      const pe = await this.evaluateFenOnSession(
        proc,
        fen,
        depth,
        (_d, depthPct) => {
          if (onProgress) {
            // Комбинированный прогресс: позиция + глубина внутри позиции
            const posProgress = (i / total) * 100;
            const depthContribution = (depthPct / total);
            const combined = Math.min(100, posProgress + depthContribution);
            try { onProgress(combined); } catch {}
          }
        },
      );
      positions.push(pe);

      // ✅ Финальное обновление после завершения позиции
      if (onProgress) {
        const pct = Math.round(((i + 1) / Math.max(1, total)) * 100);
        try { onProgress(pct); } catch {}
      }
    }

    // ✅ КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Не закрываем процесс если keepAlive = true
    // Это позволяет переиспользовать процесс для следующих анализов (устраняет задержку!)
    if (!this.keepAlive) {
      try { this.send(proc, "quit"); proc.stdin.end(); } catch {}
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 150);
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

  /** Получить лучший ход для данной позиции */
  async getEngineNextMove(fen: string, _elo?: number, depth?: number): Promise<string> {
    const d = Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH;
    const res = await this.evaluatePositionWithUpdate({ fen, depth: d, multiPv: 1 } as any);
    const best = String(res.bestMove ?? res.lines?.[0]?.pv?.[0] ?? "");
    return best;
  }

  /** Остановить текущие задачи */
  async stopAllCurrentJobs(): Promise<void> {
    const p = this.currentProc;
    if (!p) return;
    try { p.stdin.write("stop\n"); } catch {}
    setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 100);
    this.currentProc = null;
  }

  /**
   * ✅ ИСПРАВЛЕНО: Полностью завершить работу движка
   * Безопасное закрытие без ошибок "write after end"
   * ✅ КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Также закрываем сессионный процесс
   */
  shutdown() {
    // Закрываем текущий процесс
    const p = this.currentProc;
    if (p) {
      try {
        // ✅ Проверяем что процесс еще жив и stdin доступен
        if (!p.killed && p.stdin && p.stdin.writable) {
          p.stdin.write("quit\n");
          p.stdin.end();
        }
      } catch (e) {
        // Игнорируем ошибки при закрытии stdin
      }

      try {
        if (!p.killed) {
          p.kill("SIGTERM"); // Сначала мягкое завершение
          setTimeout(() => {
            if (!p.killed) p.kill("SIGKILL");
          }, 100);
        }
      } catch (e) {
        // Игнорируем ошибки при kill
      }

      this.currentProc = null;
    }

    // ✅ КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Закрываем сессионный процесс
    const sp = this.sessionProc;
    if (sp) {
      try {
        if (!sp.killed && sp.stdin && sp.stdin.writable) {
          sp.stdin.write("quit\n");
          sp.stdin.end();
        }
      } catch (e) {
        // Игнорируем ошибки при закрытии stdin
      }

      try {
        if (!sp.killed) {
          sp.kill("SIGTERM");
          setTimeout(() => {
            if (!sp.killed) sp.kill("SIGKILL");
          }, 100);
        }
      } catch (e) {
        // Игнорируем ошибки при kill
      }

      this.sessionProc = null;
      this.sessionInitialized = false;
      this.sessionParams = null;
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