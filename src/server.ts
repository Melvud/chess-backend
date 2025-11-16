// src/server.ts
// Сервер для анализа шахматных партий с использованием нативного Stockfish.
// СИНХРОНИЗИРОВАНО с LocalGameAnalyzer.kt

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import os from "node:os";
import pino from "pino";
import pinoHttp from "pino-http";
import { Chess } from "chess.js";

import { EngineName, MoveClassification } from "@/types/enums";
import type {
  GameEval,
  EvaluateGameParams,
  EvaluatePositionWithUpdateParams,
  PositionEval,
} from "@/types/eval";

import { computeEstimatedElo } from "@/lib/engine/helpers/estimateElo";
import { getMovesClassification } from "@/lib/engine/helpers/moveClassification";
import { getPositionWinPercentage } from "@/lib/engine/helpers/winPercentage";

import {
  ceilsNumber,
  getHarmonicMean,
  getStandardDeviation,
  getWeightedMean,
} from "@/lib/math";

import { UciEngine } from "@/lib/engine/uciEngine";

// -------------------- ENV --------------------
const PORT = Number(process.env.PORT ?? 8080);
const ENGINE_NAME: EngineName =
  (process.env.ENGINE_NAME as EngineName) ?? EngineName.Stockfish17Lite;
const DEFAULT_DEPTH = Number(process.env.ENGINE_DEPTH ?? 16);
const DEFAULT_MULTIPV = Number(process.env.ENGINE_MULTIPV ?? 3);

const CPU_CORES = Math.max(1, os.cpus()?.length ?? 1);
const ENGINE_THREADS = Math.max(
  1,
  Number(process.env.ENGINE_THREADS ?? CPU_CORES),
);
const ENGINE_HASH_MB = Math.max(16, Number(process.env.ENGINE_HASH_MB ?? 256));
const ENGINE_WORKERS_MAX = Math.max(
  1,
  Number(process.env.ENGINE_WORKERS_MAX ?? CPU_CORES),
);
const ENGINE_MAX_CONCURRENT_JOBS = Math.max(
  1,
  Number(process.env.ENGINE_MAX_CONCURRENT_JOBS ?? Math.ceil(CPU_CORES / 2)),
);

// -------------------- Server --------------------
const app = express();
const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

app.use(
  cors({
    origin: (_o, cb) => cb(null, true),
    credentials: true,
  }),
);
app.use(express.json({ limit: "10mb" }));
app.use(
  pinoHttp({
    logger: log,
    customProps: () => ({ srv: "chess-backend" }),
  }),
);

const publicDir = path.join(process.cwd(), "public");
app.use("/engines", express.static(path.join(publicDir, "engines")));

// -------------------- Progress --------------------
type ProgressStage =
  | "queued"
  | "preparing"
  | "evaluating"
  | "postprocess"
  | "done";
type Progress = {
  id: string;
  total: number;
  done: number;
  percent?: number;
  stage?: ProgressStage;
  startedAt?: number;
  updatedAt?: number;
};
const PROGRESS = new Map<string, Progress>();

function initProgress(id: string, total: number) {
  const now = Date.now();
  PROGRESS.set(id, {
    id,
    total,
    done: 0,
    percent: 0,
    stage: "preparing",
    startedAt: now,
    updatedAt: now,
  });
}

function setProgress(id: string, upd: Partial<Progress>) {
  const prev = PROGRESS.get(id);
  if (!prev) return;
  const now = Date.now();
  const next: Progress = { ...prev, ...upd, updatedAt: now };
  if (next.total > 0) {
    next.percent = Math.max(0, Math.min(100, (next.done / next.total) * 100));
  }
  PROGRESS.set(id, next);
}

// -------------------- Types (matching LocalGameAnalyzer.kt) --------------------
interface ClientLine {
  pv: string[];
  cp?: number;
  mate?: number;
  best?: string;
}

interface ClientPosition {
  fen: string;
  idx: number;
  lines: ClientLine[];
}

interface MoveReport {
  san: string;
  uci: string;
  beforeFen: string;
  afterFen: string;
  winBefore: number;
  winAfter: number;
  accuracy: number;
  classification: string;
  tags: string[];
}

interface Accuracy {
  white: number;
  black: number;
}

interface ACPL {
  white: number;
  black: number;
}

interface EstimatedElo {
  white: number | null;
  black: number | null;
}

interface AnalysisSettings {
  engine: string;
  depth: number;
  multiPv: number;
}

interface GameAnalysis {
  positions: ClientPosition[];
  moves: MoveReport[];
  accuracy: Accuracy;
  acpl: ACPL;
  estimatedElo: EstimatedElo | null;
  settings: AnalysisSettings;
}

// -------------------- helpers: ratings normalization --------------------
type PlayersRatings = { white?: number; black?: number };

