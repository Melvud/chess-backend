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
const chess_js_1 = require("chess.js");
const enums_1 = require("./types/enums");
const estimateElo_1 = require("./lib/engine/helpers/estimateElo");
const moveClassification_1 = require("./lib/engine/helpers/moveClassification");
const winPercentage_1 = require("./lib/engine/helpers/winPercentage");
const math_1 = require("./lib/math");
const uciEngine_1 = require("./lib/engine/uciEngine");
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
function normalizePlayersRatings(src) {
    if (!src || typeof src !== "object")
        return undefined;
    const pr = src.playersRatings && typeof src.playersRatings === "object"
        ? src.playersRatings
        : src;
    const w = Number.isFinite(pr.white)
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
    const b = Number.isFinite(pr.black)
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
async function evaluateGameParallel(baseParams, workersRequested, onProgress) {
    const fens = baseParams.fens ?? [];
    const total = fens.length;
    const requested = Number(workersRequested);
    const workers = Number.isFinite(requested) && requested > 0
        ? Math.min(Math.max(1, Math.floor(requested)), ENGINE_WORKERS_MAX)
        : ENGINE_WORKERS_MAX;
    if (workers === 1 || total <= 2) {
        const eng = await getSingletonEngine();
        return eng.evaluateGame(baseParams, onProgress);
    }
    const threadsPer = Math.max(1, Math.floor(ENGINE_THREADS / workers));
    const hashPer = Math.max(16, Math.floor(ENGINE_HASH_MB / workers));
    const multiPvPer = baseParams.multiPv ?? DEFAULT_MULTIPV;
    const indexes = Array.from({ length: workers }, () => []);
    for (let i = 0; i < total; i++)
        indexes[i % workers].push(i);
    const perWorkerDone = new Array(workers).fill(0);
    const reportProgress = () => {
        if (!onProgress)
            return;
        const done = perWorkerDone.reduce((a, b) => a + b, 0);
        onProgress(Math.min(100, (done / Math.max(1, total)) * 100));
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
            const delta = Math.max(0, shardDone - perWorkerDone[wi]);
            if (delta > 0) {
                perWorkerDone[wi] += delta;
                reportProgress();
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
    const positionsMerged = new Array(total);
    for (const s of shards)
        for (const p of s.positions) {
            positionsMerged[p.__idx] = { fen: p.fen, idx: p.idx, lines: p.lines };
        }
    const first = shards.find((s) => Array.isArray(s.positions) && s.positions.length > 0);
    const settings = first?.settings ?? {};
    return { positions: positionsMerged, settings };
}
function getPositionCp(position) {
    const line = position.lines[0];
    if (line.cp !== undefined) {
        return (0, math_1.ceilsNumber)(line.cp, -1000, 1000);
    }
    if (line.mate !== undefined) {
        return (0, math_1.ceilsNumber)(line.mate * 1000, -1000, 1000);
    }
    return 0;
}
function computeACPL(positions) {
    const whitePositions = [];
    const blackPositions = [];
    positions.forEach((pos, idx) => {
        if (idx % 2 === 0) {
            whitePositions.push(pos);
        }
        else {
            blackPositions.push(pos);
        }
    });
    const whiteCplValues = [];
    for (let i = 0; i < whitePositions.length - 1; i++) {
        const currentCp = getPositionCp(whitePositions[i]);
        const nextCp = getPositionCp(whitePositions[i + 1]);
        const loss = Math.max(0, currentCp - nextCp);
        whiteCplValues.push(Math.min(loss, 1000));
    }
    const blackCplValues = [];
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
function rawMoveAccuracy(winDiff) {
    const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * winDiff) -
        3.166924740191411;
    return Math.min(100, Math.max(0, raw + 1));
}
function getMovesAccuracy(winPercents) {
    return winPercents.slice(1).map((winPercent, index) => {
        const lastWinPercent = winPercents[index];
        const isWhiteMove = index % 2 === 0;
        const winDiff = isWhiteMove
            ? Math.max(0, lastWinPercent - winPercent)
            : Math.max(0, winPercent - lastWinPercent);
        return rawMoveAccuracy(winDiff);
    });
}
function getAccuracyWeights(winPercents) {
    const windowSize = (0, math_1.ceilsNumber)(Math.ceil(winPercents.length / 10), 2, 8);
    const windows = [];
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
        const std = (0, math_1.getStandardDeviation)(window);
        return (0, math_1.ceilsNumber)(std, 0.5, 12);
    });
}
function getPlayerAccuracy(movesAcc, weights, player) {
    const remainder = player === "white" ? 0 : 1;
    const playerAcc = movesAcc.filter((_, idx) => idx % 2 === remainder);
    const playerWeights = weights.filter((_, idx) => idx % 2 === remainder);
    if (playerAcc.length === 0)
        return 0;
    const weighted = (0, math_1.getWeightedMean)(playerAcc, playerWeights);
    const harmonic = (0, math_1.getHarmonicMean)(playerAcc);
    return (weighted + harmonic) / 2;
}
function computeAccuracy(positions) {
    const positionsWinPercentage = positions.map(p => (0, winPercentage_1.getPositionWinPercentage)(p));
    const weights = getAccuracyWeights(positionsWinPercentage);
    const movesAccuracy = getMovesAccuracy(positionsWinPercentage);
    const whiteAccuracy = getPlayerAccuracy(movesAccuracy, weights, "white");
    const blackAccuracy = getPlayerAccuracy(movesAccuracy, weights, "black");
    return {
        white: whiteAccuracy,
        black: blackAccuracy,
    };
}
function toClientMoveClass(cls) {
    const v = typeof cls === "string" ? cls : cls?.toString?.() ?? "";
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
function normUci(u) {
    const s = String(u || "").trim().toLowerCase();
    if (s.length === 4)
        return s + "q";
    return s;
}
function toClientPosition(posAny, fen, idx, isLastPosition, gameResult) {
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
        if (isLastPosition && gameResult && (gameResult === "1-0" || gameResult === "0-1")) {
            const mate = gameResult === "1-0" ? +1 : -1;
            lines.push({ pv: [], mate, best: "" });
        }
        else {
            lines.push({ pv: [], cp: 0, best: "" });
        }
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
function createMoveReport(uci, beforeFen, afterFen, winBefore, winAfter, moveAccuracy, classification, bestFromPosition) {
    const chess = new chess_js_1.Chess(beforeFen);
    const move = {
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
    };
    const m = chess.move(move);
    const san = m?.san ?? uci;
    let cls = toClientMoveClass(classification);
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
function analyzeGame(args) {
    const { engineOut, fens, uciMoves, depth, multiPv, gameResult } = args;
    const positions = fens.map((fen, idx) => {
        const posAny = engineOut.positions[idx] ?? {};
        const isLast = idx === fens.length - 1;
        return toClientPosition(posAny, fen, idx, isLast, gameResult);
    });
    const winPercents = positions.map((p) => {
        const first = p?.lines?.[0];
        const hasEval = first && (typeof first.cp === "number" || typeof first.mate === "number");
        return hasEval ? (0, winPercentage_1.getPositionWinPercentage)(p) : 50;
    });
    const movesAccuracy = getMovesAccuracy(winPercents);
    const classifiedPositions = (0, moveClassification_1.getMovesClassification)(positions, uciMoves, fens);
    const moves = [];
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
        const moveReport = createMoveReport(uci, beforeFen, afterFen, winBefore, winAfter, moveAcc, classification, bestFromPosition);
        moves.push(moveReport);
    }
    const accuracy = computeAccuracy(positions);
    const acpl = computeACPL(positions);
    const estRaw = (0, estimateElo_1.computeEstimatedElo)(positions, undefined, undefined);
    const toIntOrNull = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.round(n) : null;
    };
    const estimatedElo = estRaw
        ? {
            white: toIntOrNull(estRaw?.white),
            black: toIntOrNull(estRaw?.black),
        }
        : null;
    const settings = {
        engine: engineOut?.settings?.engine ?? "stockfish-native",
        depth: engineOut?.settings?.depth ?? depth,
        multiPv: engineOut?.settings?.multiPv ?? multiPv,
    };
    return {
        positions,
        moves,
        accuracy,
        acpl,
        estimatedElo,
        settings,
    };
}
function normalizePgnServer(src) {
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
        .filter((ch) => ch === "\n" || ch === "\t" || ch.codePointAt(0) >= 32)
        .join("");
    s = s.replace(/\n{3,}/g, "\n\n");
    s = s.replace(/\s+$/g, "");
    if (!s.endsWith("\n"))
        s += "\n";
    return s;
}
function splitHeaderAndMovetext(pgn) {
    const m = pgn.match(/^(?:\[[^\]\n]+\]\s*\n)+/);
    if (m) {
        const headerText = m[0].replace(/\n+$/g, "");
        const movetext = pgn.slice(m[0].length).replace(/^\s+/, "");
        return { headerText, movetext };
    }
    return { headerText: "", movetext: pgn.trimStart() };
}
function parseHeaderMap(headerText) {
    const map = {};
    const rx = /\[([A-Za-z0-9_]+)\s+"([^"]*)"\]/g;
    let m;
    while ((m = rx.exec(headerText)) !== null) {
        map[m[1]] = m[2];
    }
    return map;
}
function stripBalancedParentheses(s) {
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
        if (depth === 0)
            out += ch;
    }
    return out;
}
function tokenizeSanMovetext(raw) {
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
function pgnToFenAndUci(pgn) {
    const pgnFixed = normalizePgnServer(pgn);
    const { headerText, movetext } = splitHeaderAndMovetext(pgnFixed);
    const header = parseHeaderMap(headerText);
    const replay = new chess_js_1.Chess();
    if (header?.FEN && (header?.SetUp === "1" || header?.SetUp === "true")) {
        try {
            replay.load(header.FEN);
        }
        catch (e) {
            throw new Error(`Bad FEN in header: ${header.FEN}`);
        }
    }
    const fens = [replay.fen()];
    const uciMoves = [];
    const sanTokens = tokenizeSanMovetext(movetext);
    for (const san of sanTokens) {
        const move = replay.move(san, { sloppy: true });
        if (!move) {
            const beforeFen = fens[fens.length - 1] ?? "";
            throw new Error(`Invalid SAN during replay: ${JSON.stringify({
                san,
                before: beforeFen,
            })}`);
        }
        const uci = `${move.from}${move.to}${move.promotion ?? ""}`;
        uciMoves.push(uci);
        fens.push(replay.fen());
    }
    return { fens, uciMoves, header };
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
app.post("/api/v1/evaluate/position", async (req, res) => {
    try {
        const { fen, depth, multiPv, useNNUE, elo, skillLevel, beforeFen, afterFen, uciMove, } = req.body ?? {};
        const effDepth = Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH;
        const effMultiPv = Number.isFinite(multiPv)
            ? Number(multiPv)
            : DEFAULT_MULTIPV;
        if (typeof beforeFen === "string" &&
            typeof afterFen === "string" &&
            typeof uciMove === "string") {
            const baseParams = {
                fens: [String(beforeFen), String(afterFen)],
                uciMoves: [String(uciMove)],
                depth: effDepth,
                multiPv: effMultiPv,
                ...(useNNUE !== undefined ? { useNNUE } : {}),
                ...(elo !== undefined ? { elo } : {}),
                ...(skillLevel !== undefined ? { skillLevel } : {}),
            };
            const out = await evaluateGameParallel(baseParams, 1);
            const rawPositions = Array.isArray(out?.positions)
                ? out.positions
                : [];
            const fens2 = [String(beforeFen), String(afterFen)];
            const positions = fens2.map((fenStr, idx) => {
                const posAny = rawPositions[idx] ?? {};
                return toClientPosition(posAny, fenStr, idx, idx === 1);
            });
            try {
                const ch = new chess_js_1.Chess();
                ch.load(String(beforeFen));
                const from = String(uciMove).slice(0, 2);
                const to = String(uciMove).slice(2, 4);
                const prom = String(uciMove).slice(4) || undefined;
                const mv = ch.move({ from, to, promotion: prom });
                if (mv && ch.isCheckmate && ch.isCheckmate()) {
                    const moverIsWhite = String(beforeFen).includes(" w ");
                    const mateVal = moverIsWhite ? +1 : -1;
                    if (positions[1].lines.length === 0) {
                        positions[1].lines.push({ pv: [], mate: mateVal });
                    }
                    else {
                        positions[1].lines[0] = {
                            ...(positions[1].lines[0] || {}),
                            mate: mateVal,
                        };
                        delete positions[1].lines[0].cp;
                    }
                }
            }
            catch { }
            const needBestFix = !positions[0]?.lines?.[0]?.best ||
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
                    });
                    const rawTop = Array.isArray(eval0?.lines) ? eval0.lines[0] : undefined;
                    const bestFromEngine = eval0?.bestMove ??
                        (Array.isArray(rawTop?.pv) ? rawTop.pv[0] : undefined) ??
                        "";
                    if (bestFromEngine) {
                        positions[0].lines[0].best = String(bestFromEngine);
                        if (!Array.isArray(positions[0].lines[0].pv) || positions[0].lines[0].pv.length === 0) {
                            positions[0].lines[0].pv = [String(bestFromEngine)];
                        }
                    }
                }
                catch { }
            }
            const bestFromBefore = String(positions[0]?.lines?.[0]?.best ??
                positions[0]?.lines?.[0]?.pv?.[0] ??
                "") || undefined;
            const classified = (0, moveClassification_1.getMovesClassification)(positions, [String(uciMove)], [String(beforeFen), String(afterFen)]);
            const clsRaw = classified?.[1]?.moveClassification;
            const cls = toClientMoveClass(clsRaw);
            return res.json({
                lines: positions[1].lines,
                bestMove: bestFromBefore,
                moveClassification: cls,
            });
        }
        if (!fen || typeof fen !== "string") {
            return res.status(400).json({ error: "fen_required" });
        }
        const engine = await getSingletonEngine();
        const params = {
            fen,
            depth: Number.isFinite(depth) ? Number(depth) : undefined,
            multiPv: Number.isFinite(multiPv) ? Number(multiPv) : undefined,
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
app.post("/api/v1/evaluate/game/by-fens", async (req, res) => {
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
        if (!Array.isArray(fens) || fens.length < 2) {
            if (progressId)
                setProgress(progressId, { stage: "done" });
            return res.status(400).json({ error: "invalid_fens" });
        }
        const playersRatings = normalizePlayersRatings(body);
        const baseParams = {
            fens,
            uciMoves,
            depth,
            multiPv,
            playersRatings,
            ...(body.useNNUE !== undefined ? { useNNUE: body.useNNUE } : {}),
            ...(body.elo !== undefined ? { elo: body.elo } : {}),
            ...(body.skillLevel !== undefined ? { skillLevel: body.skillLevel } : {}),
        };
        const result = await jobQueue.enqueue(async () => {
            if (progressId)
                setProgress(progressId, { stage: "evaluating", done: 0 });
            const out = await evaluateGameParallel(baseParams, Number(body.workersNb ?? 0), (p) => {
                if (progressId) {
                    const done = Math.max(0, Math.min(fens.length, Math.round((p / 100) * fens.length)));
                    setProgress(progressId, { done, stage: "evaluating" });
                }
            });
            if (progressId)
                setProgress(progressId, {
                    stage: "postprocess",
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
                setProgress(progressId, { stage: "done", done: fens.length });
            return analysis;
        });
        return res.json(result);
    }
    catch (e) {
        if (progressId)
            setProgress(progressId, { stage: "done" });
        return res.status(500).json({
            error: "evaluate_game_failed",
            details: String(e?.message ?? e),
        });
    }
});
app.post("/api/v1/evaluate/game", async (req, res) => {
    const progressId = String(req.query?.progressId ?? req.body?.progressId ?? "");
    try {
        const { pgn, depth, multiPv, workersNb, useNNUE, elo, skillLevel } = req.body ?? {};
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
        const baseParams = {
            fens,
            uciMoves,
            depth: effDepth,
            multiPv: effMultiPv,
            playersRatings,
            useNNUE,
            elo,
            ...(skillLevel !== undefined ? { skillLevel } : {}),
        };
        const result = await jobQueue.enqueue(async () => {
            if (progressId)
                setProgress(progressId, { stage: "evaluating", done: 0 });
            const out = await evaluateGameParallel(baseParams, Number(workersNb ?? 0), (p) => {
                if (progressId) {
                    const done = Math.max(0, Math.min(fens.length, Math.round((p / 100) * fens.length)));
                    setProgress(progressId, { done, stage: "evaluating" });
                }
            });
            if (progressId)
                setProgress(progressId, {
                    stage: "postprocess",
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
                setProgress(progressId, { stage: "done", done: fens.length });
            return analysis;
        });
        return res.json(result);
    }
    catch (e) {
        if (progressId)
            setProgress(progressId, { stage: "done" });
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
//# sourceMappingURL=server.js.map