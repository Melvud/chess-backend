"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UciEngine = void 0;
const node_child_process_1 = require("node:child_process");
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const parseResults_1 = require("../engine/helpers/parseResults");
function parseInfoLineForProgress(s) {
    const get = (key) => {
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
    if (!multiPv)
        return null;
    const line = { pv, depth, multiPv };
    if (typeof mate === "number")
        line.mate = mate;
    if (typeof cp === "number")
        line.cp = cp;
    return line;
}
function waitForBestmove(proc) {
    return new Promise((resolve) => {
        const handler = (chunk) => {
            const str = chunk.toString("utf8");
            if (str.includes("bestmove")) {
                proc.stdout.off("data", handler);
                resolve();
            }
        };
        proc.stdout.on("data", handler);
    });
}
const ENGINE_PATH_ENV = process.env.STOCKFISH_PATH || process.env.STOCKFISH_BIN || "./bin/stockfish";
const ENGINE_PATH = resolveEnginePath(ENGINE_PATH_ENV);
const DEFAULT_DEPTH = Number.isFinite(Number(process.env.ENGINE_DEPTH))
    ? Number(process.env.ENGINE_DEPTH)
    : 16;
const DEFAULT_MULTIPV = Number.isFinite(Number(process.env.ENGINE_MULTIPV))
    ? Number(process.env.ENGINE_MULTIPV)
    : 3;
const CPU_COUNT = Math.max(1, node_os_1.default.cpus()?.length ?? 1);
const DEFAULT_THREADS = Math.max(1, CPU_COUNT);
const DEFAULT_HASH_MB = Number.isFinite(Number(process.env.ENGINE_HASH_MB))
    ? Number(process.env.ENGINE_HASH_MB)
    : 256;
const SKILL_LEVEL_MIN = 0;
const SKILL_LEVEL_MAX = 20;
function resolveEnginePath(p) {
    let bin = path.resolve(p);
    if (process.platform === "win32" && !bin.toLowerCase().endsWith(".exe")) {
        const withExe = `${bin}.exe`;
        if (fs.existsSync(withExe))
            bin = withExe;
    }
    return bin;
}
class UciEngine {
    currentProc = null;
    constructor() {
    }
    static async create(_engineName, _enginePublicPath) {
        const eng = new UciEngine();
        eng.ensureBinary();
        return eng;
    }
    ensureBinary() {
        const bin = ENGINE_PATH;
        if (!fs.existsSync(bin)) {
            throw new Error(`Stockfish binary not found at ${bin}. Set STOCKFISH_PATH / STOCKFISH_BIN.`);
        }
        try {
            fs.accessSync(bin, fs.constants.X_OK);
        }
        catch {
        }
    }
    spawnEngine() {
        const bin = ENGINE_PATH;
        const proc = (0, node_child_process_1.spawn)(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
        this.currentProc = proc;
        proc.on("exit", () => {
            if (this.currentProc === proc)
                this.currentProc = null;
        });
        proc.stderr.on("data", () => { });
        return proc;
    }
    send(proc, cmd) {
        proc.stdin.write(cmd + "\n");
    }
    async initSession(proc, opts) {
        const threads = Math.max(1, Number.isFinite(opts.threads) ? Number(opts.threads) : DEFAULT_THREADS);
        const hashMb = Math.max(16, Number.isFinite(opts.hashMb) ? Number(opts.hashMb) : DEFAULT_HASH_MB);
        const multiPv = Math.max(1, Number.isFinite(opts.multiPv) ? Number(opts.multiPv) : DEFAULT_MULTIPV);
        const useNNUE = typeof opts.useNNUE === "boolean" ? opts.useNNUE : undefined;
        const elo = Number(opts.elo);
        const hasElo = Number.isFinite(elo);
        const skill = clampToSkill(opts.skillLevel);
        this.send(proc, "uci");
        this.send(proc, `setoption name Threads value ${threads}`);
        this.send(proc, `setoption name Hash value ${hashMb}`);
        this.send(proc, `setoption name MultiPV value ${multiPv}`);
        if (opts.syzygyPath)
            this.send(proc, `setoption name SyzygyPath value ${opts.syzygyPath}`);
        if (typeof useNNUE === "boolean") {
            this.send(proc, `setoption name Use NNUE value ${useNNUE ? "true" : "false"}`);
        }
        if (typeof skill === "number") {
            this.send(proc, `setoption name UCI_LimitStrength value false`);
            this.send(proc, `setoption name Skill Level value ${skill}`);
        }
        else if (hasElo) {
            this.send(proc, `setoption name UCI_LimitStrength value true`);
            this.send(proc, `setoption name UCI_Elo value ${elo}`);
        }
        this.send(proc, "isready");
        this.send(proc, "ucinewgame");
    }
    async evaluateFenOnSession(proc, fen, depth, onDepth) {
        const lines = [];
        let lastReportDepth = 0;
        const onStdout = (chunk) => {
            const text = chunk.toString("utf8");
            for (const raw of text.split(/\r?\n/)) {
                const s = raw.trim();
                if (!s)
                    continue;
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
        this.send(proc, `position fen ${fen}`);
        this.send(proc, `go depth ${depth}`);
        await waitForBestmove(proc);
        proc.stdout.off("data", onStdout);
        const parsed = (0, parseResults_1.parseEvaluationResults)(lines, fen);
        return parsed;
    }
    async evaluatePositionWithUpdate(params, onProgress) {
        const { fen } = params;
        const depth = Number.isFinite(params.depth) ? Number(params.depth) : DEFAULT_DEPTH;
        const multiPv = Number.isFinite(params.multiPv) ? Number(params.multiPv) : DEFAULT_MULTIPV;
        const threads = Number.isFinite(params.threads) ? Number(params.threads) : DEFAULT_THREADS;
        const hashMb = Number.isFinite(params.hashMb) ? Number(params.hashMb) : DEFAULT_HASH_MB;
        const syzygyPath = params.syzygyPath;
        const useNNUE = params.useNNUE;
        const elo = Number(params.elo);
        const skillLevel = clampToSkill(params.skillLevel);
        const proc = this.spawnEngine();
        const results = [];
        let lastDepthReported = 0;
        const onStdout = (chunk) => {
            const text = chunk.toString("utf8");
            for (const raw of text.split(/\r?\n/)) {
                const s = raw.trim();
                if (!s)
                    continue;
                results.push(s);
                if (s.startsWith("info ")) {
                    const m = parseInfoLineForProgress(s);
                    if (m?.depth && onProgress && m.depth !== lastDepthReported) {
                        lastDepthReported = m.depth;
                        const pct = Math.max(0, Math.min(100, Math.round((m.depth / Math.max(1, depth)) * 100)));
                        try {
                            onProgress(pct);
                        }
                        catch { }
                    }
                }
            }
        };
        proc.stdout.on("data", onStdout);
        await this.initSession(proc, { threads, hashMb, multiPv, syzygyPath, useNNUE, elo, skillLevel });
        this.send(proc, `position fen ${fen}`);
        this.send(proc, `go depth ${depth}`);
        await waitForBestmove(proc);
        try {
            this.send(proc, "quit");
            proc.stdin.end();
        }
        catch { }
        setTimeout(() => { try {
            proc.kill("SIGKILL");
        }
        catch { } }, 150);
        proc.stdout.off("data", onStdout);
        const parsed = (0, parseResults_1.parseEvaluationResults)(results, fen);
        return parsed;
    }
    async evaluateGame(params, onProgress) {
        const fens = Array.isArray(params.fens) ? params.fens : [];
        const depth = Number.isFinite(params.depth) ? Number(params.depth) : DEFAULT_DEPTH;
        const multiPv = Number.isFinite(params.multiPv) ? Number(params.multiPv) : DEFAULT_MULTIPV;
        const proc = this.spawnEngine();
        await this.initSession(proc, {
            threads: params?.threads ?? DEFAULT_THREADS,
            hashMb: params?.hashMb ?? DEFAULT_HASH_MB,
            multiPv,
            syzygyPath: params?.syzygyPath,
            useNNUE: params?.useNNUE,
            elo: params?.elo,
            skillLevel: clampToSkill(params?.skillLevel),
        });
        const positions = [];
        const total = fens.length;
        for (let i = 0; i < total; i++) {
            const fen = String(fens[i] ?? "");
            const pe = await this.evaluateFenOnSession(proc, fen, depth, undefined);
            positions.push(pe);
            if (onProgress) {
                const pct = Math.round(((i + 1) / Math.max(1, total)) * 100);
                try {
                    onProgress(pct);
                }
                catch { }
            }
        }
        try {
            this.send(proc, "quit");
            proc.stdin.end();
        }
        catch { }
        setTimeout(() => { try {
            proc.kill("SIGKILL");
        }
        catch { } }, 150);
        const out = {
            positions: positions,
            acpl: { white: 0, black: 0 },
            settings: {
                engine: "stockfish-native",
                depth,
                multiPv,
            },
        };
        return out;
    }
    async getEngineNextMove(fen, _elo, depth) {
        const d = Number.isFinite(depth) ? Number(depth) : DEFAULT_DEPTH;
        const res = await this.evaluatePositionWithUpdate({ fen, depth: d, multiPv: 1 });
        const best = String(res.bestMove ?? res.lines?.[0]?.pv?.[0] ?? "");
        return best;
    }
    async stopAllCurrentJobs() {
        const p = this.currentProc;
        if (!p)
            return;
        try {
            p.stdin.write("stop\n");
        }
        catch { }
        setTimeout(() => { try {
            p.kill("SIGKILL");
        }
        catch { } }, 100);
        this.currentProc = null;
    }
    shutdown() {
        const p = this.currentProc;
        if (p) {
            try {
                p.stdin.end("quit\n");
            }
            catch { }
            try {
                p.kill("SIGKILL");
            }
            catch { }
            this.currentProc = null;
        }
    }
}
exports.UciEngine = UciEngine;
function clampToSkill(v) {
    if (v === null || v === undefined)
        return undefined;
    const n = Number(v);
    if (!Number.isFinite(n))
        return undefined;
    const clamped = Math.max(SKILL_LEVEL_MIN, Math.min(SKILL_LEVEL_MAX, Math.round(n)));
    return clamped;
}
//# sourceMappingURL=uciEngine.js.map