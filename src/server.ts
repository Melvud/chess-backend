// src/server.ts
// Сервер для анализа шахматных партий с использованием нативного Stockfish.
// Использует UciEngine для взаимодействия с движком, рассчитывает ACPL,
// точность ходов, классификацию и предполагаемый рейтинг партии.

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import pino from "pino";
import pinoHttp from "pino-http";
import { Chess } from "chess.js";

// Типы и перечисления
import { EngineName, MoveClassification } from "./types/enums";
import type {
  GameEval,
  EvaluateGameParams,
  EvaluatePositionWithUpdateParams,
} from "./types/eval";

// Хелперы для расчётов
import { computeEstimatedElo } from "@/lib/engine/helpers/estimateElo";
import { getMovesClassification } from "@/lib/engine/helpers/moveClassification";
import { getPositionWinPercentage } from "@/lib/engine/helpers/winPercentage";

// Математические функции для точности
import {
  ceilsNumber,
  getHarmonicMean,
  getStandardDeviation,
  getWeightedMean,
} from "@/lib/math";

// Наш UCI движок
import { UciEngine } from "./lib/engine/uciEngine";

// -------------------- ENV --------------------
const PORT = Number(process.env.PORT ?? 8080);
const ENGINE_NAME: EngineName =
  (process.env.ENGINE_NAME as EngineName) ?? EngineName.Stockfish17Lite;
const DEFAULT_DEPTH = Number(process.env.ENGINE_DEPTH ?? 16);
const DEFAULT_MULTIPV = Number(process.env.ENGINE_MULTIPV ?? 3);

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

// Раздаём статические файлы движков (если нужно)
const publicDir = path.join(process.cwd(), "public");
app.use("/engines", express.static(path.join(publicDir, "engines")));

// -------------------- Progress --------------------
type ProgressStage = "queued" | "preparing" | "evaluating" | "postprocess" | "done";
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

// -------------------- helpers: ratings normalization --------------------
type PlayersRatings = { white?: number; black?: number };
function normalizePlayersRatings(src: any): PlayersRatings | undefined {
  if (!src || typeof src !== "object") return undefined;
  const pr = src.playersRatings && typeof src.playersRatings === "object" ? src.playersRatings : src;
  const w =
    Number.isFinite(pr.white) ? Number(pr.white)
      : Number.isFinite(pr.whiteElo) ? Number(pr.whiteElo)
      : Number.isFinite(pr?.white?.elo) ? Number(pr.white.elo)
      : Number.isFinite(src.whiteElo) ? Number(src.whiteElo)
      : Number.isFinite(src?.white?.elo) ? Number(src.white.elo)
      : undefined;
  const b =
    Number.isFinite(pr.black) ? Number(pr.black)
      : Number.isFinite(pr.blackElo) ? Number(pr.blackElo)
      : Number.isFinite(pr?.black?.elo) ? Number(pr.black.elo)
      : Number.isFinite(src.blackElo) ? Number(src.blackElo)
      : Number.isFinite(src?.black?.elo) ? Number(src.black.elo)
      : undefined;
  if (typeof w === "number" || typeof b === "number") {
    return { white: w, black: b };
  }
  return undefined;
}

// -------------------- Engine lifecycle --------------------
type EngineIface = {
  evaluatePositionWithUpdate: (p: EvaluatePositionWithUpdateParams) => Promise<{ lines: any[]; bestMove?: string }>;
  evaluateGame: (p: EvaluateGameParams, onProgress?: (p: number) => void) => Promise<GameEval>;
};
let engineInstance: EngineIface | null = null;
let enginePromise: Promise<EngineIface> | null = null;

async function getEngine(): Promise<EngineIface> {
  if (engineInstance) return engineInstance;
  if (!enginePromise) {
    enginePromise = (async () => {
      const eng = await UciEngine.create(ENGINE_NAME, "");
      const adapted: EngineIface = {
        evaluatePositionWithUpdate: (p) => eng.evaluatePositionWithUpdate(p),
        evaluateGame: (p, onProgress) => eng.evaluateGame(p, onProgress),
      };
      engineInstance = adapted;
      return adapted;
    })();
  }
  return enginePromise;
}

