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
const enums_1 = require("../types/enums");
const uciEngine_1 = require("./engine/uciEngine");
const PORT = Number(process.env.PORT ?? 8080);
const ENGINE_NAME = process.env.ENGINE_NAME ?? enums_1.EngineName.Stockfish17Lite;
const DEFAULT_DEPTH = Number(process.env.ENGINE_DEPTH ?? 16);
const DEFAULT_MULTIPV = Number(process.env.ENGINE_MULTIPV ?? 3);
const CPU_CORES = Math.max(1, node_os_1.default.cpus()?.length ?? 1);
const ENGINE_THREADS = Math.max(1, Number(process.env.ENGINE_THREADS ?? CPU_CORES));
const ENGINE_HASH_MB = Math.max(16, Number(process.env.ENGINE_HASH_MB ?? 256));
const ENGINE_WORKERS_MAX = Math.max(1, Number(process.env.ENGINE_WORKERS_MAX ?? CPU_CORES));
const ENGINE_MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.ENGINE_MAX_CONCURRENT_JOBS ?? Math.ceil(CPU_CORES / 2)));
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
async function evaluateGameParallel(params, requestedWorkers, onProgress) {
    const fens = Array.isArray(params.fens) ? params.fens : [];
    const total = fens.length;
    if (total === 0) {
        return {
            positions: [],
            acpl: { white: 0, black: 0 },
            settings: {
                engine: "stockfish-native",
                depth: params.depth ?? DEFAULT_DEPTH,
                multiPv: params.multiPv ?? DEFAULT_MULTIPV,
            },
        };
    }
    const effectiveWorkers = Math.max(1, Math.min(ENGINE_WORKERS_MAX, Math.floor(requestedWorkers) || 1));
    log.info({ effectiveWorkers, total }, "Starting parallel evaluation");
    const results = new Array(total);
    let completed = 0;
    const workerPool = await Promise.all(Array.from({ length: effectiveWorkers }, () => createEngineInstance({
        threads: Math.max(1, Math.floor(ENGINE_THREADS / effectiveWorkers)),
        hashMb: Math.max(16, Math.floor(ENGINE_HASH_MB / effectiveWorkers)),
        multiPv: params.multiPv ?? DEFAULT_MULTIPV,
    })));
    try {
        const tasks = fens.map((fen, idx) => async () => {
            const worker = workerPool[idx % effectiveWorkers];
            const evaluated = await worker.evaluateGame({
                fens: [fen],
                depth: params.depth ?? DEFAULT_DEPTH,
                multiPv: params.multiPv ?? DEFAULT_MULTIPV,
                useNNUE: params.useNNUE,
                elo: params.elo,
                skillLevel: params.skillLevel,
            }, undefined);
            results[idx] = evaluated.positions[0];
            completed++;
            if (onProgress) {
                const pct = Math.round((completed / total) * 100);
                onProgress(pct);
            }
        });
        const concurrency = effectiveWorkers;
        const executing = [];
        for (const task of tasks) {
            const p = task();
            executing.push(p);
            if (executing.length >= concurrency) {
                await Promise.race(executing);
                executing.splice(executing.findIndex((e) => e === p), 1);
            }
        }
        await Promise.all(executing);
        log.info({ completed: results.length }, "Parallel evaluation complete");
        return {
            positions: results,
            acpl: { white: 0, black: 0 },
            settings: {
                engine: "stockfish-native",
                depth: params.depth ?? DEFAULT_DEPTH,
                multiPv: params.multiPv ?? DEFAULT_MULTIPV,
            },
        };
    }
    finally {
        for (const worker of workerPool) {
            if (typeof worker.shutdown === "function") {
                try {
                    worker.shutdown();
                }
                catch (e) {
                    log.warn({ err: e }, "Worker shutdown error");
                }
            }
        }
    }
}
app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: Date.now() });
});
app.get("/api/v1/progress/:id", (req, res) => {
    const id = String(req.params.id);
    const p = PROGRESS.get(id);
    if (!p) {
        return res.status(404).json({ error: "progress_not_found" });
    }
    return res.json(p);
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
        const depthQ = Number(req.query?.depth);
        const multiPvQ = Number(req.query?.multiPv);
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
            useNNUE: body.useNNUE,
            elo: body.elo,
            skillLevel: body.skillLevel,
        };
        const result = await jobQueue.enqueue(async () => {
            if (progressId)
                setProgress(progressId, { stage: "evaluating", done: 0 });
            const out = await evaluateGameParallel(baseParams, Number(body.workersNb ?? 0), (p) => {
                if (progressId) {
                    const done = Math.max(0, Math.min(fens.length, Math.round((p / 100) * fens.length)));
                    const currentFen = done > 0 && done <= fens.length ? fens[done - 1] : undefined;
                    const currentUci = done > 0 && done <= uciMoves.length ? uciMoves[done - 1] : undefined;
                    setProgress(progressId, {
                        done,
                        stage: "evaluating",
                        fen: currentFen,
                        currentUci: currentUci,
                    });
                }
            });
            if (progressId)
                setProgress(progressId, { stage: "done", done: fens.length });
            return {
                positions: out.positions,
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
app.use((req, res) => {
    res
        .status(404)
        .json({ error: "not_found", path: `${req.method} ${req.originalUrl}` });
});
app.listen(PORT, () => {
    log.info(`Server http://localhost:${PORT}`);
});
//# sourceMappingURL=lichess.js.map