function normalizePlayersRatings(src: any): PlayersRatings | undefined {
  if (!src || typeof src !== "object") return undefined;
  const pr =
    src.playersRatings && typeof src.playersRatings === "object"
      ? src.playersRatings
      : src;
  const w =
    Number.isFinite(pr.white)
      ? Number(pr.white)
      : Number.isFinite(pr.whiteElo)
      ? Number(pr.whiteElo)
      : Number.isFinite(pr?.white?.elo)
      ? Number(pr.white.elo)
      : Number.isFinite(src.whiteElo)
      ? Number(src.whiteElo)
      : Number.isFinite(src?.white?.elo)
      ? Number(src.white.elo)
      : undefined;
  const b =
    Number.isFinite(pr.black)
      ? Number(pr.black)
      : Number.isFinite(pr.blackElo)
      ? Number(pr.blackElo)
      : Number.isFinite(pr?.black?.elo)
      ? Number(pr.black.elo)
      : Number.isFinite(src.blackElo)
      ? Number(src.blackElo)
      : Number.isFinite(src?.black?.elo)
      ? Number(src.black.elo)
      : undefined;
  if (typeof w === "number" || typeof b === "number") {
    return { white: w, black: b };
  }
  return undefined;
}

// -------------------- Engine process helpers --------------------
type EngineIface = {
  evaluatePositionWithUpdate: (
    p: EvaluatePositionWithUpdateParams
  ) => Promise<{ lines: any[]; bestMove?: string }>;
  evaluateGame: (
    p: EvaluateGameParams,
    onProgress?: (p: number) => void,
  ) => Promise<GameEval>;
};

let singletonEngine: EngineIface | null = null;

async function createEngineInstance(opts?: {
  threads?: number;
  hashMb?: number;
  multiPv?: number;
}): Promise<EngineIface> {
  const eng = await UciEngine.create(ENGINE_NAME, "");
  try {
    const threads = Math.max(1, Math.floor(opts?.threads ?? ENGINE_THREADS));
    const hashMb = Math.max(16, Math.floor(opts?.hashMb ?? ENGINE_HASH_MB));
    const multiPv = Math.max(1, Math.floor(opts?.multiPv ?? DEFAULT_MULTIPV));
    if (typeof (eng as any).setOption === "function") {
      await (eng as any).setOption("Threads", threads);
      await (eng as any).setOption("Hash", hashMb);
      await (eng as any).setOption("Ponder", false);
      await (eng as any).setOption("MultiPV", multiPv);
    }
  } catch {}
  return eng;
}

async function getSingletonEngine(): Promise<EngineIface> {
  if (singletonEngine) return singletonEngine;
  singletonEngine = await createEngineInstance({
    threads: ENGINE_THREADS,
    hashMb: ENGINE_HASH_MB,
    multiPv: DEFAULT_MULTIPV,
  });
  return singletonEngine;
}

// -------------------- Async queue --------------------
class AsyncQueue {
  private concurrency: number;
  private running = 0;
  private q: Array<() => void> = [];

  constructor(concurrency: number) {
    this.concurrency = Math.max(1, concurrency);
  }

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.running++;
        task()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            this.running--;
            const next = this.q.shift();
            if (next) next();
          });
      };
      if (this.running < this.concurrency) run();
      else this.q.push(run);
    });
  }
}

const jobQueue = new AsyncQueue(ENGINE_MAX_CONCURRENT_JOBS);

// -------------------- Parallel evaluation --------------------
async function evaluateGameParallel(
  baseParams: EvaluateGameParams,
  workersRequested: number,
  onProgress?: (p: number) => void,
): Promise<GameEval> {
  const fens = baseParams.fens ?? [];
  const total = fens.length;

  const requested = Number(workersRequested);
  const workers =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.max(1, Math.floor(requested)), ENGINE_WORKERS_MAX)
      : ENGINE_WORKERS_MAX;

  if (workers === 1 || total <= 2) {
    const eng = await getSingletonEngine();
    return eng.evaluateGame(baseParams, onProgress);
  }

  const threadsPer = Math.max(1, Math.floor(ENGINE_THREADS / workers));
  const hashPer = Math.max(16, Math.floor(ENGINE_HASH_MB / workers));
  const multiPvPer = baseParams.multiPv ?? DEFAULT_MULTIPV;

  const indexes: number[][] = Array.from({ length: workers }, () => []);
  for (let i = 0; i < total; i++) indexes[i % workers].push(i);

  const perWorkerDone = new Array(workers).fill(0);
  const reportProgress = () => {
    if (!onProgress) return;
    const done = perWorkerDone.reduce((a, b) => a + b, 0);
    onProgress(Math.min(100, (done / Math.max(1, total)) * 100));
  };

  const tasks = indexes.map(async (idxs, wi) => {
    if (idxs.length === 0) return { positions: [], settings: {} } as any as GameEval;

    const shardFens = idxs.map((i) => baseParams.fens![i]);
    const shardUci = idxs.map((i) => baseParams.uciMoves![i]);

    const eng = await createEngineInstance({
      threads: threadsPer,
      hashMb: hashPer,
      multiPv: multiPvPer,
    });

    const onShardProgress = (p: number) => {
      const shardDone = Math.round((p / 100) * shardFens.length);
      const delta = Math.max(0, shardDone - perWorkerDone[wi]);
      if (delta > 0) {
        perWorkerDone[wi] += delta;
        reportProgress();
      }
    };

    const out = await eng.evaluateGame(
      { ...baseParams, fens: shardFens, uciMoves: shardUci },
      onShardProgress,
    );

    const positionsWithIdx = (out.positions as any[]).map((pos, k) => ({
      __idx: idxs[k],
      ...pos,
    }));
    return { ...out, positions: positionsWithIdx };
  });

  const shards = await Promise.all(tasks);

  const positionsMerged: any[] = new Array(total);
  for (const s of shards)
    for (const p of s.positions as any[]) {
      positionsMerged[p.__idx] = { fen: p.fen, idx: p.idx, lines: p.lines };
    }
  const first = shards.find(
    (s) => Array.isArray(s.positions) && s.positions.length > 0,
  );
  const settings = (first as any)?.settings ?? {};
  return { positions: positionsMerged, settings } as any as GameEval;
}

