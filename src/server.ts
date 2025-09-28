// src/server.ts
// Сервер для анализа шахматных партий с использованием нативного Stockfish.

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import os from "node:os";
import pino from "pino";
import pinoHttp from "pino-http";
import { Chess } from "chess.js";

import { EngineName, MoveClassification } from "./types/enums";
import type {
  GameEval,
  EvaluateGameParams,
  EvaluatePositionWithUpdateParams,
} from "./types/eval";

import { computeEstimatedElo } from "@/lib/engine/helpers/estimateElo";
import { getMovesClassification } from "@/lib/engine/helpers/moveClassification";
import { getPositionWinPercentage } from "@/lib/engine/helpers/winPercentage";

import {
  ceilsNumber,
  getHarmonicMean,
  getStandardDeviation,
  getWeightedMean,
} from "@/lib/math";

import { UciEngine } from "./lib/engine/uciEngine";

// -------------------- ENV --------------------
const PORT = Number(process.env.PORT ?? 8080);
const ENGINE_NAME: EngineName =
  (process.env.ENGINE_NAME as EngineName) ?? EngineName.Stockfish17Lite;
const DEFAULT_DEPTH = Number(process.env.ENGINE_DEPTH ?? 16);
const DEFAULT_MULTIPV = Number(process.env.ENGINE_MULTIPV ?? 3);

// новые ENV для ускорения
const CPU_CORES = Math.max(1, os.cpus()?.length ?? 1);
// по умолчанию задействуем все ядра, если ENV не задан
const ENGINE_THREADS = Math.max(
  1,
  Number(process.env.ENGINE_THREADS ?? CPU_CORES),
);
const ENGINE_HASH_MB = Math.max(16, Number(process.env.ENGINE_HASH_MB ?? 256));
const ENGINE_WORKERS_MAX = Math.max(
  1,
  Number(process.env.ENGINE_WORKERS_MAX ?? CPU_CORES),
);

// очередь: ограничение одновременных анализов партий
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
// NB: UciEngine — отдельный процесс под капотом. Создаём несколько и гоняем параллельно.

type EngineIface = {
  evaluatePositionWithUpdate: (p: EvaluatePositionWithUpdateParams) => Promise<{ lines: any[]; bestMove?: string }>;
  evaluateGame: (
    p: EvaluateGameParams,
    onProgress?: (p: number) => void,
  ) => Promise<GameEval>;
  // setOption?: (name: string, value: string | number | boolean) => Promise<void>;
};

// единичный инстанс для одиночных запросов позиции:
let singletonEngine: EngineIface | null = null;