// -------------------- Accuracy helpers --------------------
// Формула из Lichess для расчёта точности хода
function rawMoveAccuracy(winDiff: number): number {
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * winDiff) - 3.166924740191411;
  return Math.min(100, Math.max(0, raw + 1));
}
// Получаем массив точности для каждого хода на основе изменения вероятности выигрыша
function getMovesAccuracy(winPercents: number[]): number[] {
  return winPercents.slice(1).map((winPercent, index) => {
    const lastWinPercent = winPercents[index];
    const isWhiteMove = index % 2 === 0;
    const winDiff = isWhiteMove ? Math.max(0, lastWinPercent - winPercent) : Math.max(0, winPercent - lastWinPercent);
    return rawMoveAccuracy(winDiff);
  });
}
// Рассчитываем веса для каждого хода (окна длиной ~10% от партии)
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
// Получаем точность одного игрока (white или black)
function computePlayerAccuracy(movesAcc: number[], weights: number[], player: "white" | "black") {
  const remainder = player === "white" ? 0 : 1;
  const playerAcc = movesAcc.filter((_, idx) => idx % 2 === remainder);
  const playerWeights = weights.filter((_, idx) => idx % 2 === remainder);
  const weighted = getWeightedMean(playerAcc, playerWeights);
  const harmonic = getHarmonicMean(playerAcc);
  const itera = (weighted + harmonic) / 2;
  return { itera, weighted, harmonic };
}

// Расчёт ACPL (Average Centipawn Loss) по позиции
function calculateACPL(positions: any[]): { white: number; black: number } {
  let whiteCPL = 0;
  let blackCPL = 0;
  let whiteMoves = 0;
  let blackMoves = 0;
  for (let i = 1; i < positions.length; i++) {
    const prevPos = positions[i - 1];
    const currPos = positions[i];
    const prevEval = prevPos.lines[0];
    const currEval = currPos.lines[0];
    if (!prevEval || !currEval) continue;
    const prevCP = prevEval.cp ?? (prevEval.mate ? prevEval.mate * 1000 : 0);
    const currCP = currEval.cp ?? (currEval.mate ? currEval.mate * 1000 : 0);
    const isWhiteMove = (i - 1) % 2 === 0;
    if (isWhiteMove) {
      const loss = Math.max(0, prevCP - currCP);
      whiteCPL += Math.min(loss, 1000);
      whiteMoves++;
    } else {
      const loss = Math.max(0, currCP - prevCP);
      blackCPL += Math.min(loss, 1000);
      blackMoves++;
    }
  }
  return {
    white: whiteMoves > 0 ? Math.round(whiteCPL / whiteMoves) : 0,
    black: blackMoves > 0 ? Math.round(blackCPL / blackMoves) : 0,
  };
}