// -------------------- Analysis helpers (matching LocalGameAnalyzer.kt) --------------------

/**
 * Вычисление CP из позиции (как в LocalGameAnalyzer.kt)
 */
function getPositionCp(position: PositionEval): number {
  const line = position.lines[0];
  if (line.cp !== undefined) {
    return ceilsNumber(line.cp, -1000, 1000);
  }
  if (line.mate !== undefined) {
    return ceilsNumber(line.mate * 1000, -1000, 1000);
  }
  return 0;
}

/**
 * Вычисление ACPL (Average Centipawn Loss)
 * Синхронизировано с LocalGameAnalyzer.kt: analyzeGame()
 */
function computeACPL(positions: PositionEval[]): ACPL {
  // Разделяем позиции на белые и черные
  const whitePositions: PositionEval[] = [];
  const blackPositions: PositionEval[] = [];

  positions.forEach((pos, idx) => {
    if (idx % 2 === 0) {
      whitePositions.push(pos);
    } else {
      blackPositions.push(pos);
    }
  });

  // Вычисляем CPL для белых
  const whiteCplValues: number[] = [];
  for (let i = 0; i < whitePositions.length - 1; i++) {
    const currentCp = getPositionCp(whitePositions[i]);
    const nextCp = getPositionCp(whitePositions[i + 1]);
    const loss = Math.max(0, currentCp - nextCp);
    whiteCplValues.push(Math.min(loss, 1000));
  }

  // Вычисляем CPL для черных
  const blackCplValues: number[] = [];
  for (let i = 0; i < blackPositions.length - 1; i++) {
    const currentCp = getPositionCp(blackPositions[i]);
    const nextCp = getPositionCp(blackPositions[i + 1]);
    const loss = Math.max(0, nextCp - currentCp);
    blackCplValues.push(Math.min(loss, 1000));
  }

  const whiteCpl = whiteCplValues.length > 0
    ? whiteCplValues.reduce((a, b) => a + b, 0) / whiteCplValues.length
    : 0;

  const blackCpl = blackCplValues.length > 0
    ? blackCplValues.reduce((a, b) => a + b, 0) / blackCplValues.length
    : 0;

  return {
    white: Math.round(whiteCpl),
    black: Math.round(blackCpl),
  };
}

/**
 * Вычисление точности хода из разницы win%
 * Синхронизировано с accuracy.ts: getMovesAccuracy()
 */
function rawMoveAccuracy(winDiff: number): number {
  // Source: https://github.com/lichess-org/lila/blob/a320a93b68dabee862b8093b1b2acdfe132b9966/modules/analyse/src/main/AccuracyPercent.scala#L44
  const raw =
    103.1668100711649 * Math.exp(-0.04354415386753951 * winDiff) -
    3.166924740191411;
  return Math.min(100, Math.max(0, raw + 1));
}

/**
 * Получение точности всех ходов
 */
function getMovesAccuracy(winPercents: number[]): number[] {
  return winPercents.slice(1).map((winPercent, index) => {
    const lastWinPercent = winPercents[index];
    const isWhiteMove = index % 2 === 0;
    const winDiff = isWhiteMove
      ? Math.max(0, lastWinPercent - winPercent)
      : Math.max(0, winPercent - lastWinPercent);
    return rawMoveAccuracy(winDiff);
  });
}

/**
 * Вычисление весов для точности
 * Синхронизировано с accuracy.ts: getAccuracyWeights()
 */
