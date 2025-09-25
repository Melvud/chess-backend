// src/lib/engine/uciEngine.ts
import WebWorker from "web-worker";
import type { EngineName } from "@/types/enums";
import type {
  EvaluateGameParams,
  EvaluatePositionWithUpdateParams,
  GameEval,
  PositionEval,
} from "@/types/eval";

import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs/promises";

/** Префикс для консольных логов этого модуля */
const L = (scope: string, extra?: unknown) =>
  extra !== undefined ? console.debug(`[UciEngine:${scope}]`, extra) : console.debug(`[UciEngine:${scope}]`);
const LI = (scope: string, extra?: unknown) =>
  extra !== undefined ? console.info(`[UciEngine:${scope}]`, extra) : console.info(`[UciEngine:${scope}]`);
const LW = (scope: string, extra?: unknown) =>
  extra !== undefined ? console.warn(`[UciEngine:${scope}]`, extra) : console.warn(`[UciEngine:${scope}]`);
const LE = (scope: string, extra?: unknown) =>
  extra !== undefined ? console.error(`[UciEngine:${scope}]`, extra) : console.error(`[UciEngine:${scope}]`);

/* ------------------------------------------------------------------ */
/* Разрешение путей/режимов запуска                                   */
/* ------------------------------------------------------------------ */

type SpawnMode = "node" | "web";

/** Определяем, нужно ли запускать воркер как node worker_threads */
function detectSpawnMode(enginePublicPath: string): SpawnMode {
  const p = enginePublicPath.toLowerCase();
  if (p.endsWith(".cjs") || p.includes("node-worker")) return "node";
  return "web";
}

/** Для web: public-путь → file:// URL. Для node: public-путь → абсолютный FS-путь */
function resolveEngineEntry(enginePublicPath: string, mode: SpawnMode): string {
  const clean = enginePublicPath.replace(/^\/+/, "");
  const absFsPath = path.resolve(process.cwd(), "public", clean);
  if (mode === "web") {
    const url = pathToFileURL(absFsPath).toString();
    LI("resolveEngineEntry:web", { absFsPath, url });
    return url;
  }
  LI("resolveEngineEntry:node", { absFsPath });
  return absFsPath;
}

/** Подстраховка браузерных глобалов и fetch(file://...) в Node (используем только для web режима) */
function ensureNodeLikeBrowserGlobals(workerFileUrl: string) {
  L("ensureNodeLikeBrowserGlobals:start", { workerFileUrl });
  const g = globalThis as any;
  if (typeof g.window === "undefined") {
    g.window = g;
    L("ensureNodeLikeBrowserGlobals:set", "window");
  }
  if (typeof g.self === "undefined") {
    g.self = g;
    L("ensureNodeLikeBrowserGlobals:set", "self");
  }
  if (typeof g.location === "undefined") {
    try {
      g.location = new URL(workerFileUrl);
      L("ensureNodeLikeBrowserGlobals:set", { location: g.location?.href });
    } catch {
      g.location = new URL("file:///");
      L("ensureNodeLikeBrowserGlobals:setFallback", { location: g.location?.href });
    }
  }
  if (typeof g.navigator === "undefined") {
    g.navigator = { userAgent: "node" };
    L("ensureNodeLikeBrowserGlobals:set", "navigator");
  }

  if (typeof g.fetch === "undefined") {
    L("ensureNodeLikeBrowserGlobals:patchFetch");
    g.fetch = async (input: any) => {
      const u = new URL(String(input), g.location?.href ?? "file:///");
      if (u.protocol === "file:") {
        const started = Date.now();
        const buf = await fs.readFile(u, "utf8");
        const took = Date.now() - started;
        LI("fetch:file", { href: u.href, tookMs: took, bytes: buf.length });
        return new Response(new Blob([buf]), { status: 200, statusText: "OK" });
      }
      LW("fetch:unsupported", { href: u.href, protocol: u.protocol });
      throw new Error("fetch is not available");
    };
  }
}

/* ------------------------------------------------------------------ */
/* Адаптер: выравниваем API воркера под addEventListener/removeEvent… */
/* ------------------------------------------------------------------ */

