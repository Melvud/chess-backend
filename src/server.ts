// server.ts
import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import pino from "pino";
import pinoHttp from "pino-http";
import { Chess } from "chess.js";
import { webcrypto as nodeCrypto } from "node:crypto";

import { UciEngine } from "./lib/engine/uciEngine";
import { EngineName } from "./types/enums";
import type {
  GameEval,
  PositionEval,
  EvaluateGameParams,
  EvaluatePositionWithUpdateParams,
} from "./types/eval";

/* -------------------- ENV / константы -------------------- */
const PORT = Number(process.env.PORT ?? 8080);
const ENGINE_PATH = process.env.ENGINE_PATH ?? "/engines/stockfish-17/worker.js";
const ENGINE_NAME: EngineName =
  (process.env.ENGINE_NAME as EngineName) ?? EngineName.Stockfish17Lite;
const DEFAULT_DEPTH = Number(process.env.ENGINE_DEPTH ?? 16);
const DEFAULT_MULTIPV = Number(process.env.ENGINE_MULTIPV ?? 3);

/** как в UciEngine: простая детекция режима для логов */
function detectSpawnMode(enginePublicPath: string): "node" | "web" {
  const p = enginePublicPath.toLowerCase();
  if (p.endsWith(".cjs") || p.includes("node-worker")) return "node";
  return "web";
}

/* -------------------- Лёгкие полифилы (без Worker) -------------------- */
{
  const g = globalThis as any;
  if (typeof g.window === "undefined") g.window = g;
  if (typeof g.navigator === "undefined") g.navigator = { userAgent: "node" };
  if (typeof g.crypto === "undefined") g.crypto = nodeCrypto;

  // иногда нужно для временных blob-url (не критично для движка)
  if (typeof g.URL === "undefined") g.URL = {};
  if (typeof g.URL.createObjectURL === "undefined") {
    g.URL.createObjectURL = (blob: Blob | any) => {
      const tmp = path.join(
        os.tmpdir(),
        `blob-${Date.now()}-${Math.random().toString(36).slice(2)}.js`,
      );
      // на случай разных реализаций Blob
      const sym = Object.getOwnPropertySymbols(blob)[0];
      const buf =
        blob?.[sym]?._buffer ??
        (Buffer.isBuffer(blob) ? blob : Buffer.from(blob as any));
      fs.writeFileSync(tmp, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
      return tmp;
    };
  }
  if (typeof g.URL.revokeObjectURL === "undefined") {
    g.URL.revokeObjectURL = (p: string) => {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* noop */
      }
    };
  }
}

/* -------------------- Express -------------------- */
const app = express();
const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

app.use(
  cors({
    origin: (_o, cb) => cb(null, true),
    credentials: false,
  }),
);
app.use(express.json({ limit: "8mb" }));
app.use(pinoHttp({ logger: log }));

// раздаём статику движка (актуально для web-режима; в node-режиме не мешает)
app.use(
  "/engines",
  express.static(path.join(process.cwd(), "public", "engines"), {
    index: false,
    etag: true,
    maxAge: "1y",
  }),
);
app.use(express.static(path.join(process.cwd(), "public")));

/* -------------------- Жизненный цикл движка -------------------- */
let engineInstance: UciEngine | null = null;
let enginePromise: Promise<UciEngine> | null = null;

async function getEngine(): Promise<UciEngine> {
  log.debug({
    msg: "getEngine: called",
    hasInstance: !!engineInstance,
    hasPromise: !!enginePromise,
    ENGINE_NAME,
    ENGINE_PATH,
  });

  if (engineInstance) {
    log.debug({ msg: "getEngine: reuse existing engine instance" });
    return engineInstance;
  }
  if (!enginePromise) {
    log.debug({ msg: "getEngine: creating engine via factory" });
    const started = Date.now();
    enginePromise = (async () => {
      const eng = await UciEngine.create(ENGINE_NAME, ENGINE_PATH);
      const took = Date.now() - started;
      log.info({ msg: "getEngine: engine created", tookMs: took });
      engineInstance = eng;
      return eng;
    })();
  } else {
    log.debug({ msg: "getEngine: awaiting existing creation promise" });
  }
  const eng = await enginePromise;
  log.debug({ msg: "getEngine: ready to use" });
  return eng;
}

function resetEngine() {
  log.warn({ msg: "resetEngine: invoked", hadInstance: !!engineInstance });
  if (engineInstance) {
    try {
      engineInstance.shutdown();
      log.info({ msg: "resetEngine: shutdown complete" });
    } catch (e) {
      log.error({ msg: "resetEngine: shutdown error", err: e });
    }
    engineInstance = null;
  }
  enginePromise = null;
  log.debug({ msg: "resetEngine: cleared state" });
}