function getAccuracyWeights(winPercents: number[]): number[] {
  const windowSize = ceilsNumber(Math.ceil(winPercents.length / 10), 2, 8);
  const windows: number[][] = [];
  const halfWindowSize = Math.round(windowSize / 2);

  for (let i = 1; i < winPercents.length; i++) {
    const startIdx = i - halfWindowSize;
    const endIdx = i + halfWindowSize;

    if (startIdx < 0) {
      windows.push(winPercents.slice(0, windowSize));
      continue;
    }

    if (endIdx > winPercents.length) {
      windows.push(winPercents.slice(-windowSize));
      continue;
    }

    windows.push(winPercents.slice(startIdx, endIdx));
  }

  return windows.map((window) => {
    const std = getStandardDeviation(window);
    return ceilsNumber(std, 0.5, 12);
  });
}

/**
 * Вычисление точности игрока
 * Синхронизировано с LocalGameAnalyzer.kt: getPlayerAccuracy()
 * Возвращает ТОЛЬКО итоговое число (среднее взвешенной и гармонической средней)
 */
function getPlayerAccuracy(
  movesAcc: number[],
  weights: number[],
  player: "white" | "black",
): number {
  const remainder = player === "white" ? 0 : 1;
  const playerAcc = movesAcc.filter((_, idx) => idx % 2 === remainder);
  const playerWeights = weights.filter((_, idx) => idx % 2 === remainder);

  if (playerAcc.length === 0) return 0;

  const weighted = getWeightedMean(playerAcc, playerWeights);
  const harmonic = getHarmonicMean(playerAcc);

  return (weighted + harmonic) / 2;
}

/**
 * Вычисление общей точности
 * Синхронизировано с LocalGameAnalyzer.kt: computeAccuracy()
 */
function computeAccuracy(positions: PositionEval[]): Accuracy {
  const positionsWinPercentage = positions.map(p => getPositionWinPercentage(p));
  const weights = getAccuracyWeights(positionsWinPercentage);
  const movesAccuracy = getMovesAccuracy(positionsWinPercentage);

  const whiteAccuracy = getPlayerAccuracy(movesAccuracy, weights, "white");
  const blackAccuracy = getPlayerAccuracy(movesAccuracy, weights, "black");

  return {
    white: whiteAccuracy,
    black: blackAccuracy,
  };
}

/**
 * Конвертация MoveClassification в строку верхнего регистра
 */
function toClientMoveClass(cls?: MoveClassification | string): string {
  const v = typeof cls === "string" ? cls : (cls as any)?.toString?.() ?? "";
  switch (v.toLowerCase()) {
    case "opening":
      return "OPENING";
    case "forced":
      return "FORCED";
    case "best":
      return "BEST";
    case "perfect":
      return "PERFECT";
    case "splendid":
      return "SPLENDID";
    case "excellent":
      return "EXCELLENT";
    case "okay":
    case "good":
      return "OKAY";
    case "inaccuracy":
      return "INACCURACY";
    case "mistake":
      return "MISTAKE";
    case "blunder":
      return "BLUNDER";
    default:
      return "OKAY";
  }
}

/**
 * Нормализация UCI для сравнения (добавляет 'q' к промоции по умолчанию)
 */
function normUci(u: string): string {
  const s = String(u || "").trim().toLowerCase();
  if (s.length === 4) return s + "q";
  return s;
}

/**
 * Конвертация позиции в клиентский формат
 * Синхронизировано с LocalGameAnalyzer.kt: toClientPosition()
 */
function toClientPosition(
  posAny: any,
  fen: string,
  idx: number,
  isLastPosition: boolean,
  gameResult?: string
): ClientPosition {
  const rawLines: any[] = Array.isArray(posAny?.lines) ? posAny.lines : [];
  
  const lines: ClientLine[] = rawLines.map((l: any) => {
    const pv: string[] = Array.isArray(l?.pv)
      ? l.pv
      : Array.isArray(l?.pv?.moves)
      ? l.pv.moves
      : [];
    const cpVal = typeof l?.cp === "number" ? l.cp : undefined;
    const mateVal = typeof l?.mate === "number" ? l.mate : undefined;
    return { pv, cp: cpVal, mate: mateVal };
  });

  // Fallback для пустых линий
  if (lines.length === 0) {
    if (isLastPosition && gameResult && (gameResult === "1-0" || gameResult === "0-1")) {
      const mate = gameResult === "1-0" ? +1 : -1;
      lines.push({ pv: [], mate, best: "" });
    } else {
      lines.push({ pv: [], cp: 0, best: "" });
    }
  }

  // Устанавливаем best для первой линии
  const firstPv = lines[0]?.pv;
  const best =
    (posAny as any)?.bestMove ??
    (Array.isArray(firstPv) && firstPv.length > 0 ? firstPv[0] : undefined) ??
    "";
  
  if (lines[0]) {
    lines[0].best = String(best);
  }

  return {
    fen: String(fen ?? ""),
    idx,
    lines,
  };
}