async function createEngineInstance(opts?: { threads?: number; hashMb?: number; multiPv?: number }): Promise<EngineIface> {
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

// --- и тут используем его:
async function getSingletonEngine(): Promise<EngineIface> {
  if (singletonEngine) return singletonEngine;
  // один процесс — пусть ест все потоки
  singletonEngine = await createEngineInstance({ threads: ENGINE_THREADS, hashMb: ENGINE_HASH_MB, multiPv: DEFAULT_MULTIPV });
  return singletonEngine;
}

// -------------------- Async queue (лимит одновременных задач) --------------------
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

// Параллельная оценка партии по пулам движков
async function evaluateGameParallel(
  baseParams: EvaluateGameParams,
  workersRequested: number,
  onProgress?: (p: number) => void,
): Promise<GameEval> {
  const fens = baseParams.fens ?? [];
  const total = fens.length;

  // Если workersRequested <= 0 (или NaN), используем максимум доступных воркеров
  const requested = Number(workersRequested);
  const workers =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.max(1, Math.floor(requested)), ENGINE_WORKERS_MAX)
      : ENGINE_WORKERS_MAX;

  // одиночный процесс — пусть ест все потоки
  if (workers === 1 || total <= 2) {
    const eng = await getSingletonEngine();
    return eng.evaluateGame(baseParams, onProgress);
  }

  // делим ресурсы между воркерами (важно, иначе будет оверсабскрипшн CPU)
  const threadsPer = Math.max(1, Math.floor(ENGINE_THREADS / workers));
  const hashPer = Math.max(16, Math.floor(ENGINE_HASH_MB / workers));
  const multiPvPer = baseParams.multiPv ?? DEFAULT_MULTIPV; // можно держать 1 для скорости

  // распределяем позиции по воркерам (round-robin)
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

    const shardFens = idxs.map(i => baseParams.fens![i]);
    const shardUci = idxs.map(i => baseParams.uciMoves![i]);

    // создаём отдельный процесс с урезанными Threads/Hash
    const eng = await createEngineInstance({ threads: threadsPer, hashMb: hashPer, multiPv: multiPvPer });

    const onShardProgress = (p: number) => {
      const shardDone = Math.round((p / 100) * shardFens.length);
      const delta = Math.max(0, shardDone - perWorkerDone[wi]);
      if (delta > 0) { perWorkerDone[wi] += delta; reportProgress(); }
    };

    const out = await eng.evaluateGame(
      { ...baseParams, fens: shardFens, uciMoves: shardUci },
      onShardProgress
    );

    const positionsWithIdx = (out.positions as any[]).map((pos, k) => ({ __idx: idxs[k], ...pos }));
    return { ...out, positions: positionsWithIdx };
  });

  const shards = await Promise.all(tasks);

  const positionsMerged: any[] = new Array(total);
  for (const s of shards) for (const p of (s.positions as any[])) {
    positionsMerged[p.__idx] = { fen: p.fen, idx: p.idx, lines: p.lines };
  }
  const first = shards.find(s => Array.isArray(s.positions) && s.positions.length > 0);
  const settings = (first as any)?.settings ?? {};
  return { positions: positionsMerged, settings } as any as GameEval;
}

// -------------------- Accuracy helpers --------------------
function rawMoveAccuracy(winDiff: number): number {
  const raw =
    103.1668100711649 * Math.exp(-0.04354415386753951 * winDiff) -
    3.166924740191411;
  return Math.min(100, Math.max(0, raw + 1));
}
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
function computePlayerAccuracy(
  movesAcc: number[],
  weights: number[],
  player: "white" | "black",
) {
  const remainder = player === "white" ? 0 : 1;
  const playerAcc = movesAcc.filter((_, idx) => idx % 2 === remainder);
  const playerWeights = weights.filter((_, idx) => idx % 2 === remainder);
  const weighted = getWeightedMean(playerAcc, playerWeights);
  const harmonic = getHarmonicMean(playerAcc);
  const itera = (weighted + harmonic) / 2;
  return { itera, weighted, harmonic };
}
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

// -------------------- PGN нормализация/парсинг (ручной SAN) --------------------
function normalizePgnServer(src: string): string {
  let s = src
    .replace(/\uFEFF/g, "")
    .replace(/[\u200B\u200C\u200D\u2060]/g, "") // zero-width
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  // рокировки/результат/ничья к стандарту
  s = s.replace(/0-0-0/g, "O-O-O").replace(/0-0/g, "O-O");
  s = s
    .replace(/1–0/g, "1-0")
    .replace(/0–1/g, "0-1")
    .replace(/½–½/g, "1\/2-1\/2")
    .replace(/½-½/g, "1\/2-1\/2");

  // убрать часы Lichess и NAG
  s = s.replace(/\{\[%clk [^}]+\]\}/g, "");
  s = s.replace(/\s\$\d+/g, "");

  // удалить управляющие (кроме \n,\t)
  s = Array.from(s)
    .filter((ch) => ch === "\n" || ch === "\t" || ch.codePointAt(0)! >= 32)
    .join("");

  // схлопнуть 3+ пустых строк
  s = s.replace(/\n{3,}/g, "\n\n");

  s = s.replace(/\s+$/g, "");
  if (!s.endsWith("\n")) s += "\n";
  return s;
}

