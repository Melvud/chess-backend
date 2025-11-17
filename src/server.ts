// src/server.ts - ОПТИМИЗИРОВАННАЯ ВЕРСИЯ С ВОРКЕРАМИ
import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import os from "node:os";
import pino from "pino";
import pinoHttp from "pino-http";

import { EngineName } from "@/types/enums";
import type { GameEval } from "@/types/eval";

import { UciEngine } from "@/lib/engine/uciEngine";

// -------------------- ENV --------------------
const PORT = Number(process.env.PORT ?? 8080);
const ENGINE_NAME: EngineName =
  (process.env.ENGINE_NAME as EngineName) ?? EngineName.Stockfish17Lite;
const DEFAULT_DEPTH = Number(process.env.ENGINE_DEPTH ?? 16);
const DEFAULT_MULTIPV = Number(process.env.ENGINE_MULTIPV ?? 3);

const CPU_CORES = Math.max(1, os.cpus()?.length ?? 1);
const ENGINE_THREADS = Math.max(1, Number(process.env.ENGINE_THREADS ?? CPU_CORES));
const ENGINE_HASH_MB = Math.max(16, Number(process.env.ENGINE_HASH_MB ?? 256));
const ENGINE_WORKERS_MAX = Math.max(1, Number(process.env.ENGINE_WORKERS_MAX ?? CPU_CORES));
const ENGINE_MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.ENGINE_MAX_CONCURRENT_JOBS ?? 2));

// -------------------- Server --------------------
const app = express();
const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

app.use(cors({ origin: (_o, cb) => cb(null, true), credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(pinoHttp({ logger: log, customProps: () => ({ srv: "chess-backend" }) }));

const publicDir = path.join(process.cwd(), "public");
app.use("/engines", express.static(path.join(publicDir, "engines")));

// -------------------- Progress --------------------
type ProgressStage = "queued" | "preparing" | "evaluating" | "done";
type Progress = {
  id: string;
  total: number;
  done: number;
  percent?: number;
  stage?: ProgressStage;
  startedAt?: number;
  updatedAt?: number;
  fen?: string;
  currentUci?: string;
};
const PROGRESS = new Map<string, Progress>();

function initProgress(id: string, total: number) {
  const now = Date.now();
  PROGRESS.set(id, { id, total, done: 0, percent: 0, stage: "preparing", startedAt: now, updatedAt: now });
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

/**
 * Нормализует оценку к перспективе белых
 */
function normalizeEvaluation(positionData: any, fen: string) {
  const whiteToMove = fen.split(' ')[1] === 'w';
  if (whiteToMove) return positionData;
  
  const normalizedLines = positionData.lines.map((line: any) => ({
    ...line,
    cp: line.cp != null ? -line.cp : null,
    mate: line.mate != null ? (line.mate === 0 ? 1 : -line.mate) : null,
  }));
  
  return { ...positionData, lines: normalizedLines };
}

// -------------------- Extended Types --------------------
interface ExtendedEvaluateGameParams {
  fens: string[];
  uciMoves?: string[];
  depth?: number;
  multiPv?: number;
  useNNUE?: boolean;
  elo?: number;
  skillLevel?: number;
}

// -------------------- Engine helpers --------------------
type EngineIface = {
  evaluateGame: (p: ExtendedEvaluateGameParams, onProgress?: (p: number) => void) => Promise<GameEval>;
};

async function createEngineInstance(opts?: {
  threads?: number;
  hashMb?: number;
  multiPv?: number;
}): Promise<EngineIface> {
  const eng = await UciEngine.create(ENGINE_NAME, "");
  return eng as EngineIface;
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
  params: ExtendedEvaluateGameParams,
  requestedWorkers: number,
  progressId: string | null,
  onProgress?: (p: number) => void,
): Promise<GameEval> {
  const fens = Array.isArray(params.fens) ? params.fens : [];
  const uciMoves = params.uciMoves ?? [];
  const total = fens.length;
  
  if (total === 0) {
    return {
      positions: [],
      acpl: { white: 0, black: 0 },
      settings: { engine: "stockfish-native", depth: params.depth ?? DEFAULT_DEPTH, multiPv: params.multiPv ?? DEFAULT_MULTIPV },
    } as any;
  }

  const effectiveWorkers = Math.max(1, Math.min(ENGINE_WORKERS_MAX, Math.floor(requestedWorkers) || 1));
  const startTime = Date.now();
  log.info({ effectiveWorkers, total }, "Starting parallel evaluation");

  const results: any[] = new Array(total);
  let completed = 0;

  const workerPool = await Promise.all(
    Array.from({ length: effectiveWorkers }, () =>
      createEngineInstance({
        threads: Math.max(1, Math.floor(ENGINE_THREADS / effectiveWorkers)),
        hashMb: Math.max(16, Math.floor(ENGINE_HASH_MB / effectiveWorkers)),
        multiPv: params.multiPv ?? DEFAULT_MULTIPV,
      }),
    ),
  );

  try {
    const tasks = fens.map((fen, idx) => async () => {
      // СНАЧАЛА обновляем прогресс с текущей позицией (для мини-доски)
      if (progressId) {
        const currentUci = idx > 0 && idx <= uciMoves.length ? uciMoves[idx - 1] : undefined;
        setProgress(progressId, {
          done: completed,
          stage: "evaluating",
          fen: fen,
          currentUci: currentUci,
        });
      }

      const worker = workerPool[idx % effectiveWorkers];
      const evaluated = await worker.evaluateGame(
        {
          fens: [fen],
          depth: params.depth ?? DEFAULT_DEPTH,
          multiPv: params.multiPv ?? DEFAULT_MULTIPV,
          useNNUE: params.useNNUE,
          elo: params.elo,
          skillLevel: params.skillLevel,
        },
        undefined,
      );

      // Нормализуем к перспективе белых
      results[idx] = normalizeEvaluation(evaluated.positions[0], fen);
      completed++;

      // Обновляем прогресс ПОСЛЕ завершения оценки
      if (progressId) {
        setProgress(progressId, {
          done: completed,
          stage: "evaluating",
        });
      }

      if (onProgress) {
        const pct = Math.round((completed / total) * 100);
        onProgress(pct);
      }
    });

    // Параллельно выполняем с ограничением concurrency
    const concurrency = effectiveWorkers;
    const executing: Promise<void>[] = [];
    for (const task of tasks) {
      const p = task();
      executing.push(p);
      if (executing.length >= concurrency) {
        await Promise.race(executing);
        executing.splice(executing.findIndex((e) => e === p), 1);
      }
    }
    await Promise.all(executing);

    const elapsed = Date.now() - startTime;
    log.info({ completed: results.length, elapsed, perPosition: Math.round(elapsed / total) }, "Parallel evaluation complete");

    return {
      positions: results,
      acpl: { white: 0, black: 0 },
      settings: {
        engine: "stockfish-native",
        depth: params.depth ?? DEFAULT_DEPTH,
        multiPv: params.multiPv ?? DEFAULT_MULTIPV,
      },
    } as any;
  } finally {
    // Безопасно закрываем workers
    await Promise.allSettled(
      workerPool.map((worker) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            try {
              if (typeof (worker as any).shutdown === "function") {
                (worker as any).shutdown();
              }
            } catch (e) {
              log.warn({ err: e }, "Worker shutdown error");
            }
            resolve();
          }, 100);
        })
      )
    );
  }
}

