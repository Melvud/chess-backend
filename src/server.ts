// src/server.ts
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
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";

import { EngineName, MoveClassification } from "./types/enums";
import type {
  GameEval,
  EvaluateGameParams,
  EvaluatePositionWithUpdateParams,
} from "./types/eval";

import { computeEstimatedElo } from "@/lib/engine/helpers/estimateElo";
import { getMovesClassification } from "@/lib/engine/helpers/moveClassification";
import { getPositionWinPercentage } from "@/lib/engine/helpers/winPercentage";
import { computeAccuracyStrict } from "@/lib/engine/helpers/accuracy";

// -------------------- ENV --------------------
const PORT = Number(process.env.PORT ?? 8080);
const ENGINE_PATH =
  process.env.ENGINE_PATH ?? process.env.STOCKFISH_PATH ?? "./bin/stockfish";
const ENGINE_NAME: EngineName =
  (process.env.ENGINE_NAME as EngineName) ?? EngineName.Stockfish17Lite;
const DEFAULT_DEPTH = Number(process.env.ENGINE_DEPTH ?? 16);
const DEFAULT_MULTIPV = Number(process.env.ENGINE_MULTIPV ?? 3);

function detectSpawnMode(enginePath: string): "native" | "node" | "web" {
  const p = (enginePath || "").toLowerCase();
  if (p.endsWith(".cjs") || p.includes("node-worker")) return "node";
  if (p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".wasm")) return "web";
  return "native";
}

// -------------------- Polyfills --------------------
{
  const g = globalThis as any;
  if (typeof g.window === "undefined") g.window = g;
  if (typeof g.navigator === "undefined") g.navigator = { userAgent: "node" };
  if (typeof g.crypto === "undefined") g.crypto = nodeCrypto;

  if (typeof g.URL === "undefined") g.URL = {};
  if (typeof g.URL.createObjectURL === "undefined") {
    g.URL.createObjectURL = (blob: Blob | any) => {
      const tmp = path.join(
        os.tmpdir(),
        `blob-${Date.now()}-${Math.random().toString(16).slice(2)}`
      );
      fs.writeFileSync(tmp, Buffer.isBuffer(blob) ? blob : Buffer.from(String(blob)));
      return `file://${tmp}`;
    };
  }
  if (typeof g.URL.revokeObjectURL === "undefined") {
    g.URL.revokeObjectURL = (href: string) => {
      try {
        const p = href.startsWith("file://") ? href.slice("file://".length) : href;
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {}
    };
  }
}

// -------------------- Server --------------------
const app = express();
const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

app.use(
  cors({
    origin: (_o, cb) => cb(null, true),
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(
  pinoHttp({
    logger: log,
    customProps: () => ({ srv: "chess-backend" }),
  })
);

// static
const publicDir = path.join(process.cwd(), "public");
app.use("/engines", express.static(path.join(publicDir, "engines")));

// -------------------- Progress --------------------
type ProgressStage = "queued" | "preparing" | "evaluating" | "postprocess" | "done";
type Progress = {
  id: string;
  total: number;
  done: number;
  percent?: number;
  etaMs?: number;
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
      stage: "queued",
      startedAt: now,
      updatedAt: now,
    };
    PROGRESS.set(id, p);
  }
  res.json(p);
});

// -------------------- helpers: ratings normalization --------------------
type PlayersRatings = { white?: number; black?: number };
function normalizePlayersRatings(src: any): PlayersRatings | undefined {
  if (!src || typeof src !== "object") return undefined;

  const pr =
    src.playersRatings && typeof src.playersRatings === "object"
      ? src.playersRatings
      : src;

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

type EvaluateGameParamsExt = EvaluateGameParams & { playersRatings?: PlayersRatings };

// -------------------- NATIVE UCI ENGINE --------------------
type UciLine = { pv: string[]; cp?: number; mate?: number; depth?: number; multiPv?: number };
type UciPosEval = { lines: UciLine[]; bestMove?: string };

type EvaluatePositionWithUpdateParamsExt = EvaluatePositionWithUpdateParams & {
  threads?: number;
  hashMb?: number;
  syzygyPath?: string;
};

class NativeUciEngine {
  constructor(private readonly binPath: string) {
    if (!binPath) throw new Error("ENGINE_PATH/STOCKFISH_PATH is not set");
  }

  private send(proc: ChildProcessWithoutNullStreams, cmd: string) {
    proc.stdin.write(cmd + "\n");
  }

  private parseInfoLine(s: string): UciLine | null {
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
    const line: UciLine = { pv, depth, multiPv };
    if (typeof mate === "number") line.mate = mate;
    if (typeof cp === "number") line.cp = cp;
    return line;
  }

  async evaluatePositionWithUpdate(params: EvaluatePositionWithUpdateParamsExt): Promise<UciPosEval> {
    const { fen, depth, multiPv } = params;
    const proc = spawn(this.binPath, [], { stdio: ["pipe", "pipe", "pipe"] });

    const lines: Record<number, UciLine> = {};
    let bestMove: string | undefined;

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const raw of text.split(/\r?\n/)) {
        const s = raw.trim();
        if (!s) continue;
        if (s.startsWith("info ")) {
          const m = this.parseInfoLine(s);
          if (m?.multiPv) lines[m.multiPv] = m;
        } else if (s.startsWith("bestmove ")) {
          const parts = s.split(/\s+/);
          bestMove = parts[1];
        }
      }
    };

    proc.stdout.on("data", onData);
    proc.stderr.on("data", (b) => log.debug({ engineErr: String(b) }));

    this.send(proc, "uci");
    if (Number.isFinite(params.threads)) this.send(proc, `setoption name Threads value ${params.threads}`);
    if (Number.isFinite(params.hashMb)) this.send(proc, `setoption name Hash value ${params.hashMb}`);
    if (params.syzygyPath) this.send(proc, `setoption name SyzygyPath value ${params.syzygyPath}`);
    this.send(proc, `setoption name MultiPV value ${Math.max(1, multiPv || 1)}`);
    this.send(proc, "isready");
    this.send(proc, "ucinewgame");
    this.send(proc, `position fen ${fen}`);
    this.send(proc, `go depth ${Math.max(1, depth || DEFAULT_DEPTH)} multipv ${Math.max(1, multiPv || 1)}`);

    await new Promise<void>((resolve) => {
      const handler = (chunk: Buffer) => {
        if (chunk.toString("utf8").includes("bestmove")) {
          proc.stdout.off("data", handler);
          resolve();
        }
      };
      proc.stdout.on("data", handler);
    });

    try { proc.stdin.end("quit\n"); } catch {}
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 150);

    const ordered = Object.values(lines).sort((a, b) => (a.multiPv! - b.multiPv!));
    return { lines: ordered, bestMove };
  }

  async evaluateGame(params: EvaluateGameParams, onProgress?: (percent: number) => void): Promise<GameEval> {
    const { fens, depth, multiPv } = params;
    const outPositions: any[] = [];
    const total = fens.length;
    for (let i = 0; i < total; i++) {
      const fen = fens[i];
      const r = await this.evaluatePositionWithUpdate({
        fen,
        depth: Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH,
        multiPv: Number.isFinite(multiPv) ? Number(multiPv) : DEFAULT_MULTIPV,
      });
      outPositions.push({ ...r });
      if (onProgress) onProgress(((i + 1) / total) * 100);
    }

    const gameEval: GameEval = {
      positions: outPositions,
      acpl: { white: 0, black: 0 },
      settings: {
        engine: "stockfish-native",
        depth: Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH,
        multiPv: Number.isFinite(multiPv) ? Number(multiPv) : DEFAULT_MULTIPV,
      } as any,
    } as any;

    return gameEval;
  }

  static async create(): Promise<NativeUciEngine> {
    const candidate = path.resolve(ENGINE_PATH);
    if (!fs.existsSync(candidate)) {
      throw new Error(`Stockfish binary not found at ENGINE_PATH=${candidate}`);
    }
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch {
      log.warn(`Binary at ${candidate} may not be executable. Run: chmod +x "${candidate}"`);
    }
    return new NativeUciEngine(candidate);
  }
}