function splitHeaderAndMovetext(pgn: string): {
  headerText: string;
  movetext: string;
} {
  // блок тегов строго с начала файла
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
  // удаляем варианты в скобках, поддерживая вложенность
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

  // 1) Удаляем комментарии {...} (в т.ч. многострочные)
  s = s.replace(/\{[^}]*\}/g, " ");

  // 2) Удаляем варианты (...) c вложенностью
  s = stripBalancedParentheses(s);

  // 3) Удаляем NAG $n
  s = s.replace(/\$\d+/g, " ");

  // 4) Удаляем номера ходов: 1. / 23... и т.п.
  s = s.replace(/\b\d+\.(\.\.)?/g, " ");

  // 5) Удаляем спец-теги движков [%...]
  s = s.replace(/\[\%[^\]]+\]/g, " ");

  // 6) Схлопываем многоточия/мусор
  s = s.replace(/\u2026/g, "...").replace(/\.\.\./g, " ");

  // 7) Разбиваем по пробелам
  const rough = s
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  // 8) Убираем итог результата и маркеры конца партии
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

  // стартовая позиция
  const replay = new Chess();
  if (header?.FEN && (header?.SetUp === "1" || header?.SetUp === "true")) {
    const loaded = replay.load(header.FEN);
    if (!loaded) {
      throw new Error(`Bad FEN in header: ${header.FEN}`);
    }
  }

  const fens: string[] = [replay.fen()];
  const uciMoves: string[] = [];

  // SAN-токены
  const sanTokens = tokenizeSanMovetext(movetext);

  for (const san of sanTokens) {
    const move = replay.move(san, { sloppy: true } as any);
    if (!move) {
      const beforeFen = fens[fens.length - 1] ?? "";
      throw new Error(
        `Invalid SAN during replay: ${JSON.stringify({ san, before: beforeFen })}`,
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

app.post("/api/v1/evaluate/position", async (req, res) => {
  try {
    const {
      fen,
      depth,
      multiPv,
      useNNUE,
      elo,
      // новое для real-time классификации:
      beforeFen,
      afterFen,
      uciMove,
    } = req.body ?? {};

    // --- Режим real-time классификации хода по двум FEN + UCI ---
    // Если пришли beforeFen/afterFen/uciMove — считаем это запросом на оценку хода.
    if (beforeFen && afterFen && uciMove) {
      const effDepth = Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH;
      const effMultiPv = Number.isFinite(multiPv) ? Number(multiPv) : DEFAULT_MULTIPV;

      // считаем как «мини-партию» из двух позиций
      const baseParams: EvaluateGameParams = {
        fens: [String(beforeFen), String(afterFen)],
        uciMoves: [String(uciMove)],
        depth: effDepth,
        multiPv: effMultiPv,
        ...(useNNUE !== undefined ? { useNNUE } : {}),
        ...(elo !== undefined ? { elo } : {}),
      } as any;

      const out: GameEval = await evaluateGameParallel(baseParams, 1);

      // позиции 0 — ДО, 1 — ПОСЛЕ
      const pos0: any = (out as any)?.positions?.[0] ?? {};
      const pos1: any = (out as any)?.positions?.[1] ?? {};

      // аккуратная BEST для «до» (если не пришёл явный bestMove)
      const bestFromBefore =
        String(pos0?.bestMove ?? pos0?.lines?.[0]?.pv?.[0] ?? "") || undefined;

      // классификация хода (используем уже существующую логику проекта)
      const classified = getMovesClassification(
        out.positions as any,
        [String(uciMove)],
        [String(beforeFen), String(afterFen)],
      ) as any[];

      const clsRaw: any | undefined = classified?.[1]?.moveClassification;
      const cls = toClientMoveClassUpper(clsRaw);

      // Возвращаем линии «после хода», bestMove с «до» (совет движка из предыдущей позиции)
      // ВАЖНО: не обнуляем оценку при мате — в линиях остаётся mate (а cp не трогаем).
      return res.json({
        lines: Array.isArray(pos1?.lines) ? pos1.lines : [],
        bestMove: bestFromBefore,
        moveClassification: cls, // дополнительное поле (клиент со своим DTO игнорирует лишнее)
      });
    }

    // --- Обычный режим оценки одной позиции (как было) ---
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
    } as any;

    // Не трогаем mate/cp: внутри UCI парсера mate остаётся mate, cp — cp (не ставим нули).
    const finalEval = await engine.evaluatePositionWithUpdate(params);
    res.json(finalEval);
  } catch (e: any) {
    res
      .status(500)
      .json({ error: "evaluate_position_failed", details: String(e?.message ?? e) });
  }
});


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
    } as any;

    // очередь: задача будет ждать слот, затем выполнится и вернёт полный отчёт
    const result = await jobQueue.enqueue(async () => {
      if (progressId)
        setProgress(progressId, { stage: "evaluating" as ProgressStage, done: 0 });

      const out: GameEval = await evaluateGameParallel(
        baseParams,
        Number(body.workersNb ?? 0), // 0/undefined -> авто (ENGINE_WORKERS_MAX)
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

      const fullReport = buildFullReport({
        reqBody: req.body,
        engineOut: out,
        fens,
        uciMoves,
        depth,
        multiPv,
      });

      if (progressId)
        setProgress(progressId, { stage: "done" as ProgressStage, done: fens.length });

      return fullReport;
    });

    res.json(result);
  } catch (e: any) {
    if (progressId) setProgress(progressId, { stage: "done" as ProgressStage });
    res
      .status(500)
      .json({ error: "evaluate_game_failed", details: String(e?.message ?? e) });
  }
});