/* -------------------- Вспомогательное: PGN -> { fens, uciMoves } -------------------- */
type FenMoves = { fens: string[]; uciMoves: string[]; resultTag?: string };

function pgnToFenAndUci(pgn: string): FenMoves {
  const started = Date.now();
  log.debug({ msg: "pgnToFenAndUci: start" });

  const loaded = new Chess();

  try {
    loaded.loadPgn(pgn);
    log.debug({ msg: "pgnToFenAndUci: loadPgn ok" });
  } catch (e) {
    log.warn({ msg: "pgnToFenAndUci: Invalid PGN", err: e });
    throw new Error("Invalid PGN");
  }

  const hasMovesSyntax = /\d+\./.test(pgn);
  if (loaded.history().length === 0 && hasMovesSyntax) {
    log.warn({ msg: "pgnToFenAndUci: has SAN numbers but empty history" });
    throw new Error("Invalid PGN");
  }

  const verbose = loaded.history({ verbose: true });
  log.debug({ msg: "pgnToFenAndUci: verbose history", moves: verbose.length });

  const c = new Chess();
  const fens: string[] = [c.fen()];
  const uciMoves: string[] = [];

  for (const m of verbose) {
    const uci = `${m.from}${m.to}${m.promotion ?? ""}`;
    uciMoves.push(uci);
    c.move(m.san);
    fens.push(c.fen());
  }

  const took = Date.now() - started;
  log.info({
    msg: "pgnToFenAndUci: done",
    fens: fens.length,
    uciMoves: uciMoves.length,
    tookMs: took,
  });

  return {
    fens,
    uciMoves,
    resultTag: (loaded.header().Result as any) ?? undefined,
  };
}

/* ============================================================================
 *                                  ПРОГРЕСС
 * ==========================================================================*/
type Stage = "queued" | "preparing" | "evaluating" | "postprocess" | "done";
type Progress = {
  id: string;
  total: number;
  done: number;
  percent: number; // 0..1
  stage: Stage;
  startedAt: number;
  updatedAt: number;
  etaMs?: number;
};

const PROGRESS = new Map<string, Progress>();

function initProgress(id: string, total = 0) {
  const now = Date.now();
  const p: Progress = {
    id,
    total,
    done: 0,
    percent: 0,
    stage: "queued",
    startedAt: now,
    updatedAt: now,
  };
  PROGRESS.set(id, p);
  log.debug({ msg: "progress:init", id, total, stage: p.stage });
}

function setProgress(id: string, patch: Partial<Progress>) {
  const cur = PROGRESS.get(id);
  if (!cur) {
    log.warn({ msg: "progress:set: missing progress id", id, patch });
    return;
  }
  const upd: Progress = { ...cur, ...patch, updatedAt: Date.now() };
  if (upd.total > 0) {
    const prevDone = upd.done;
    upd.percent = Math.min(1, Math.max(0, upd.done / upd.total));
    const elapsed = upd.updatedAt - upd.startedAt;
    const speed = upd.done > 0 ? elapsed / upd.done : undefined;
    upd.etaMs = speed && upd.total > upd.done ? Math.round(speed * (upd.total - upd.done)) : undefined;
    log.debug({
      msg: "progress:set: recompute",
      id,
      done: prevDone,
      total: upd.total,
      percent: upd.percent,
      etaMs: upd.etaMs,
    });
  }
  PROGRESS.set(id, upd);
  log.info({
    msg: "progress:update",
    id,
    stage: upd.stage,
    done: upd.done,
    total: upd.total,
    percent: upd.percent,
  });
}

/* -------------------- health/ping -------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/ping", (_req, res) => res.json({ ok: true }));
app.post("/ping", (_req, res) => res.json({ ok: true }));

app.get("/api/v1/progress/:id", (req, res) => {
  const id = req.params.id;
  let p = PROGRESS.get(id);
  log.debug({ msg: "progress:get", id, found: !!p });
  if (!p) {
    initProgress(id, 0);
    p = PROGRESS.get(id)!;
  }
  res.json(p);
});

/* ============================================================================
 *                   Оценка позиции (без прогресса)
 * ==========================================================================*/