type WorkerLike = {
  postMessage: (data: any) => void;
  terminate: () => any;
  addEventListener: (type: "message" | "error" | "messageerror", listener: (ev: any) => void) => void;
  removeEventListener: (type: "message" | "error" | "messageerror", listener: (ev: any) => void) => void;
};

/** Обёртка над worker_threads.Worker с интерфейсом как у WebWorker (ESM-совместимо, без require) */
async function makeNodeWorkerWrapper(absPath: string): Promise<WorkerLike> {
  const { Worker: NodeWorker } = await import("node:worker_threads");
  const w = new NodeWorker(absPath, { eval: false });

  const listeners = {
    message: new Set<(ev: any) => void>(),
    error: new Set<(ev: any) => void>(),
    messageerror: new Set<(ev: any) => void>(),
  };

  const onMessage = (data: any) => {
    // Выравниваем под WebWorker: передаём { data }
    listeners.message.forEach((fn) => {
      try {
        fn({ data });
      } catch {
        /* noop */
      }
    });
  };
  const onError = (err: any) => {
    const evt = { message: err?.message, error: err };
    listeners.error.forEach((fn) => {
      try {
        fn(evt);
      } catch {
        /* noop */
      }
    });
  };

  w.on("message", onMessage);
  w.on("error", onError);

  return {
    postMessage: (data: any) => w.postMessage(data),
    terminate: () => w.terminate(),
    addEventListener: (type, listener) => {
      listeners[type as keyof typeof listeners]?.add(listener);
    },
    removeEventListener: (type, listener) => {
      listeners[type as keyof typeof listeners]?.delete(listener);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Протокол сообщений                                                  */
/* ------------------------------------------------------------------ */

type EngineReadyMsg = { type: "ready" };
type EngineProgressMsg = { id?: string; type: "progress"; value: number };
type EngineLogMsg = { type: "log"; payload: unknown };
type EngineErrorMsg = { type: "error"; error: string };

type EngineResultMsg<T> = { id: string; type: "result"; payload: T };
type EngineRejectedMsg = { id: string; type: "rejected"; error?: string };

/** Legacy-ответы некоторых воркеров */
type EngineLegacyResultMsg<T> = { id: string; result?: T; error?: string };

type EngineMessage<T = unknown> =
  | EngineReadyMsg
  | EngineProgressMsg
  | EngineLogMsg
  | EngineErrorMsg
  | EngineResultMsg<T>
  | EngineRejectedMsg
  | EngineLegacyResultMsg<T>;

type EngineCallPayload =
  | {
      type: "evaluate-position";
      params: EvaluatePositionWithUpdateParams & { progressId?: string };
    }
  | {
      type: "evaluate-game";
      params: EvaluateGameParams & { progressId?: string };
    }
  | { type: "next-move"; params: { fen: string; elo?: number; depth?: number } }
  | { type: "stop"; params: Record<string, never> };

type EngineRequest<
  TType extends EngineCallPayload["type"] = EngineCallPayload["type"],
> = {
  id: string;
  type: TType;
  payload: Extract<EngineCallPayload, { type: TType }>["params"];
};

/** Аккуратный парсер: поддержка строковых JSON-сообщений от воркера */
function normalizeMessage<T = unknown>(ev: MessageEvent): EngineMessage<T> | null {
  const raw = (ev as any).data;
  L(
    "normalizeMessage:raw",
    typeof raw === "string" ? raw.slice(0, 200) + (String(raw).length > 200 ? "…" : "") : raw,
  );
  let d: any = raw;
  if (d == null) return null;

  if (typeof d === "string") {
    try {
      const parsed = JSON.parse(d);
      L("normalizeMessage:parsedJSON", parsed);
      if (parsed && typeof parsed === "object") return parsed as EngineMessage<T>;
      return { type: "log", payload: d } as EngineLogMsg as any;
    } catch {
      LW("normalizeMessage:nonJSONString");
      return { type: "log", payload: d } as EngineLogMsg as any;
    }
  }

  if (typeof d === "object") {
    L("normalizeMessage:object", d);
    return d as EngineMessage<T>;
  }

  LW("normalizeMessage:unknownType", { typeof: typeof d });
  return { type: "log", payload: d } as EngineLogMsg as any;
}

/* ------------------------------------------------------------------ */
/* Основной класс                                                      */
/* ------------------------------------------------------------------ */

export class UciEngine {
  private worker!: WorkerLike;
  private engineName!: EngineName;

  /** Привязки onProgress по id активных запросов */
  private progressCallbacks = new Map<string, (value: number) => void>();

  private constructor(engineName: EngineName) {
    this.engineName = engineName;
  }

  /** Асинхронная инициализация: создаём воркер в нужном режиме и навешиваем слушатели */
  private async init(enginePublicPath: string): Promise<void> {
    LI("constructor:start", { engineName: this.engineName, enginePublicPath });
    const mode = detectSpawnMode(enginePublicPath);
    const entry = resolveEngineEntry(enginePublicPath, mode);

    if (mode === "web") {
      ensureNodeLikeBrowserGlobals(entry);
      LI("constructor:spawnWorker:web", { fileUrl: entry });
      this.worker = new WebWorker(entry as any) as unknown as WorkerLike;
    } else {
      LI("constructor:spawnWorker:node", { absPath: entry });
      this.worker = await makeNodeWorkerWrapper(entry);
    }

    // Глобальный listener: прогресс/log/error
    this.worker.addEventListener("message", (ev: MessageEvent<EngineMessage>) => {
      const msg = normalizeMessage(ev);
      if (!msg || typeof msg !== "object") return;

      if ((msg as any).type && (msg as any).type !== "progress") {
        L("worker.onmessage", msg);
      }

      if ((msg as any).type === "progress") {
        const { id, value } = msg as EngineProgressMsg;
        const v = Number(value) || 0;
        if (id && this.progressCallbacks.has(id)) {
          const cb = this.progressCallbacks.get(id)!;
          try {
            cb(v);
          } catch (err) {
            LE("progressCallback:error", err);
          }
        } else if (this.progressCallbacks.size === 1) {
          // fallback: если id отсутствует, но активен ровно один запрос
          const iter = this.progressCallbacks.values();
          const only = iter.next().value as (x: number) => void;
          if (only) {
            try {
              only(v);
            } catch (err) {
              LE("progressCallback:fallbackError", err);
            }
          }
        } else {
          LW("progress:unmatched", { id, value, active: this.progressCallbacks.size });
        }
      } else if ((msg as any).type === "log") {
        console.debug(`[${this.engineName}]`, (msg as EngineLogMsg).payload);
      } else if ((msg as any).type === "error") {
        console.error(`[${this.engineName}]`, (msg as EngineErrorMsg).error);
      } else if ((msg as any).type === "ready") {
        LI("worker:ready");
      }
    });

    this.worker.addEventListener("error", (e: any) => {
      LE("worker.onerror", { message: e?.message, stack: e?.error?.stack });
    });

    this.worker.addEventListener("messageerror", (e: any) => {
      LE("worker.messageerror", { data: e?.data });
    });

    LI("constructor:done");
  }

  /** Фабрика — теперь дожидается асинхронного init */
  static async create(engineName: EngineName, enginePublicPath: string): Promise<UciEngine> {
    LI("create:begin", { engineName, enginePublicPath });
    const started = Date.now();
    const eng = new UciEngine(engineName);
    await eng.init(enginePublicPath);
    const took = Date.now() - started;
    LI("create:done", { tookMs: took });
    return eng;
  }

  /** Универсальный RPC-вызов с прогрессом и поддержкой legacy-ответов */
  private call<TResp>(
    type: EngineCallPayload["type"],
    payload: any,
    onProgress?: (value: number) => void,
  ): Promise<TResp> {
    const id = Math.random().toString(36).slice(2);
    L("call:begin", { type, id });

    if (!this.worker) {
      LE("call:noWorker", { type, id });
      throw new Error("Engine worker is not initialized");
    }

    // если клиент просил прогресс, добавим progressId в payload (НЕ меняя имена полей)
    const withProgressId =
      onProgress && payload && typeof payload === "object" && !("progressId" in payload)
        ? { ...payload, progressId: id }
        : payload;

    if (onProgress) {
      this.progressCallbacks.set(id, onProgress);
      L("call:progressAttached", { id });
    }

    const req: EngineRequest = { id, type, payload: withProgressId } as EngineRequest;
    L("call:postMessage", { id, type });

    return new Promise<TResp>((resolve, reject) => {
      const started = Date.now();

      const handleMessage = (ev: MessageEvent<EngineMessage<TResp>>) => {
        const msg = normalizeMessage<TResp>(ev);
        if (!msg || typeof msg !== "object") return;

        // Завершение/отклонение по совпадению id
        if ("id" in msg && (msg as any).id === id) {
          const took = Date.now() - started;
          this.worker.removeEventListener("message", handleMessage);
          if (this.progressCallbacks.has(id)) this.progressCallbacks.delete(id);

          // Новый формат
          if ((msg as any).type === "result") {
            LI("call:result", { id, type, tookMs: took });
            resolve((msg as EngineResultMsg<TResp>).payload);
            return;
          }
          if ((msg as any).type === "rejected") {
            LE("call:rejected", { id, type, tookMs: took, error: (msg as EngineRejectedMsg).error });
            reject(new Error((msg as EngineRejectedMsg).error ?? "Engine call rejected"));
            return;
          }

          // Legacy формат: { id, result?, error? }
          if ("result" in (msg as any) || "error" in (msg as any)) {
            const legacy = msg as EngineLegacyResultMsg<TResp>;
            if (legacy.error) {
              LE("call:legacyError", { id, type, tookMs: took, error: legacy.error });
              reject(new Error(String(legacy.error)));
            } else {
              LI("call:legacyResult", { id, type, tookMs: took });
              resolve(legacy.result as TResp);
            }
            return;
          }

          // Неожиданное (но наш id)
          LW("call:unknownResponse", msg);
        }
      };

      const handleError = (e: any) => {
        this.worker.removeEventListener("message", handleMessage);
        if (this.progressCallbacks.has(id)) this.progressCallbacks.delete(id);
        LE("call:postMessageError", { id, type, err: e });
        reject(e);
      };

      this.worker.addEventListener("message", handleMessage);
      try {
        this.worker.postMessage(req);
      } catch (e) {
        handleError(e);
      }
    });
  }

  /** Позиционная оценка с периодическими обновлениями */
  evaluatePositionWithUpdate(
    params: EvaluatePositionWithUpdateParams,
    onProgress?: (value: number) => void,
  ): Promise<PositionEval> {
    LI("evaluatePositionWithUpdate:start", {
      hasProgress: !!onProgress,
      depth: (params as any)?.depth,
      multiPv: (params as any)?.multiPv,
    });
    const started = Date.now();
    return this.call<PositionEval>("evaluate-position", params, onProgress).finally(() => {
      const took = Date.now() - started;
      LI("evaluatePositionWithUpdate:done", { tookMs: took });
    });
  }

  /** Оценка целой партии/набора FEN */
  evaluateGame(params: EvaluateGameParams, onProgress?: (value: number) => void): Promise<GameEval> {
    LI("evaluateGame:start", {
      hasProgress: !!onProgress,
      fens: params?.fens?.length,
      depth: (params as any)?.depth,
      multiPv: (params as any)?.multiPv,
      workersNb: (params as any)?.workersNb,
    });
    const started = Date.now();
    return this.call<GameEval>("evaluate-game", params, onProgress).finally(() => {
      const took = Date.now() - started;
      LI("evaluateGame:done", { tookMs: took });
    });
  }

  /** Следующий ход движка */
  getEngineNextMove(fen: string, elo?: number, depth?: number): Promise<string> {
    LI("getEngineNextMove:start", { fen: fen?.slice(0, 32) + (fen?.length > 32 ? "…" : ""), elo, depth });
    const started = Date.now();
    return this.call<string>("next-move", { fen, elo, depth }).finally(() => {
      const took = Date.now() - started;
      LI("getEngineNextMove:done", { tookMs: took });
    });
  }

  /** Останов текущих вычислений */
  async stopAllCurrentJobs(): Promise<void> {
    LI("stopAllCurrentJobs:start");
    const started = Date.now();
    await this.call<void>("stop", {});
    const took = Date.now() - started;
    LI("stopAllCurrentJobs:done", { tookMs: took });
  }

  /** Отключение воркера */
  shutdown() {
    LI("shutdown:start");
    try {
      this.worker?.terminate?.();
      LI("shutdown:terminated");
    } catch (e) {
      LE("shutdown:error", e);
    }
  }
}