// -------------------- position eval --------------------
app.post("/api/evaluate/position", async (req, res) => {
  try {
    const { fen, depth, multiPv } = req.body ?? {};
    if (!fen || typeof fen !== "string") {
      return res.status(400).json({ error: "fen_required" });
    }
    const engine = await getEngine();
    const params: EvaluatePositionWithUpdateParams = {
      fen,
      depth: Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH,
      multiPv: Number.isFinite(multiPv) ? Number(multiPv) : DEFAULT_MULTIPV,
    };
    const finalEval = await engine.evaluatePositionWithUpdate(params);
    res.json(finalEval);
  } catch (e: any) {
    res.status(500).json({ error: "evaluate_position_failed", details: String(e?.message ?? e) });
  }
});

app.post("/api/v1/evaluate/position", (req, res) => {
  (app as any)._router.handle(
    { ...req, url: "/api/evaluate/position", originalUrl: "/api/evaluate/position" },
    res,
    () => {}
  );
});

// -------------------- game eval with progress --------------------
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
      Number.isFinite(body.depth) ? Number(body.depth) :
      Number.isFinite(depthQ) ? depthQ : DEFAULT_DEPTH;
    const multiPv =
      Number.isFinite(body.multiPv) ? Number(body.multiPv) :
      Number.isFinite(multiPvQ) ? multiPvQ : DEFAULT_MULTIPV;

    if (!Array.isArray(fens) || fens.length < 2) {
      if (progressId) setProgress(progressId, { stage: "done" });
      return res.status(400).json({ error: "invalid_fens" });
    }

    const engine = await getEngine();
    if (progressId) setProgress(progressId, { stage: "evaluating", done: 0 });

    const playersRatings = normalizePlayersRatings(body);

    const params: EvaluateGameParamsExt = {
      fens,
      uciMoves,
      depth,
      multiPv,
      workersNb: Number.isFinite(body.workersNb) ? Number(body.workersNb) : 1,
      playersRatings,
    };

    const onProgress =
      progressId && fens.length > 0
        ? (p: number) => {
            const done = Math.max(0, Math.min(fens.length, Math.round((p / 100) * fens.length)));
            setProgress(progressId, { done, stage: "evaluating" });
          }
        : undefined;

    const out: GameEval = await engine.evaluateGame(params, onProgress);

    if (progressId) setProgress(progressId, { stage: "postprocess", done: fens.length });

    // ---------- client models ----------
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
        // критично: если нет ни cp, ни mate — ставим cp:0
        const cpFixed = cpVal == null && mateVal == null ? 0 : cpVal;
        return { pv, cp: cpFixed, mate: mateVal };
      });

      // если нет ни одной линии — создаём заглушку
      if (lines.length === 0) {
        lines.push({ pv: [], cp: 0, best: "" });
      }

      // лучший ход для первой линии (если известен)
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

    const winPercents: number[] = (positions as any[]).map((p: any) => {
      const first = p?.lines?.[0];
      const hasEval =
        first && (typeof first.cp === "number" || typeof first.mate === "number");
      return hasEval ? getPositionWinPercentage(p as any) : 50;
    });

    const { white, black } = computeAccuracyStrict(winPercents);
    const accuracy = {
      whiteMovesAcc: {
        itera: white.itera,
        harmonic: white.harmonic,
        weighted: white.weighted,
      },
      blackMovesAcc: {
        itera: black.itera,
        harmonic: black.harmonic,
        weighted: black.weighted,
      },
    };

    const classifiedPositions: any[] = getMovesClassification(
      positions as any,
      uciMoves,
      fens
    ) as any[];

    const moves = buildMoveReports({
      fens,
      uciMoves,
      winPercents,
      perMoveAcc: perMoveAccFromWinPercents(winPercents),
      classified: classifiedPositions,
    });

    const acpl = out.acpl ?? { white: 0, black: 0 };
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

    if (progressId) setProgress(progressId, { stage: "done", done: fens.length });
    res.json(fullReport);
  } catch (e: any) {
    if (progressId) setProgress(progressId, { stage: "done" });
    res.status(500).json({
      error: "evaluate_game_failed",
      details: String(e?.message ?? e),
    });
  }
});

