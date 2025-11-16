// ultraLogger.ts
import crypto from "node:crypto";
export function makeReqId() {
    return crypto.randomBytes(6).toString("hex");
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
export function log(level, msg, meta) {
    // единый формат: время | уровень | сообщение | мета(json)
    const line = [
        ts(),
        level.toUpperCase().padEnd(5),
        msg,
        meta ? fmt(meta) : "",
    ].filter(Boolean).join(" | ");
    // не трогаем существующие консольные выводы — добавляем свои
    // eslint-disable-next-line no-console
    console[level === "debug" ? "log" : level](line);
}
export function reqLogMiddleware() {
    return (req, res, next) => {
        const reqId = req.headers["x-request-id"] || makeReqId();
        req.reqId = reqId;
        const start = now();
        const chunks = [];
        const _end = res.end;
        const _json = res.json.bind(res);
        const _send = res.send.bind(res);
        // лог запроса
        log("info", "HTTP IN", {
            reqId,
            method: req.method,
            url: req.originalUrl || req.url,
            ip: req.ip,
            ua: req.headers["user-agent"],
            query: req.query,
            // тело будем логировать аккуратно
        });
        // перехват res.json / res.send, чтобы знать размер ответа
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
        // собрать тело (вдруг надо)
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
/** Обёртка для async-эндпоинтов с вход/выход логами + ловлей ошибок */
export function withStepLogs(name, fn) {
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
/** Хуки для прогресса движка */
export function makeProgressLogger(scope, reqId, total) {
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