app.post("/api/v1/evaluate/game", async (req, res) => {
  const progressId = String(
    (req.query as any)?.progressId ?? req.body?.progressId ?? "",
  );
  try {
    const { pgn, depth, multiPv, workersNb, useNNUE, elo } = req.body ?? {};
    if (!pgn || typeof pgn !== "string") {
      return res.status(400).json({ error: "pgn_required" });
    }
    const { fens, uciMoves } = pgnToFenAndUci(pgn);

    if (progressId) {
      initProgress(progressId, fens.length || 0);
      setProgress(progressId, { stage: "queued" });
    }

    const playersRatings = normalizePlayersRatings(req.body);
    const effDepth = Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH;
    const effMultiPv = Number.isFinite(multiPv) ? Number(multiPv) : DEFAULT_MULTIPV;

    const baseParams: EvaluateGameParams = {
      fens,
      uciMoves,
      depth: effDepth,
      multiPv: effMultiPv,
      playersRatings,
      useNNUE,
      elo,
    } as any;

    const result = await jobQueue.enqueue(async () => {
      if (progressId)
        setProgress(progressId, { stage: "evaluating" as ProgressStage, done: 0 });

      const out: GameEval = await evaluateGameParallel(
        baseParams,
        Number(workersNb ?? 0), // 0/undefined -> авто (ENGINE_WORKERS_MAX)
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

      const fullReport = buildFullReport({
        reqBody: req.body,
        engineOut: out,
        fens,
        uciMoves,
        depth: effDepth,
        multiPv: effMultiPv,
      });

      if (progressId)
        setProgress(progressId, { stage: "done" as ProgressStage, done: fens.length });

      return fullReport;
    });

    res.json(result);
  } catch (e: any) {
    if (progressId) setProgress(progressId, { stage: "done" as ProgressStage });
    res
      .status(500)
      .json({ error: "evaluate_game_failed", details: String(e?.message ?? e) });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: `${req.method} ${req.originalUrl}` });
});

app.listen(PORT, () => {
  log.info(`Server http://localhost:${PORT}`);
});

// -------------------- Reporting helpers --------------------
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

// --- UCI нормализация для сравнения BEST ---
function normUci(u: string): string {
  const s = String(u || "").trim().toLowerCase();
  if (s.length === 4) return s + "q"; // промо по умолчанию — ферзь
  return s;
}