/**
 * Создание отчета по ходу
 * Синхронизировано с LocalGameAnalyzer.kt: MoveReport
 */
function createMoveReport(
  uci: string,
  beforeFen: string,
  afterFen: string,
  winBefore: number,
  winAfter: number,
  moveAccuracy: number,
  classification: MoveClassification | string,
  bestFromPosition?: string
): MoveReport {
  // Преобразуем UCI в SAN
  const chess = new Chess(beforeFen);
  const move = {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
  };
  const m = chess.move(move as any);
  const san = (m as any)?.san ?? uci;

  let cls = toClientMoveClass(classification);

  // Принудительный BEST, если сыгранный ход совпал с лучшим
  if (bestFromPosition) {
    const playedUci = normUci(uci);
    const bestUci = normUci(bestFromPosition);
    if (playedUci === bestUci) {
      cls = "BEST";
    }
  }

  return {
    san,
    uci,
    beforeFen,
    afterFen,
    winBefore,
    winAfter,
    accuracy: moveAccuracy,
    classification: cls,
    tags: [],
  };
}

/**
 * Анализ игры - главная функция
 * Синхронизировано с LocalGameAnalyzer.kt: analyzeGame()
 */
function analyzeGame(args: {
  engineOut: GameEval;
  fens: string[];
  uciMoves: string[];
  depth: number;
  multiPv: number;
  gameResult?: string;
}): GameAnalysis {
  const { engineOut, fens, uciMoves, depth, multiPv, gameResult } = args;

  // 1. Конвертируем позиции в клиентский формат
  const positions: ClientPosition[] = fens.map((fen: string, idx: number) => {
    const posAny: any = (engineOut.positions as any[])[idx] ?? {};
    const isLast = idx === fens.length - 1;
    return toClientPosition(posAny, fen, idx, isLast, gameResult);
  });

  // 2. Вычисляем win% для всех позиций
  const winPercents: number[] = (positions as any[]).map((p: any) => {
    const first = p?.lines?.[0];
    const hasEval =
      first && (typeof first.cp === "number" || typeof first.mate === "number");
    return hasEval ? getPositionWinPercentage(p as any) : 50;
  });

  // 3. Вычисляем точность всех ходов
  const movesAccuracy = getMovesAccuracy(winPercents);

  // 4. Классифицируем ходы
  const classifiedPositions: any[] = getMovesClassification(
    positions as any,
    uciMoves,
    fens,
  ) as any[];

  // 5. Создаем отчеты по ходам
  const moves: MoveReport[] = [];
  const count = Math.min(uciMoves.length, Math.max(0, fens.length - 1));

  for (let i = 0; i < count; i++) {
    const uci = String(uciMoves[i] ?? "");
    const beforeFen = String(fens[i] ?? "");
    const afterFen = String(fens[i + 1] ?? "");
    const winBefore = winPercents[i] ?? 50;
    const winAfter = winPercents[i + 1] ?? 50;
    const moveAcc = movesAccuracy[i] ?? 0;
    const classification = classifiedPositions[i + 1]?.moveClassification;
    const bestFromPosition = positions[i]?.lines?.[0]?.best;

    const moveReport = createMoveReport(
      uci,
      beforeFen,
      afterFen,
      winBefore,
      winAfter,
      moveAcc,
      classification,
      bestFromPosition
    );

    moves.push(moveReport);
  }

  // 6. Вычисляем общую точность
  const accuracy = computeAccuracy(positions as any);

  // 7. Вычисляем ACPL
  const acpl = computeACPL(positions as any);

  // 8. Вычисляем оценочный рейтинг
  const estRaw = computeEstimatedElo(positions as any, undefined, undefined) as any;
  const toIntOrNull = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  const estimatedElo: EstimatedElo | null = estRaw
    ? {
        white: toIntOrNull(estRaw?.white),
        black: toIntOrNull(estRaw?.black),
      }
    : null;

  // 9. Формируем настройки
  const settings: AnalysisSettings = {
    engine: (engineOut as any)?.settings?.engine ?? "stockfish-native",
    depth: (engineOut as any)?.settings?.depth ?? depth,
    multiPv: (engineOut as any)?.settings?.multiPv ?? multiPv,
  };

  // 10. Возвращаем полный анализ
  return {
    positions,
    moves,
    accuracy,
    acpl,
    estimatedElo,
    settings,
  };
}