// Преобразование PGN в массив FEN и UCI ходов
function pgnToFenAndUci(pgn: string): { fens: string[]; uciMoves: string[] } {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const fens: string[] = [chess.fen()];
  const uciMoves: string[] = [];
  for (const move of chess.history({ verbose: true }) as any[]) {
    const uci = `${move.from}${move.to}${move.promotion ?? ""}`;
    uciMoves.push(uci);
    chess.move(move as any);
    fens.push(chess.fen());
  }
  return { fens, uciMoves };
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

// Оценка одной позиции
app.post("/api/evaluate/position", async (req, res) => {
  try {
    const { fen, depth, multiPv, useNNUE, elo } = req.body ?? {};
    if (!fen || typeof fen !== "string") {
      return res.status(400).json({ error: "fen_required" });
    }
    const engine = await getEngine();
    const params: EvaluatePositionWithUpdateParams = {
      fen,
      depth: Number.isFinite(depth) ? Number(depth) : undefined,
      multiPv: Number.isFinite(multiPv) ? Number(multiPv) : undefined,
      // пробрасываем дополнительные параметры
      useNNUE,
      elo,
    } as any;
    const finalEval = await engine.evaluatePositionWithUpdate(params);
    res.json(finalEval);
  } catch (e: any) {
    res.status(500).json({ error: "evaluate_position_failed", details: String(e?.message ?? e) });
  }
});

// Оценка партии по FEN (с прогрессом)
app.post("/api/v1/evaluate/game/by-fens", async (req, res) => {
  const progressId = String((req.query as any)?.progressId ?? req.body?.progressId ?? "");
  try {
    const body = req.body ?? {};
    const fens = Array.isArray(body.fens) ? body.fens : [];
    const uciMoves = Array.isArray(body.uciMoves) ? body.uciMoves : [];
    if (progressId) initProgress(progressId, fens.length || 0);
    const depthQ = Number((req.query as any)?.depth);
    const multiPvQ = Number((req.query as any)?.multiPv);
    const depth =
      Number.isFinite(body.depth) ? Number(body.depth)
      : Number.isFinite(depthQ) ? depthQ
      : DEFAULT_DEPTH;
    const multiPv =
      Number.isFinite(body.multiPv) ? Number(body.multiPv)
      : Number.isFinite(multiPvQ) ? multiPvQ
      : DEFAULT_MULTIPV;
    if (!Array.isArray(fens) || fens.length < 2) {
      if (progressId) setProgress(progressId, { stage: "done" as ProgressStage });
      return res.status(400).json({ error: "invalid_fens" });
    }
    const engine = await getEngine();
    if (progressId) setProgress(progressId, { stage: "evaluating" as ProgressStage, done: 0 });
    const playersRatings = normalizePlayersRatings(body);
    const params: EvaluateGameParams = {
      fens,
      uciMoves,
      depth,
      multiPv,
      playersRatings,
      // передаём флаги useNNUE и elo, если есть
      ...(body.useNNUE !== undefined ? { useNNUE: body.useNNUE } : {}),
      ...(body.elo !== undefined ? { elo: body.elo } : {}),
    } as any;
    const onProgress =
      progressId && fens.length > 0
        ? (p: number) => {
            const done = Math.max(0, Math.min(fens.length, Math.round((p / 100) * fens.length)));
            setProgress(progressId, { done, stage: "evaluating" as ProgressStage });
          }
        : undefined;
    const out: GameEval = await engine.evaluateGame(params, onProgress);
    if (progressId) setProgress(progressId, { stage: "postprocess" as ProgressStage, done: fens.length });
    // Собираем client-friendly структуру positions
    type ClientLine = { pv: string[]; cp?: number; mate?: number; best?: string };
    type ClientPosition = { fen: string; idx: number; lines: ClientLine[] };
    const positions: ClientPosition[] = fens.map((fen: string, idx: number) => {
      const posAny: any = (out.positions as any[])[idx] ?? {};
      const rawLines: any[] = Array.isArray(posAny?.lines) ? posAny.lines : [];
      const lines: ClientLine[] = rawLines.map((l: any) => {
        const pv: string[] = Array.isArray(l?.pv)
          ? l.pv
          : Array.isArray(l?.pv?.moves)
          ? l.pv.moves
          : [];
        const cpVal = typeof l?.cp === "number" ? l.cp : undefined;
        const mateVal = typeof l?.mate === "number" ? l.mate : undefined;
        const cpFixed = cpVal == null && mateVal == null ? 0 : cpVal;
        return { pv, cp: cpFixed, mate: mateVal };
      });
      if (lines.length === 0) {
        lines.push({ pv: [], cp: 0, best: "" });
      }
      const firstPv = lines[0]?.pv;
      const best = (posAny as any)?.bestMove ?? (Array.isArray(firstPv) ? firstPv[0] : undefined) ?? "";
      if (lines[0]) {
        lines[0].best = String(best);
      }
      return { fen: String(fen ?? ""), idx, lines };
    });
    // ACPL
    const acpl = calculateACPL(positions);
    // Win percentages
    const winPercents: number[] = (positions as any[]).map((p: any) => {
      const first = p?.lines?.[0];
      const hasEval = first && (typeof first.cp === "number" || typeof first.mate === "number");
      return hasEval ? getPositionWinPercentage(p as any) : 50;
    });
    // Accuracy: рассчитываем точность ходов
    const movesAcc = getMovesAccuracy(winPercents);
    const weightsAcc = getAccuracyWeights(winPercents);
    const whiteAcc = computePlayerAccuracy(movesAcc, weightsAcc, "white");
    const blackAcc = computePlayerAccuracy(movesAcc, weightsAcc, "black");
    const accuracy = {
      whiteMovesAcc: whiteAcc,
      blackMovesAcc: blackAcc,
    };
    // Классификация ходов
    const classifiedPositions: any[] = getMovesClassification(
      positions as any,
      uciMoves,
      fens,
    ) as any[];
    // per-move accuracy для отчёта по ходам
    const perMoveAcc: number[] = [];
    for (let i = 1; i < winPercents.length; i++) {
      const isWhiteMove = (i - 1) % 2 === 0;
      const loss = isWhiteMove ? Math.max(0, winPercents[i - 1] - winPercents[i]) : Math.max(0, winPercents[i] - winPercents[i - 1]);
      perMoveAcc.push(rawMoveAccuracy(loss));
    }
    // Формируем отчёты по ходам
    const moves = buildMoveReports({
      fens,
      uciMoves,
      winPercents,
      perMoveAcc,
      classified: classifiedPositions,
    });
    // Расчёт оценочного рейтинга
    const estRaw = computeEstimatedElo(positions as any, undefined, undefined) as any;
    const toIntOrNull = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n) : null;
    };
    const estimatedElo = {
      whiteEst: toIntOrNull(estRaw?.whiteEst ?? estRaw?.white),
      blackEst: toIntOrNull(estRaw?.blackEst ?? estRaw?.black),
    };
    // Составляем полный отчёт
    const fullReport = {
      header: (req.body && (req.body as any).header) || {},
      positions,
      moves,
      accuracy,
      acpl: {
        white: Math.round(acpl.white ?? 0),
        black: Math.round(acpl.black ?? 0),
      },
      estimatedElo,
      analysisLog: [
        `engine=${(out as any)?.settings?.engine ?? "stockfish-native"}`,
        `depth=${(out as any)?.settings?.depth ?? depth}`,
        `multiPv=${(out as any)?.settings?.multiPv ?? multiPv}`,
        `positions=${positions.length}`,
      ],
      settings: (out as any).settings,
    };
    if (progressId) setProgress(progressId, { stage: "done" as ProgressStage, done: fens.length });
    res.json(fullReport);
  } catch (e: any) {
    if (progressId) setProgress(progressId, { stage: "done" as ProgressStage });
    res.status(500).json({ error: "evaluate_game_failed", details: String(e?.message ?? e) });
  }
});

