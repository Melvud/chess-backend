// src/lib/engine/helpers.ts
import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs/promises";

// Преобразует публичный URL (например, "/engines/stockfish-17/stockfish-17-lite.js")
// в абсолютный file:// URL внутри проекта (…/public/engines/…/stockfish-17-lite.js)
export function resolveEngineWorkerFileUrl(enginePublicPath: string): string {
  const rel = enginePublicPath.replace(/^\/+/, ""); // убираем ведущие "/"
  const fsPath = path.resolve(process.cwd(), "public", rel);
  return pathToFileURL(fsPath).href; // "file://…"
}

// Гарантируем, что глобальная среда в Node приблизительно похожа на браузерную,
// т.к. бандлы SF иногда ожидают наличие window/self/location/navigator.
export function ensureNodeLikeBrowserGlobals(workerFileUrl: string) {
  const g = globalThis as any;

  if (typeof g.window === "undefined") g.window = g;
  if (typeof g.self === "undefined") g.self = g;

  // location нужен, чтобы относительные пути к .wasm резолвились от места воркера
  if (typeof g.location === "undefined") {
    try {
      g.location = new URL(workerFileUrl);
    } catch {
      // fallback на корень
      g.location = new URL("file:///");
    }
  }

  if (typeof g.navigator === "undefined") {
    g.navigator = { userAgent: "node" };
  }

  // В Node 18+ есть глобальный fetch (undici), но он не умеет file://.
  // Подменим только file://, а http/https отдадим реальному fetch.
  if (typeof g.fetch === "undefined") {
    g.fetch = async (input: any, init?: any) => {
      const u = new URL(String(input), g.location?.href ?? "file:///");
      if (u.protocol === "file:") {
        const buf = await fs.readFile(u);
        return new Response(buf, { status: 200 });
      }
      const { fetch: undiciFetch } = await import("undici");
      return undiciFetch(u, init);
    };
  } else {
    // Оборачиваем существующий fetch, чтобы добавить поддержку file://
    const realFetch = g.fetch.bind(globalThis);
    g.fetch = async (input: any, init?: any) => {
      try {
        const u = new URL(String(input), g.location?.href ?? "file:///");
        if (u.protocol === "file:") {
          const buf = await fs.readFile(u);
          return new Response(buf, { status: 200 });
        }
        return realFetch(u, init);
      } catch {
        // Если URL не парсится — просто отдадим в реальный fetch
        return realFetch(input, init);
      }
    };
  }
}
