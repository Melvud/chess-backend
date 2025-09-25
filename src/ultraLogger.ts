// ultraLogger.ts
import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

type LogLevel = "debug" | "info" | "warn" | "error";

export function makeReqId() {
  return crypto.randomBytes(6).toString("hex");
}

function now() {
  return Date.now();
}

function ts() {
  return new Date().toISOString();
}

function fmt(obj: any) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

export function log(level: LogLevel, msg: string, meta?: Record<string, any>) {
  // единый формат: время | уровень | сообщение | мета(json)
  const line = [
    ts(),
    level.toUpperCase().padEnd(5),
    msg,
    meta ? fmt(meta) : "",
  ].filter(Boolean).join(" | ");
  // не трогаем существующие консольные выводы — добавляем свои
  // eslint-disable-next-line no-console
  (console as any)[level === "debug" ? "log" : level](line);
}

export function reqLogMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const reqId = (req.headers["x-request-id"] as string) || makeReqId();
    (req as any).reqId = reqId;

    const start = now();
    const chunks: Buffer[] = [];
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
    (res as any).json = (body: any) => {
      log("debug", "HTTP OUT json payload", { reqId, size: Buffer.byteLength(JSON.stringify(body) || "") });
      return _json(body);
    };

    (res as any).send = (body: any) => {
      let size = 0;
      if (body == null) size = 0;
      else if (Buffer.isBuffer(body)) size = body.length;
      else if (typeof body === "string") size = Buffer.byteLength(body);
      else size = Buffer.byteLength(JSON.stringify(body) || "");
      log("debug", "HTTP OUT send payload", { reqId, size });
      return _send(body);
    };

    res.end = function chunkedEnd(this: Response, ...args: any[]) {
      const dur = now() - start;
      const status = res.statusCode;
      log(status >= 500 ? "error" : status >= 400 ? "warn" : "info", "HTTP OUT", {
        reqId,
        status,
        duration_ms: dur,
        sent_headers: res.getHeaders(),
      });
      return _end.apply(this, args as any);
    } as any;

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
export function withStepLogs<T extends (...args: any[]) => any>(name: string, fn: T): T {
  return (async function wrapped(this: any, ...args: any[]) {
    const [req, _res] = args;
    const reqId = (req && (req as any).reqId) || "no-reqid";
    const start = now();
    log("info", `STEP IN: ${name}`, { reqId });

    try {
      const out = await fn.apply(this, args);
      log("info", `STEP OUT: ${name}`, { reqId, duration_ms: now() - start });
      return out;
    } catch (err: any) {
      log("error", `STEP ERR: ${name}`, { reqId, duration_ms: now() - start, error: String(err?.stack || err) });
      throw err;
    }
  }) as any as T;
}

/** Хуки для прогресса движка */
export function makeProgressLogger(scope: string, reqId: string, total?: number) {
  const startedAt = now();
  return {
    onStart(meta?: Record<string, any>) {
      log("info", `${scope}: START`, { reqId, total, meta });
    },
    onProgress(done: number, _total?: number) {
      const pct = _total ? Math.floor((done * 100) / _total) : undefined;
      log("debug", `${scope}: PROGRESS`, { reqId, done, total: _total ?? total, percent: pct });
    },
    onFinish(meta?: Record<string, any>) {
      log("info", `${scope}: FINISH`, { reqId, duration_ms: now() - startedAt, meta });
    },
    onWarn(msg: string, meta?: Record<string, any>) {
      log("warn", `${scope}: WARN ${msg}`, { reqId, ...meta });
    },
    onError(err: any) {
      log("error", `${scope}: ERROR`, { reqId, error: String(err?.stack || err) });
    },
  };
}