// -------------------- PGN parsing --------------------
function normalizePgnServer(src: string): string {
  let s = src
    .replace(/\uFEFF/g, "")
    .replace(/[\u200B\u200C\u200D\u2060]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  s = s.replace(/0-0-0/g, "O-O-O").replace(/0-0/g, "O-O");
  s = s
    .replace(/1–0/g, "1-0")
    .replace(/0–1/g, "0-1")
    .replace(/½–½/g, "1/2-1/2")
    .replace(/½-½/g, "1/2-1/2");

  s = s.replace(/\{\[%clk [^}]+\]\}/g, "");
  s = s.replace(/\s\$\d+/g, "");

  s = Array.from(s)
    .filter((ch) => ch === "\n" || ch === "\t" || ch.codePointAt(0)! >= 32)
    .join("");

  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/\s+$/g, "");
  if (!s.endsWith("\n")) s += "\n";
  return s;
}

function splitHeaderAndMovetext(pgn: string): {
  headerText: string;
  movetext: string;
} {
  const m = pgn.match(/^(?:\[[^\]\n]+\]\s*\n)+/);
  if (m) {
    const headerText = m[0].replace(/\n+$/g, "");
    const movetext = pgn.slice(m[0].length).replace(/^\s+/, "");
    return { headerText, movetext };
  }
  return { headerText: "", movetext: pgn.trimStart() };
}

function parseHeaderMap(headerText: string): Record<string, string> {
  const map: Record<string, string> = {};
  const rx = /\[([A-Za-z0-9_]+)\s+"([^"]*)"\]/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(headerText)) !== null) {
    map[m[1]] = m[2];
  }
  return map;
}

function stripBalancedParentheses(s: string): string {
  let out = "";
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

function tokenizeSanMovetext(raw: string): string[] {
  let s = raw;
  s = s.replace(/\{[^}]*\}/g, " ");
  s = stripBalancedParentheses(s);
  s = s.replace(/\$\d+/g, " ");
  s = s.replace(/\b\d+\.(\.\.)?/g, " ");
  s = s.replace(/\[\%[^\]]+\]/g, " ");
  s = s.replace(/\u2026/g, "...").replace(/\.\.\./g, " ");

  const rough = s
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  const ignore = new Set(["1-0", "0-1", "1/2-1/2", "*"]);
  const sans = rough.filter((t) => !ignore.has(t));

  return sans;
}

function pgnToFenAndUci(pgn: string): {
  fens: string[];
  uciMoves: string[];
  header: Record<string, string>;
} {
  const pgnFixed = normalizePgnServer(pgn);
  const { headerText, movetext } = splitHeaderAndMovetext(pgnFixed);
  const header = parseHeaderMap(headerText);

  const replay = new Chess();
  if (header?.FEN && (header?.SetUp === "1" || header?.SetUp === "true")) {
    try {
      replay.load(header.FEN);
    } catch (e) {
      throw new Error(`Bad FEN in header: ${header.FEN}`);
    }
  }

  const fens: string[] = [replay.fen()];
  const uciMoves: string[] = [];

  const sanTokens = tokenizeSanMovetext(movetext);

  for (const san of sanTokens) {
    const move = replay.move(san, { sloppy: true } as any);
    if (!move) {
      const beforeFen = fens[fens.length - 1] ?? "";
      throw new Error(
        `Invalid SAN during replay: ${JSON.stringify({
          san,
          before: beforeFen,
        })}`,
      );
    }
    const uci = `${move.from}${move.to}${move.promotion ?? ""}`;
    uciMoves.push(uci);
    fens.push(replay.fen());
  }

  return { fens, uciMoves, header };
}

// -------------------- Endpoints --------------------
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/ping", (_req, res) => res.json({ ok: true }));
app.post("/ping", (_req, res) => res.json({ ok: true }));

app.get("/api/v1/progress/:id", (req, res) => {
  const id = req.params.id;
  let p = PROGRESS.get(id);
  if (!p) {
    const now = Date.now();
    p = {
      id,
      total: 0,
      done: 0,
      percent: 0,
      stage: "queued" as ProgressStage,
      startedAt: now,
      updatedAt: now,
    };
    PROGRESS.set(id, p);
  }
  res.json(p);
});

/**
 * Оценка одной позиции или одного хода (real-time)
 */
