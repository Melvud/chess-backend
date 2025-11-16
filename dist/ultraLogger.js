"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeReqId = makeReqId;
exports.log = log;
exports.reqLogMiddleware = reqLogMiddleware;
exports.withStepLogs = withStepLogs;
exports.makeProgressLogger = makeProgressLogger;
const node_crypto_1 = __importDefault(require("node:crypto"));
function makeReqId() {
    return node_crypto_1.default.randomBytes(6).toString("hex");
}
function now() {
    return Date.now();
}
function ts() {
    return new Date().toISOString();
}
function fmt(obj) {
    try {
        return JSON.stringify(obj);
    }
    catch {
        return String(obj);
    }
}
function log(level, msg, meta) {
    const line = [
        ts(),
        level.toUpperCase().padEnd(5),
        msg,
        meta ? fmt(meta) : "",
    ].filter(Boolean).join(" | ");
    console[level === "debug" ? "log" : level](line);
}
function reqLogMiddleware() {
    return (req, res, next) => {
        const reqId = req.headers["x-request-id"] || makeReqId();
        req.reqId = reqId;
        const start = now();
        const chunks = [];
        const _end = res.end;
        const _json = res.json.bind(res);
        const _send = res.send.bind(res);
        log("info", "HTTP IN", {
            reqId,
            method: req.method,
            url: req.originalUrl || req.url,
            ip: req.ip,
            ua: req.headers["user-agent"],
            query: req.query,
        });
        res.json = (body) => {
            log("debug", "HTTP OUT json payload", { reqId, size: Buffer.byteLength(JSON.stringify(body) || "") });
            return _json(body);
        };
        res.send = (body) => {
            let size = 0;
            if (body == null)
                size = 0;
            else if (Buffer.isBuffer(body))
                size = body.length;
            else if (typeof body === "string")
                size = Buffer.byteLength(body);
            else
                size = Buffer.byteLength(JSON.stringify(body) || "");
            log("debug", "HTTP OUT send payload", { reqId, size });
            return _send(body);
        };
        res.end = function chunkedEnd(...args) {
            const dur = now() - start;
            const status = res.statusCode;
            log(status >= 500 ? "error" : status >= 400 ? "warn" : "info", "HTTP OUT", {
                reqId,
                status,
                duration_ms: dur,
                sent_headers: res.getHeaders(),
            });
            return _end.apply(this, args);
        };
        req.on("data", (c) => chunks.push(Buffer.from(c)));
        req.on("end", () => {
            if (chunks.length) {
                const raw = Buffer.concat(chunks);
                const sample = raw.toString("utf8");
                log("debug", "HTTP IN raw body", { reqId, size: raw.length, sample: sample.slice(0, 2048) });
            }
        });
        next();
    };
}
function withStepLogs(name, fn) {
    return (async function wrapped(...args) {
        const [req, _res] = args;
        const reqId = (req && req.reqId) || "no-reqid";
        const start = now();
        log("info", `STEP IN: ${name}`, { reqId });
        try {
            const out = await fn.apply(this, args);
            log("info", `STEP OUT: ${name}`, { reqId, duration_ms: now() - start });
            return out;
        }
        catch (err) {
            log("error", `STEP ERR: ${name}`, { reqId, duration_ms: now() - start, error: String(err?.stack || err) });
            throw err;
        }
    });
}
function makeProgressLogger(scope, reqId, total) {
    const startedAt = now();
    return {
        onStart(meta) {
            log("info", `${scope}: START`, { reqId, total, meta });
        },
        onProgress(done, _total) {
            const pct = _total ? Math.floor((done * 100) / _total) : undefined;
            log("debug", `${scope}: PROGRESS`, { reqId, done, total: _total ?? total, percent: pct });
        },
        onFinish(meta) {
            log("info", `${scope}: FINISH`, { reqId, duration_ms: now() - startedAt, meta });
        },
        onWarn(msg, meta) {
            log("warn", `${scope}: WARN ${msg}`, { reqId, ...meta });
        },
        onError(err) {
            log("error", `${scope}: ERROR`, { reqId, error: String(err?.stack || err) });
        },
    };
}
//# sourceMappingURL=ultraLogger.js.map