// -------------------- API Routes --------------------

app.get("/health", (_req, res) => res.json({ status: "ok", timestamp: Date.now() }));
app.get("/ping", (_req, res) => res.json({ status: "ok", timestamp: Date.now() }));
app.get("/api/health", (_req, res) => res.json({ status: "ok", timestamp: Date.now() }));

app.get("/api/v1/progress/:id", (req, res) => {
  const id = String(req.params.id);
  const p = PROGRESS.get(id);
  if (!p) return res.status(404).json({ error: "progress_not_found" });
  return res.json(p);
});

app.post("/api/v1/evaluate/positions", async (req, res) => {
  const progressId = String((req.query as any)?.progressId ?? req.body?.progressId ?? "");

  try {
    const body = req.body ?? {};
    const fens = Array.isArray(body.fens) ? body.fens : [];
    const uciMoves = Array.isArray(body.uciMoves) ? body.uciMoves : [];

    if (progressId) {
      initProgress(progressId, fens.length || 0);
      setProgress(progressId, { stage: "queued" });
    }

    const depth = Number.isFinite(body.depth) ? Number(body.depth) : DEFAULT_DEPTH;
    const multiPv = Number.isFinite(body.multiPv) ? Number(body.multiPv) : DEFAULT_MULTIPV;

    if (!Array.isArray(fens) || fens.length < 1) {
      if (progressId) setProgress(progressId, { stage: "done" });
      return res.status(400).json({ error: "invalid_fens" });
    }

    const result = await jobQueue.enqueue(async () => {
      if (progressId) setProgress(progressId, { stage: "evaluating", done: 0 });

      // Параллельная оценка с воркерами
      const out: GameEval = await evaluateGameParallel(
        { fens, uciMoves, depth, multiPv, useNNUE: body.useNNUE, elo: body.elo, skillLevel: body.skillLevel },
        Number(body.workersNb ?? 0),
        progressId || null,
      );

      if (progressId) setProgress(progressId, { stage: "done", done: fens.length });

      return {
        positions: out.positions,
        settings: {
          engine: (out as any)?.settings?.engine ?? "stockfish-native",
          depth: (out as any)?.settings?.depth ?? depth,
          multiPv: (out as any)?.settings?.multiPv ?? multiPv,
        },
      };
    });

    return res.json(result);
  } catch (e: any) {
    if (progressId) setProgress(progressId, { stage: "done" });
    log.error({ err: e }, "Evaluation failed");
    return res.status(500).json({ error: "evaluate_positions_failed", details: String(e?.message ?? e) });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: `${req.method} ${req.originalUrl}` });
});

app.listen(PORT, () => {
  log.info(`Server http://localhost:${PORT}`);
});