// -------------------- game eval by PGN --------------------
app.post("/api/evaluate/game", async (req, res) => {
  try {
    const { pgn, depth, multiPv, workersNb } = req.body ?? {};
    if (!pgn || typeof pgn !== "string") {
      return res.status(400).json({ error: "pgn_required" });
    }
    const { fens, uciMoves } = pgnToFenAndUci(pgn);
    const engine = await getEngine();

    const playersRatings = normalizePlayersRatings(req.body);

    const params: EvaluateGameParamsExt = {
      fens,
      uciMoves,
      depth: Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH,
      multiPv: Number.isFinite(multiPv) ? Number(multiPv) : DEFAULT_MULTIPV,
      workersNb: Number.isFinite(workersNb) ? Number(workersNb) : 1,
      playersRatings,
    };

    const out: GameEval = await engine.evaluateGame(params);
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: "evaluate_game_failed", details: String(e?.message ?? e) });
  }
});

// -------------------- pgn→fens --------------------
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

// -------------------- engine lifecycle --------------------
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
      const eng = await NativeUciEngine.create();
      const adapted: EngineIface = {
        evaluatePositionWithUpdate: (p) =>
          eng.evaluatePositionWithUpdate(p as EvaluatePositionWithUpdateParamsExt),
        evaluateGame: (p, onProgress) => eng.evaluateGame(p, onProgress),
      };
      engineInstance = adapted;
      return adapted;
    })();
  }
  return enginePromise;
}

// -------------------- helpers for client models --------------------
function perMoveAccFromDeltaWin(delta: number): number {
  const raw =
    103.1668100711649 * Math.exp(-0.04354415386753951 * delta) -
    3.166924740191411;
  return Math.min(100, Math.max(0, raw + 1));
}
function perMoveAccFromConsecutiveWinPercents(
  prev: number,
  cur: number,
  isWhiteMove: boolean
) {
  const loss = isWhiteMove ? Math.max(0, prev - cur) : Math.max(0, cur - prev);
  return perMoveAccFromDeltaWin(loss);
}
function perMoveAccFromWinPercents(winPercents: number[]): number[] {
  const acc: number[] = [];
  for (let i = 1; i < winPercents.length; i++) {
    const isWhiteMove = (i - 1) % 2 === 0;
    acc.push(
      perMoveAccFromConsecutiveWinPercents(
        winPercents[i - 1],
        winPercents[i],
        isWhiteMove
      )
    );
  }
  return acc;
}

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

    const clsRaw: MoveClassification | string | undefined =
      classified[i + 1]?.moveClassification;
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

// 404
app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: `${req.method} ${req.originalUrl}` });
});

app.listen(PORT, () => {
  const mode = detectSpawnMode(ENGINE_PATH);
  log.info(`Server http://localhost:${PORT} | Engine=${ENGINE_NAME} | Mode=${mode} | Bin=${ENGINE_PATH}`);
});