app.post("/api/evaluate/position", async (req, res) => {
  req.log.info({ msg: "POST /api/evaluate/position: start" });
  try {
    const { fen, depth, multiPv } = req.body ?? {};
    req.log.debug({
      msg: "evaluate/position: payload",
      hasFen: !!fen,
      depth,
      multiPv,
    });

    if (!fen || typeof fen !== "string") {
      req.log.warn({ msg: "evaluate/position: bad request (fen_required)" });
      return res.status(400).json({ error: "fen_required" });
    }

    const engine = await getEngine();
    req.log.debug({ msg: "evaluate/position: engine ready" });

    const params: EvaluatePositionWithUpdateParams = {
      fen,
      depth: Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH,
      multiPv: Number.isFinite(multiPv) ? Number(multiPv) : DEFAULT_MULTIPV,
    };
    req.log.debug({ msg: "evaluate/position: calling engine", params });

    const started = Date.now();
    const finalEval: PositionEval = await engine.evaluatePositionWithUpdate(params);
    const took = Date.now() - started;
    req.log.info({ msg: "POST /api/evaluate/position: success", tookMs: took });

    res.json(finalEval);
  } catch (e: any) {
    req.log.error({ msg: "POST /api/evaluate/position: error", err: e });
    res.status(500).json({
      error: "evaluate_position_failed",
      details: String(e?.message ?? e),
    });
  }
});

// алиас под клиентский /api/v1/evaluate/position
app.post("/api/v1/evaluate/position", (req, res) => {
  req.log.debug({
    msg: "ALIAS /api/v1/evaluate/position -> /api/evaluate/position",
  });
  (app as any)._router.handle(
    { ...req, url: "/api/evaluate/position", originalUrl: "/api/evaluate/position" },
    res,
    () => {},
  );
});

/* ============================================================================
 *              Анализ партии по FEN/UCIs (v1: с прогрессом)
 * ==========================================================================*/
app.post("/api/v1/evaluate/game/by-fens", async (req, res) => {
  const progressId = String(req.query.progressId ?? "");
  req.log.info({
    msg: "POST /api/v1/evaluate/game/by-fens: start",
    progressId,
    bodyKeys: Object.keys(req.body ?? {}),
  });

  try {
    const { fens, uciMoves, depth, multiPv, playersRatings, workersNb } = req.body ?? {};
    req.log.debug({
      msg: "by-fens: payload",
      fensLen: Array.isArray(fens) ? fens.length : -1,
      uciMovesLen: Array.isArray(uciMoves) ? uciMoves.length : -1,
      depth,
      multiPv,
      workersNb,
    });

    if (!Array.isArray(fens) || fens.length < 2) {
      req.log.warn({ msg: "by-fens: invalid_fens", type: typeof fens });
      return res.status(400).json({ error: "invalid_fens" });
    }

    if (progressId) {
      initProgress(progressId, fens.length);
      setProgress(progressId, { stage: "preparing" });
    }

    const engine = await getEngine();
    req.log.debug({ msg: "by-fens: engine ready" });

    if (progressId) {
      setProgress(progressId, { stage: "evaluating" });
    }

    const params: EvaluateGameParams = {
      fens,
      uciMoves: Array.isArray(uciMoves) ? uciMoves : [],
      depth: Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH,
      multiPv: Number.isFinite(multiPv) ? Number(multiPv) : DEFAULT_MULTIPV,
      workersNb: Number.isFinite(workersNb) ? Number(workersNb) : 1,
      playersRatings:
        playersRatings && typeof playersRatings === "object"
          ? {
              white: Number.isFinite(playersRatings.white)
                ? Number(playersRatings.white)
                : undefined,
              black: Number.isFinite(playersRatings.black)
                ? Number(playersRatings.black)
                : undefined,
            }
          : undefined,
    };
    req.log.debug({
      msg: "by-fens: engine call params",
      depth: params.depth,
      multiPv: params.multiPv,
      workersNb: params.workersNb,
    });

    const progressCallback =
      progressId
        ? (p: number) => {
            // p — проценты 0..100, переводим в "done"
            const done = Math.min(
              fens.length,
              Math.max(0, Math.round(((Number(p) || 0) / 100) * fens.length)),
            );
            req.log.debug({
              msg: "by-fens: onProgress",
              p,
              computedDone: done,
              total: fens.length,
            });
            setProgress(progressId, { done, stage: "evaluating" });
          }
        : undefined;

    const started = Date.now();
    req.log.info({ msg: "by-fens: engine.evaluateGame START" });
    const out: GameEval = await engine.evaluateGame(params, progressCallback);
    const took = Date.now() - started;
    req.log.info({ msg: "by-fens: engine.evaluateGame DONE", tookMs: took });

    if (progressId) {
      setProgress(progressId, { stage: "postprocess", done: fens.length });
      setProgress(progressId, { stage: "done", done: fens.length });
    }

    res.json(out);
  } catch (e: any) {
    if (progressId) {
      setProgress(progressId, { stage: "done" });
    }
    req.log.error({
      msg: "POST /api/v1/evaluate/game/by-fens: error",
      err: e,
      progressId,
    });
    res.status(500).json({
      error: "evaluate_game_failed",
      details: String(e?.message ?? e),
    });
  }
});

