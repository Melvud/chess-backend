// src/lib/helpers.ts
import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs/promises";

/**
 * Добавляет ведущий 0 к числу если оно < 10
 */
export function getPaddedNumber(num: number): string {
  return num < 10 ? `0${num}` : `${num}`;
}

/**
 * Преобразует публичный URL в file:// URL
 */
export function resolveEngineWorkerFileUrl(enginePublicPath: string): string {
  const rel = enginePublicPath.replace(/^\/+/, "");
  const fsPath = path.resolve(process.cwd(), "public", rel);
  return pathToFileURL(fsPath).href;
}

/**
 * Настройка глобальных объектов для работы с Stockfish
 */
export function ensureNodeLikeBrowserGlobals(workerFileUrl: string) {
  const g = globalThis as any;

  if (typeof g.window === "undefined") g.window = g;
  if (typeof g.self === "undefined") g.self = g;

  if (typeof g.location === "undefined") {
    try {
      g.location = new URL(workerFileUrl);
    } catch {
      g.location = new URL("file:///");
    }
  }

  if (typeof g.navigator === "undefined") {
    g.navigator = { userAgent: "node" };
  }

  if (typeof g.fetch === "undefined") {
    g.fetch = async (input: any, init?: any) => {
      const u = new URL(String(input), g.location?.href ?? "file:///");
      if (u.protocol === "file:") {
        const buf = await fs.readFile(u);
        // Исправлено: используем ArrayBuffer вместо Buffer
        return new Response(buf.buffer, { status: 200 });
      }
      // Node 18+ имеет встроенный fetch
      return fetch(u, init);
    };
  } else {
    const realFetch = g.fetch.bind(globalThis);
    g.fetch = async (input: any, init?: any) => {
      try {
        const u = new URL(String(input), g.location?.href ?? "file:///");
        if (u.protocol === "file:") {
          const buf = await fs.readFile(u);
          // Исправлено: используем ArrayBuffer вместо Buffer
          return new Response(buf.buffer, { status: 200 });
        }
        return realFetch(u, init);
      } catch {
        return realFetch(input, init);
      }
    };
  }
}

/**
 * Заглушка для логирования ошибок (можно заменить на Sentry)
 */
export function logErrorToSentry(error: any, context?: any) {
  console.error("[ERROR]", error, context);
  // TODO: Интеграция с Sentry
  // Sentry.captureException(error, { extra: context });
}