// Оценка партии по PGN
app.post("/api/evaluate/game", async (req, res) => {
  try {
    const { pgn, depth, multiPv, workersNb, useNNUE, elo } = req.body ?? {};
    if (!pgn || typeof pgn !== "string") {
      return res.status(400).json({ error: "pgn_required" });
    }
    const { fens, uciMoves } = pgnToFenAndUci(pgn);
    const engine = await getEngine();
    const playersRatings = normalizePlayersRatings(req.body);
    const params: EvaluateGameParams = {
      fens,
      uciMoves,
      depth: Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH,
      multiPv: Number.isFinite(multiPv) ? Number(multiPv) : DEFAULT_MULTIPV,
      workersNb: Number.isFinite(workersNb) ? Number(workersNb) : 1,
      playersRatings,
      useNNUE,
      elo,
    } as any;
    const out: GameEval = await engine.evaluateGame(params);
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: "evaluate_game_failed", details: String(e?.message ?? e) });
  }
});

// 404 обработчик
app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: `${req.method} ${req.originalUrl}` });
});

// Запуск сервера
app.listen(PORT, () => {
  log.info(`Server http://localhost:${PORT}`);
});

// -------------------- Additional helpers --------------------
// toClientMoveClassUpper аналогичен оригиналу: приводит MoveClassification к строке
function toClientMoveClassUpper(cls?: MoveClassification | string): string {
  const v = typeof cls === "string" ? cls : (cls as any)?.toString?.() ?? "";
  switch (v) {
    case "opening":
    case "Opening":
      return "OPENING";
    case "forced":
    case "Forced":
      return "FORCED";
    case "best":
    case "Best":
      return "BEST";
    case "perfect":
    case "Perfect":
      return "PERFECT";
    case "splendid":
    case "Splendid":
      return "SPLENDID";
    case "excellent":
    case "Excellent":
      return "EXCELLENT";
    case "okay":
    case "Okay":
    case "good":
    case "Good":
      return "OKAY";
    case "inaccuracy":
    case "Inaccuracy":
      return "INACCURACY";
    case "mistake":
    case "Mistake":
      return "MISTAKE";
    case "blunder":
    case "Blunder":
      return "BLUNDER";
    default:
      return "OKAY";
  }
}

// buildMoveReports формирует отчёты по каждому ходу: san, uci, winPercents и классификация
function buildMoveReports(args: {
  fens: string[];
  uciMoves: string[];
  winPercents: number[];
  perMoveAcc: number[];
  classified: any[];
}) {
  const { fens, uciMoves, winPercents, perMoveAcc, classified } = args;
  const count = Math.min(uciMoves.length, Math.max(0, fens.length - 1));
  const chess = new Chess(fens[0]);
  const list: any[] = [];
  for (let i = 0; i < count; i++) {
    const uci = String(uciMoves[i] ?? "");
    const beforeFen = String(fens[i] ?? "");
    const afterFen = String(fens[i + 1] ?? "");
    const move = {
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
    };
    chess.load(beforeFen);
    const m = chess.move(move as any);
    const san = (m as any)?.san ?? uci;
    const clsRaw: MoveClassification | string | undefined = classified[i + 1]?.moveClassification;
    const cls = toClientMoveClassUpper(clsRaw);
    list.push({
      san,
      uci,
      beforeFen,
      afterFen,
      winBefore: Number(winPercents[i] ?? 50),
      winAfter: Number(winPercents[i + 1] ?? 50),
      accuracy: Number(perMoveAcc[i] ?? 0),
      classification: cls,
      tags: [],
    });
  }
  return list;
}