/* ============================================================================
 *                   Анализ партии по PGN (без прогресса v1)
 * ==========================================================================*/
app.post("/api/evaluate/game", async (req, res) => {
  req.log.info({ msg: "POST /api/evaluate/game: start" });
  try {
    const { pgn, depth, multiPv, playersRatings, workersNb } = req.body ?? {};
    req.log.debug({
      msg: "evaluate/game: payload",
      hasPgn: typeof pgn === "string",
      depth,
      multiPv,
      workersNb,
    });

    if (!pgn || typeof pgn !== "string") {
      req.log.warn({ msg: "evaluate/game: pgn_required" });
      return res.status(400).json({ error: "pgn_required" });
    }

    const parsedStarted = Date.now();
    const { fens, uciMoves } = pgnToFenAndUci(pgn);
    const parseTook = Date.now() - parsedStarted;
    req.log.info({
      msg: "evaluate/game: PGN parsed",
      fensLen: fens.length,
      uciLen: uciMoves.length,
      tookMs: parseTook,
    });

    const params: EvaluateGameParams = {
      fens,
      uciMoves,
      depth: Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH,
      multiPv: Number.isFinite(multiPv) ? Number(multiPv) : DEFAULT_MULTIPV,
      workersNb: Number.isFinite(workersNb) ? Number(workersNb) : 1,
      playersRatings:
        playersRatings && typeof playersRatings === "object"
          ? {
              white: Number.isFinite(playersRatings.white)
                ? Number(playersRatings.white)
                : undefined,
              black: Number.isFinite(playersRatings.black)
                ? Number(playersRatings.black)
                : undefined,
            }
          : undefined,
    };
    req.log.debug({
      msg: "evaluate/game: engine call params",
      depth: params.depth,
      multiPv: params.multiPv,
      workersNb: params.workersNb,
    });

    const engine = await getEngine();
    const started = Date.now();
    const out: GameEval = await engine.evaluateGame(params);
    const took = Date.now() - started;
    req.log.info({ msg: "POST /api/evaluate/game: success", tookMs: took });

    res.json(out);
  } catch (e: any) {
    req.log.error({ msg: "POST /api/evaluate/game: error", err: e });
    res.status(500).json({
      error: "evaluate_game_failed",
      details: String(e?.message ?? e),
    });
  }
});

/* ============================================================================
 *                       Управление движком
 * ==========================================================================*/
app.post("/api/engine/stop", async (req, res) => {
  req.log.warn({ msg: "POST /api/engine/stop" });
  try {
    const engine = await getEngine();
    const started = Date.now();
    await engine.stopAllCurrentJobs();
    const took = Date.now() - started;
    req.log.info({ msg: "engine/stop: ok", tookMs: took });
    res.json({ ok: true });
  } catch (e: any) {
    req.log.error({ msg: "engine/stop error", err: e });
    res.status(500).json({
      error: "engine_stop_failed",
      details: String(e?.message ?? e),
    });
  }
});

app.post("/api/engine/shutdown", async (req, res) => {
  req.log.warn({ msg: "POST /api/engine/shutdown" });
  try {
    resetEngine();
    req.log.info({ msg: "engine/shutdown: ok" });
    res.json({ ok: true });
  } catch (e: any) {
    req.log.error({ msg: "engine/shutdown error", err: e });
    res.status(500).json({
      error: "engine_shutdown_failed",
      details: String(e?.message ?? e),
    });
  }
});

/* ============================================================================
 *                 JSON 404 вместо HTML для неизвестных путей
 * ==========================================================================*/
app.use((req, res) => {
  req.log.warn({ msg: "404 not_found", path: `${req.method} ${req.originalUrl}` });
  res.status(404).json({ error: "not_found", path: `${req.method} ${req.originalUrl}` });
});

/* -------------------- Старт -------------------- */
app.listen(PORT, () => {
  const mode = detectSpawnMode(ENGINE_PATH);
  log.info(`Server http://localhost:${PORT}`);
  log.info(
    `Engine mode: ${mode.toUpperCase()} | Engine path: ${ENGINE_PATH} | Static: /engines → public/engines`,
  );
});
