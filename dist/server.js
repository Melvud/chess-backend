"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const pino_1 = __importDefault(require("pino"));
const pino_http_1 = __importDefault(require("pino-http"));
const enums_1 = require("./types/enums");
const uciEngine_1 = require("./lib/engine/uciEngine");
const PORT = Number(process.env.PORT ?? 8080);
const ENGINE_NAME = process.env.ENGINE_NAME ?? enums_1.EngineName.Stockfish17Lite;
const DEFAULT_DEPTH = Number(process.env.ENGINE_DEPTH ?? 16);
const DEFAULT_MULTIPV = Number(process.env.ENGINE_MULTIPV ?? 3);
const CPU_CORES = Math.max(1, node_os_1.default.cpus()?.length ?? 1);
const ENGINE_THREADS = Math.max(1, Number(process.env.ENGINE_THREADS ?? Math.min(8, CPU_CORES)));
const ENGINE_HASH_MB = Math.max(16, Number(process.env.ENGINE_HASH_MB ?? 2048));
const ENGINE_WORKERS_MAX = Math.max(1, Number(process.env.ENGINE_WORKERS_MAX ?? Math.min(4, Math.floor(CPU_CORES / 2))));
const ENGINE_MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.ENGINE_MAX_CONCURRENT_JOBS ?? 2));
const app = (0, express_1.default)();
const log = (0, pino_1.default)({ level: process.env.LOG_LEVEL ?? "info" });
app.use((0, cors_1.default)({
    origin: (_o, cb) => cb(null, true),
    credentials: true,
}));
app.use(express_1.default.json({ limit: "10mb" }));
app.use((0, pino_http_1.default)({
    logger: log,
    customProps: () => ({ srv: "chess-backend" }),
}));
const publicDir = node_path_1.default.join(process.cwd(), "public");
app.use("/engines", express_1.default.static(node_path_1.default.join(publicDir, "engines")));
const PROGRESS = new Map();
function initProgress(id, total) {
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
function setProgress(id, upd) {
    const prev = PROGRESS.get(id);
    if (!prev)
        return;
    const now = Date.now();
    const next = { ...prev, ...upd, updatedAt: now };
    if (next.total > 0) {
        next.percent = Math.max(0, Math.min(100, (next.done / next.total) * 100));
    }
    PROGRESS.set(id, next);
}
let singletonEngine = null;
async function createEngineInstance(opts) {
    const eng = await uciEngine_1.UciEngine.create(ENGINE_NAME, "");
    try {
        const threads = Math.max(1, Math.floor(opts?.threads ?? ENGINE_THREADS));
        const hashMb = Math.max(16, Math.floor(opts?.hashMb ?? ENGINE_HASH_MB));
        const multiPv = Math.max(1, Math.floor(opts?.multiPv ?? DEFAULT_MULTIPV));
        if (typeof eng.setOption === "function") {
            await eng.setOption("Threads", threads);
            await eng.setOption("Hash", hashMb);
            await eng.setOption("Ponder", false);
            await eng.setOption("MultiPV", multiPv);
        }
    }
    catch { }
    return eng;
}
async function getSingletonEngine() {
    if (singletonEngine)
        return singletonEngine;
    singletonEngine = await createEngineInstance({
        threads: ENGINE_THREADS,
        hashMb: ENGINE_HASH_MB,
        multiPv: DEFAULT_MULTIPV,
    });
    return singletonEngine;
}
class AsyncQueue {
    concurrency;
    running = 0;
    q = [];
    constructor(concurrency) {
        this.concurrency = Math.max(1, concurrency);
    }
    enqueue(task) {
        return new Promise((resolve, reject) => {
            const run = () => {
                this.running++;
                task()
                    .then(resolve)
                    .catch(reject)
                    .finally(() => {
                    this.running--;
                    const next = this.q.shift();
                    if (next)
                        next();
                });
            };
            if (this.running < this.concurrency)
                run();
            else
                this.q.push(run);
        });
    }
}
const jobQueue = new AsyncQueue(ENGINE_MAX_CONCURRENT_JOBS);
async function evaluateGameParallel(baseParams, workersRequested, progressId, onProgress) {
    const fens = baseParams.fens ?? [];
    const uciMoves = baseParams.uciMoves ?? [];
    const total = fens.length;
    const startTime = Date.now();
    const requested = Number(workersRequested);
    let workers;
    if (total <= 20) {
        workers = 1;
    }
    else if (total <= 40) {
        workers = Math.min(2, ENGINE_WORKERS_MAX);
    }
    else {
        workers = Number.isFinite(requested) && requested > 0
            ? Math.min(Math.max(1, Math.floor(requested)), ENGINE_WORKERS_MAX)
            : ENGINE_WORKERS_MAX;
    }
    log.info({ workers, total, depth: baseParams.depth }, "Starting parallel evaluation");
    if (workers === 1) {
        const eng = await getSingletonEngine();
        const result = await eng.evaluateGame(baseParams, onProgress);
        const elapsed = Date.now() - startTime;
        log.info({ elapsed, msPerMove: Math.round(elapsed / total) }, "Evaluation complete");
        return result;
    }
    const threadsPer = Math.max(1, Math.floor(ENGINE_THREADS / workers));
    const hashPer = Math.max(128, Math.floor(ENGINE_HASH_MB / workers));
    const multiPvPer = baseParams.multiPv ?? DEFAULT_MULTIPV;
    const indexes = Array.from({ length: workers }, () => []);
    for (let i = 0; i < total; i++)
        indexes[i % workers].push(i);
    const perWorkerDone = new Array(workers).fill(0);
    const reportProgress = () => {
        if (!onProgress)
            return;
        const done = perWorkerDone.reduce((a, b) => a + b, 0);
        const pct = Math.min(100, (done / Math.max(1, total)) * 100);
        onProgress(pct);
    };
    const tasks = indexes.map(async (idxs, wi) => {
        if (idxs.length === 0)
            return { positions: [], settings: {} };
        const shardFens = idxs.map((i) => baseParams.fens[i]);
        const shardUci = idxs.map((i) => baseParams.uciMoves[i]);
        const eng = await createEngineInstance({
            threads: threadsPer,
            hashMb: hashPer,
            multiPv: multiPvPer,
        });
        const onShardProgress = (p) => {
            const shardDone = Math.round((p / 100) * shardFens.length);
            if (shardDone > perWorkerDone[wi]) {
                perWorkerDone[wi] = shardDone;
                reportProgress();
                if (progressId && shardDone > 0 && shardDone <= shardFens.length) {
                    const currentIdx = idxs[shardDone - 1];
                    const currentFen = currentIdx < fens.length ? fens[currentIdx] : undefined;
                    const currentUci = currentIdx < uciMoves.length ? uciMoves[currentIdx] : undefined;
                    setProgress(progressId, {
                        fen: currentFen,
                        currentUci: currentUci,
                    });
                }
            }
        };
        const out = await eng.evaluateGame({ ...baseParams, fens: shardFens, uciMoves: shardUci }, onShardProgress);
        const positionsWithIdx = out.positions.map((pos, k) => ({
            __idx: idxs[k],
            ...pos,
        }));
        return { ...out, positions: positionsWithIdx };
    });
    const shards = await Promise.all(tasks);
    await Promise.allSettled(tasks.map(async (_, wi) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                try {
                    const worker = shards[wi]?.__engine;
                    if (worker && typeof worker.shutdown === "function") {
                        worker.shutdown();
                    }
                }
                catch (e) {
                    log.warn({ err: String(e), worker: wi }, "Worker shutdown warning");
                }
                resolve();
            }, 50);
        });
    }));
    const positionsMerged = new Array(total);
    for (const s of shards)
        for (const p of s.positions) {
            positionsMerged[p.__idx] = { fen: p.fen, idx: p.idx, lines: p.lines };
        }
    const first = shards.find((s) => Array.isArray(s.positions) && s.positions.length > 0);
    const settings = first?.settings ?? {};
    const elapsed = Date.now() - startTime;
    log.info({ elapsed, msPerMove: Math.round(elapsed / total), workers }, "Parallel evaluation complete");
    return { positions: positionsMerged, settings };
}
function toClientPosition(posAny, fen, idx) {
    const rawLines = Array.isArray(posAny?.lines) ? posAny.lines : [];
    const lines = rawLines.map((l) => {
        const pv = Array.isArray(l?.pv)
            ? l.pv
            : Array.isArray(l?.pv?.moves)
                ? l.pv.moves
                : [];
        const cpVal = typeof l?.cp === "number" ? l.cp : undefined;
        const mateVal = typeof l?.mate === "number" ? l.mate : undefined;
        return { pv, cp: cpVal, mate: mateVal };
    });
    if (lines.length === 0) {
        lines.push({ pv: [], cp: 0 });
    }
    const firstPv = lines[0]?.pv;
    const best = posAny?.bestMove ??
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
app.post("/api/v1/evaluate/positions", async (req, res) => {
    const progressId = String(req.query?.progressId ?? req.body?.progressId ?? "");
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
            if (progressId)
                setProgress(progressId, { stage: "done" });
            return res.status(400).json({ error: "invalid_fens" });
        }
        const baseParams = {
            fens,
            uciMoves,
            depth,
            multiPv,
            ...(body.useNNUE !== undefined ? { useNNUE: body.useNNUE } : {}),
            ...(body.elo !== undefined ? { elo: body.elo } : {}),
            ...(body.skillLevel !== undefined ? { skillLevel: body.skillLevel } : {}),
        };
        const result = await jobQueue.enqueue(async () => {
            if (progressId)
                setProgress(progressId, { stage: "evaluating", done: 0 });
            const out = await evaluateGameParallel(baseParams, Number(body.workersNb ?? 0), progressId || null, (p) => {
                if (progressId) {
                    const done = Math.floor((p / 100) * fens.length);
                    setProgress(progressId, {
                        done: Math.min(done, fens.length),
                        stage: "evaluating"
                    });
                }
            });
            if (progressId)
                setProgress(progressId, { stage: "done", done: fens.length });
            const positions = fens.map((fen, idx) => {
                const posAny = out.positions[idx] ?? {};
                return toClientPosition(posAny, fen, idx);
            });
            return {
                positions,
                settings: {
                    engine: out?.settings?.engine ?? "stockfish-native",
                    depth: out?.settings?.depth ?? depth,
                    multiPv: out?.settings?.multiPv ?? multiPv,
                },
            };
        });
        return res.json(result);
    }
    catch (e) {
        if (progressId)
            setProgress(progressId, { stage: "done" });
        log.error({ err: e }, "Evaluation failed");
        return res.status(500).json({
            error: "evaluate_positions_failed",
            details: String(e?.message ?? e),
        });
    }
});
app.post("/api/v1/evaluate/position", async (req, res) => {
    try {
        const { fen, depth, multiPv, useNNUE, elo, skillLevel } = req.body ?? {};
        if (!fen || typeof fen !== "string") {
            return res.status(400).json({ error: "fen_required" });
        }
        const engine = await getSingletonEngine();
        const params = {
            fen,
            depth: Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH,
            multiPv: Number.isFinite(multiPv) ? Number(multiPv) : DEFAULT_MULTIPV,
            useNNUE,
            elo,
            ...(skillLevel !== undefined ? { skillLevel } : {}),
        };
        const finalEval = await engine.evaluatePositionWithUpdate(params);
        return res.json(finalEval);
    }
    catch (e) {
        return res.status(500).json({
            error: "evaluate_position_failed",
            details: String(e?.message ?? e),
        });
    }
});
app.use((req, res) => {
    res
        .status(404)
        .json({ error: "not_found", path: `${req.method} ${req.originalUrl}` });
});
(async () => {
    try {
        log.info("🔥 Warming up engine...");
        const warmupEngine = await createEngineInstance({
            threads: ENGINE_THREADS,
            hashMb: ENGINE_HASH_MB,
            multiPv: 1,
        });
        await warmupEngine.evaluatePositionWithUpdate({
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            depth: 10,
            multiPv: 1,
        });
        log.info("✅ Engine warmed up and ready");
        singletonEngine = warmupEngine;
    }
    catch (e) {
        log.warn({ err: e }, "⚠️  Engine warmup failed, will initialize on first request");
    }
})();
app.listen(PORT, () => {
    log.info({
        port: PORT,
        threads: ENGINE_THREADS,
        hashMB: ENGINE_HASH_MB,
        maxWorkers: ENGINE_WORKERS_MAX
    }, "🚀 Server started");
});
if (process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === "production") {
    const KEEP_ALIVE_INTERVAL = 5 * 60 * 1000;
    setInterval(() => {
        fetch(`http://localhost:${PORT}/health`)
            .then(() => log.debug("Keep-alive ping successful"))
            .catch((e) => log.warn({ err: String(e) }, "Keep-alive ping failed"));
    }, KEEP_ALIVE_INTERVAL);
    log.info("💚 Keep-alive enabled (Railway optimization)");
}
//# sourceMappingURL=server.js.map