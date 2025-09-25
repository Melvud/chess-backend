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

// Локальные алиасы на случай одноимённых методов внутри класса
const __LOG_L = L;
const __LOG_LI = LI;
const __LOG_LW = LW;
const __LOG_LE = LE;

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
      (listeners as any)[type]?.add(listener);
    },
    removeEventListener: (type, listener) => {
      (listeners as any)[type]?.delete(listener);
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
  // FIX: воркер ожидает "params", а не "payload"
  params: Extract<EngineCallPayload, { type: TType }>["params"];
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

  // --- ВНУТРЕННИЕ ОБЁРТКИ ДЛЯ ЛОГГЕРА (не меняют существующую схему логов) ---
  private L(scope: string, extra?: unknown): void {
    try { __LOG_L(scope, extra); } catch {}
  }
  private LI(scope: string, extra?: unknown): void {
    try { __LOG_LI(scope, extra); } catch {}
  }
  private LW(scope: string, extra?: unknown): void {
    try { __LOG_LW(scope, extra); } catch {}
  }
  private LE(scope: string, extra?: unknown): void {
    try { __LOG_LE(scope, extra); } catch {}
  }

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
            this.LE("progressCallback:error", err);
          }
        } else if (this.progressCallbacks.size === 1) {
          // fallback: если id отсутствует, но активен ровно один запрос
          const iter = this.progressCallbacks.values();
          const only = iter.next().value as (x: number) => void;
          if (only) {
            try {
              only(v);
            } catch (err) {
              this.LE("progressCallback:fallbackError", err);
            }
          }
        } else {
          this.LW("progress:unmatched", { id, value, active: this.progressCallbacks.size });
        }
      } else if ((msg as any).type === "log") {
        console.debug(`[${this.engineName}]`, (msg as EngineLogMsg).payload);
      } else if ((msg as any).type === "error") {
        console.error(`[${this.engineName}]`, (msg as EngineErrorMsg).error);
      } else if ((msg as any).type === "ready") {
        this.LI("worker:ready");
      }
    });

    this.worker.addEventListener("error", (e: any) => {
      this.LE("worker.onerror", { message: e?.message, stack: e?.error?.stack });
    });

    this.worker.addEventListener("messageerror", (e: any) => {
      this.LE("worker.messageerror", { data: e?.data });
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

  private call<TResp = unknown>(
    type: EngineCallPayload["type"],
    payload?: EngineCallPayload extends { type: typeof type; params: infer P } ? P : any,
    onProgress?: (value: number) => void,
  ): Promise<TResp> {
    const id = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

    // если есть onProgress — добавим progressId в payload, если его там нет
    const withProgressId =
      onProgress && payload && typeof payload === "object" && !("progressId" in (payload as any))
        ? { ...(payload as any), progressId: id }
        : payload;

    const progressKey = (withProgressId as any)?.progressId ?? id;
    if (onProgress) {
      this.progressCallbacks.set(progressKey, onProgress);
      this.L("call:progressAttached", { id: progressKey });
    }

    // FIX: отправляем "params", не "payload"
    const req: EngineRequest = { id, type, params: withProgressId } as EngineRequest;
    this.L("call:postMessage", { id, type });

    return new Promise<TResp>((resolve, reject) => {
      const started = Date.now();

      const handleMessage = (ev: MessageEvent<EngineMessage<TResp>>) => {
        const msg = normalizeMessage<TResp>(ev);
        if (!msg || typeof msg !== "object") return;

        // прогресс из worker приходит с id = progressKey
        if ((msg as any).type === "progress" && (msg as any).id === progressKey) {
          const value = Number((msg as any).value ?? 0);
          const cb = this.progressCallbacks.get(progressKey);
          if (cb) cb(value);
          return;
        }

        // финальный ответ — по id вызова
        if ((msg as any).id === id) {
          // Legacy формат: { id, result }
          if ("result" in (msg as any)) {
            this.worker.removeEventListener("message", handleMessage);
            const took = Date.now() - started;
            this.LI("call:resolve", { id, tookMs: took });
            // @ts-ignore
            resolve((msg as any).result as TResp);
            return;
          }
          // Новый формат: { id, type: "result", payload }
          if ((msg as any).type === "result" && "payload" in (msg as any)) {
            this.worker.removeEventListener("message", handleMessage);
            const took = Date.now() - started;
            this.LI("call:resolve", { id, tookMs: took });
            resolve((msg as any).payload as TResp);
            return;
          }
          // Запрос отвергнут: { id, type: "rejected", error? }
          if ((msg as any).type === "rejected") {
            this.worker.removeEventListener("message", handleMessage);
            this.LE("call:reject", { id, err: (msg as any).error });
            reject(new Error(String((msg as any).error ?? "engine_rejected")));
            return;
          }
          // Некоторые воркеры могут слать { id, type: "error", error }
          if ((msg as any).type === "error" && "error" in (msg as any)) {
            this.worker.removeEventListener("message", handleMessage);
            this.LE("call:reject", { id, err: (msg as any).error });
            reject(new Error(String((msg as any).error ?? "engine_error")));
            return;
          }
        }
      };

      const handleError = (e: any) => {
        try { this.worker.removeEventListener("message", handleMessage); } catch {}
        this.LE("call:reject", { id, err: e });
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