app.post("/api/v1/evaluate/position", async (req, res) => {
  try {
    const {
      fen,
      depth,
      multiPv,
      useNNUE,
      elo,
      skillLevel,
      beforeFen,
      afterFen,
      uciMove,
    } = req.body ?? {};

    const effDepth = Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH;
    const effMultiPv = Number.isFinite(multiPv)
      ? Number(multiPv)
      : DEFAULT_MULTIPV;

    // === РЕЖИМ real-time: анализ ОДНОГО хода ===
    if (
      typeof beforeFen === "string" &&
      typeof afterFen === "string" &&
      typeof uciMove === "string"
    ) {
      const baseParams: EvaluateGameParams = {
        fens: [String(beforeFen), String(afterFen)],
        uciMoves: [String(uciMove)],
        depth: effDepth,
        multiPv: effMultiPv,
        ...(useNNUE !== undefined ? { useNNUE } : {}),
        ...(elo !== undefined ? { elo } : {}),
        ...(skillLevel !== undefined ? { skillLevel } : {}),
      } as any;

      const out: GameEval = await evaluateGameParallel(baseParams, 1);

      const rawPositions: any[] = Array.isArray((out as any)?.positions)
        ? (out as any).positions
        : [];
      
      const fens2 = [String(beforeFen), String(afterFen)];
      const positions: ClientPosition[] = fens2.map((fenStr: string, idx: number) => {
        const posAny: any = rawPositions[idx] ?? {};
        return toClientPosition(posAny, fenStr, idx, idx === 1);
      });

      // Проверка на мат
      try {
        const ch = new Chess();
        ch.load(String(beforeFen));
        const from = String(uciMove).slice(0, 2);
        const to = String(uciMove).slice(2, 4);
        const prom = String(uciMove).slice(4) || undefined;
        const mv = ch.move({ from, to, promotion: prom as any });
        if (mv && ch.isCheckmate && ch.isCheckmate()) {
          const moverIsWhite = String(beforeFen).includes(" w ");
          const mateVal = moverIsWhite ? +1 : -1;
          if (positions[1].lines.length === 0) {
            positions[1].lines.push({ pv: [], mate: mateVal });
          } else {
            positions[1].lines[0] = {
              ...(positions[1].lines[0] || {}),
              mate: mateVal,
            };
            delete (positions[1].lines[0] as any).cp;
          }
        }
      } catch {}

      // Если нет best для позиции "до" - запрашиваем
      const needBestFix =
        !positions[0]?.lines?.[0]?.best ||
        String(positions[0].lines[0].best).trim() === "";

      if (needBestFix) {
        try {
          const engine = await getSingletonEngine();
          const eval0 = await engine.evaluatePositionWithUpdate({
            fen: String(beforeFen),
            depth: effDepth,
            multiPv: effMultiPv,
            useNNUE,
            elo,
            ...(skillLevel !== undefined ? { skillLevel } : {}),
          } as any);
          const rawTop = Array.isArray(eval0?.lines) ? eval0.lines[0] : undefined;
          const bestFromEngine: string =
            (eval0 as any)?.bestMove ??
            (Array.isArray(rawTop?.pv) ? rawTop.pv[0] : undefined) ??
            "";

          if (bestFromEngine) {
            positions[0].lines[0].best = String(bestFromEngine);
            if (!Array.isArray(positions[0].lines[0].pv) || positions[0].lines[0].pv.length === 0) {
              positions[0].lines[0].pv = [String(bestFromEngine)];
            }
          }
        } catch {}
      }

      const bestFromBefore = String(
        positions[0]?.lines?.[0]?.best ??
        positions[0]?.lines?.[0]?.pv?.[0] ??
        "",
      ) || undefined;

      // Классификация
      const classified = getMovesClassification(
        positions as any,
        [String(uciMove)],
        [String(beforeFen), String(afterFen)],
      ) as any[];

      const clsRaw: any | undefined = classified?.[1]?.moveClassification;
      const cls = toClientMoveClass(clsRaw);

      return res.json({
        lines: positions[1].lines,
        bestMove: bestFromBefore,
        moveClassification: cls,
      });
    }

    // === РЕЖИМ обычной позиции ===
    if (!fen || typeof fen !== "string") {
      return res.status(400).json({ error: "fen_required" });
    }

    const engine = await getSingletonEngine();
    const params: EvaluatePositionWithUpdateParams = {
      fen,
      depth: Number.isFinite(depth) ? Number(depth) : undefined,
      multiPv: Number.isFinite(multiPv) ? Number(multiPv) : undefined,
      useNNUE,
      elo,
      ...(skillLevel !== undefined ? { skillLevel } : {}),
    } as any;

    const finalEval = await engine.evaluatePositionWithUpdate(params);
    return res.json(finalEval);
  } catch (e: any) {
    return res.status(500).json({
      error: "evaluate_position_failed",
      details: String(e?.message ?? e),
    });
  }
});

/**
 * Оценка игры по FEN-ам
 */