function buildMoveReports(args: {
  positions: { lines: Array<{ best?: string }> }[];
  fens: string[];
  uciMoves: string[];
  winPercents: number[];
  perMoveAcc: number[];
  classified: any[];
}) {
  const { positions, fens, uciMoves, winPercents, perMoveAcc, classified } = args;
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

    const clsRaw: MoveClassification | string | undefined =
      classified[i + 1]?.moveClassification;
    let cls = toClientMoveClassUpper(clsRaw);

    // Принудительный BEST, если сыгранный ход совпал с лучшим по движку
    const bestFromPos = String(positions[i]?.lines?.[0]?.best ?? "");
    if (bestFromPos) {
      const playedUci = normUci(uci);
      const bestUci = normUci(bestFromPos);
      if (playedUci === bestUci) cls = "BEST";
    }

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

function buildFullReport(args: {
  reqBody: any;
  engineOut: GameEval;
  fens: string[];
  uciMoves: string[];
  depth: number;
  multiPv: number;
}) {
  const { reqBody, engineOut, fens, uciMoves, depth, multiPv } = args;

  type ClientLine = { pv: string[]; cp?: number; mate?: number; best?: string };
  type ClientPosition = { fen: string; idx: number; lines: ClientLine[] };

  const positions: ClientPosition[] = fens.map((fen: string, idx: number) => {
    const posAny: any = (engineOut.positions as any[])[idx] ?? {};
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
    const best =
      (posAny as any)?.bestMove ??
      (Array.isArray(firstPv) ? firstPv[0] : undefined) ??
      "";
    if (lines[0]) {
      lines[0].best = String(best);
    }
    return { fen: String(fen ?? ""), idx, lines };
  });

  const acpl = calculateACPL(positions);

  const winPercents: number[] = (positions as any[]).map((p: any) => {
    const first = p?.lines?.[0];
    const hasEval =
      first && (typeof first.cp === "number" || typeof first.mate === "number");
    return hasEval ? getPositionWinPercentage(p as any) : 50;
  });

  const movesAcc = getMovesAccuracy(winPercents);
  const weightsAcc = getAccuracyWeights(winPercents);
  const whiteAcc = computePlayerAccuracy(movesAcc, weightsAcc, "white");
  const blackAcc = computePlayerAccuracy(movesAcc, weightsAcc, "black");
  const accuracy = {
    whiteMovesAcc: whiteAcc,
    blackMovesAcc: blackAcc,
  };

  const classifiedPositions: any[] = getMovesClassification(
    positions as any,
    uciMoves,
    fens,
  ) as any[];

  const perMoveAcc: number[] = [];
  for (let i = 1; i < winPercents.length; i++) {
    const isWhiteMove = (i - 1) % 2 === 0;
    const loss = isWhiteMove
      ? Math.max(0, winPercents[i - 1] - winPercents[i])
      : Math.max(0, winPercents[i] - winPercents[i - 1]);
    perMoveAcc.push(rawMoveAccuracy(loss));
  }

  const moves = buildMoveReports({
    positions,
    fens,
    uciMoves,
    winPercents,
    perMoveAcc,
    classified: classifiedPositions,
  });

  const estRaw = computeEstimatedElo(positions as any, undefined, undefined) as any;
  const toIntOrNull = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  const estimatedElo = {
    whiteEst: toIntOrNull(estRaw?.whiteEst ?? estRaw?.white),
    blackEst: toIntOrNull(estRaw?.blackEst ?? estRaw?.black),
  };

  const fullReport = {
    header: (reqBody && (reqBody as any).header) || {},
    positions,
    moves,
    accuracy,
    acpl: {
      white: Math.round(acpl.white ?? 0),
      black: Math.round(acpl.black ?? 0),
    },
    estimatedElo,
    analysisLog: [
      `engine=${(engineOut as any)?.settings?.engine ?? "stockfish-native"}`,
      `depth=${(engineOut as any)?.settings?.depth ?? depth}`,
      `multiPv=${(engineOut as any)?.settings?.multiPv ?? multiPv}`,
      `positions=${positions.length}`,
    ],
    settings: (engineOut as any).settings,
  };

  return fullReport;
}