app.post("/api/v1/evaluate/game/by-fens", async (req, res) => {
  const progressId = String(
    (req.query as any)?.progressId ?? req.body?.progressId ?? "",
  );
  
  try {
    const body = req.body ?? {};
    const fens = Array.isArray(body.fens) ? body.fens : [];
    const uciMoves = Array.isArray(body.uciMoves) ? body.uciMoves : [];
    
    if (progressId) {
      initProgress(progressId, fens.length || 0);
      setProgress(progressId, { stage: "queued" });
    }

    const depthQ = Number((req.query as any)?.depth);
    const multiPvQ = Number((req.query as any)?.multiPv);
    const depth = Number.isFinite(body.depth)
      ? Number(body.depth)
      : Number.isFinite(depthQ)
      ? depthQ
      : DEFAULT_DEPTH;
    const multiPv = Number.isFinite(body.multiPv)
      ? Number(body.multiPv)
      : Number.isFinite(multiPvQ)
      ? multiPvQ
      : DEFAULT_MULTIPV;

    if (!Array.isArray(fens) || fens.length < 2) {
      if (progressId) setProgress(progressId, { stage: "done" as ProgressStage });
      return res.status(400).json({ error: "invalid_fens" });
    }

    const playersRatings = normalizePlayersRatings(body);
    const baseParams: EvaluateGameParams = {
      fens,
      uciMoves,
      depth,
      multiPv,
      playersRatings,
      ...(body.useNNUE !== undefined ? { useNNUE: body.useNNUE } : {}),
      ...(body.elo !== undefined ? { elo: body.elo } : {}),
      ...(body.skillLevel !== undefined ? { skillLevel: body.skillLevel } : {}),
    } as any;

    const result = await jobQueue.enqueue(async () => {
      if (progressId)
        setProgress(progressId, { stage: "evaluating" as ProgressStage, done: 0 });

      const out: GameEval = await evaluateGameParallel(
        baseParams,
        Number(body.workersNb ?? 0),
        (p) => {
          if (progressId) {
            const done = Math.max(
              0,
              Math.min(fens.length, Math.round((p / 100) * fens.length)),
            );
            setProgress(progressId, { done, stage: "evaluating" as ProgressStage });
          }
        },
      );

      if (progressId)
        setProgress(progressId, {
          stage: "postprocess" as ProgressStage,
          done: fens.length,
        });

      const analysis = analyzeGame({
        engineOut: out,
        fens,
        uciMoves,
        depth,
        multiPv,
        gameResult: body.header?.Result,
      });

      if (progressId)
        setProgress(progressId, { stage: "done" as ProgressStage, done: fens.length });

      return analysis;
    });

    return res.json(result);
  } catch (e: any) {
    if (progressId) setProgress(progressId, { stage: "done" as ProgressStage });
    return res.status(500).json({
      error: "evaluate_game_failed",
      details: String(e?.message ?? e),
    });
  }
});

/**
 * Оценка игры по PGN
 */
app.post("/api/v1/evaluate/game", async (req, res) => {
  const progressId = String(
    (req.query as any)?.progressId ?? req.body?.progressId ?? "",
  );
  
  try {
    const { pgn, depth, multiPv, workersNb, useNNUE, elo, skillLevel } =
      req.body ?? {};
    
    if (!pgn || typeof pgn !== "string") {
      return res.status(400).json({ error: "pgn_required" });
    }

    const { fens, uciMoves, header } = pgnToFenAndUci(pgn);

    if (progressId) {
      initProgress(progressId, fens.length || 0);
      setProgress(progressId, { stage: "queued" });
    }

    const playersRatings = normalizePlayersRatings(req.body);
    const effDepth = Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH;
    const effMultiPv = Number.isFinite(multiPv)
      ? Number(multiPv)
      : DEFAULT_MULTIPV;

    const baseParams: EvaluateGameParams = {
      fens,
      uciMoves,
      depth: effDepth,
      multiPv: effMultiPv,
      playersRatings,
      useNNUE,
      elo,
      ...(skillLevel !== undefined ? { skillLevel } : {}),
    } as any;

    const result = await jobQueue.enqueue(async () => {
      if (progressId)
        setProgress(progressId, { stage: "evaluating" as ProgressStage, done: 0 });

      const out: GameEval = await evaluateGameParallel(
        baseParams,
        Number(workersNb ?? 0),
        (p) => {
          if (progressId) {
            const done = Math.max(
              0,
              Math.min(fens.length, Math.round((p / 100) * fens.length)),
            );
            setProgress(progressId, { done, stage: "evaluating" as ProgressStage });
          }
        },
      );

      if (progressId)
        setProgress(progressId, {
          stage: "postprocess" as ProgressStage,
          done: fens.length,
        });

      const analysis = analyzeGame({
        engineOut: out,
        fens,
        uciMoves,
        depth: effDepth,
        multiPv: effMultiPv,
        gameResult: header?.Result,
      });

      if (progressId)
        setProgress(progressId, { stage: "done" as ProgressStage, done: fens.length });

      return analysis;
    });

    return res.json(result);
  } catch (e: any) {
    if (progressId) setProgress(progressId, { stage: "done" as ProgressStage });
    return res.status(500).json({
      error: "evaluate_game_failed",
      details: String(e?.message ?? e),
    });
  }
});

app.use((req, res) => {
  res
    .status(404)
    .json({ error: "not_found", path: `${req.method} ${req.originalUrl}` });
});

app.listen(PORT, () => {
  log.info(`Server http://localhost:${PORT}`);
});