"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPaddedNumber = getPaddedNumber;
exports.resolveEngineWorkerFileUrl = resolveEngineWorkerFileUrl;
exports.ensureNodeLikeBrowserGlobals = ensureNodeLikeBrowserGlobals;
exports.logErrorToSentry = logErrorToSentry;
const node_path_1 = __importDefault(require("node:path"));
const node_url_1 = require("node:url");
const promises_1 = __importDefault(require("node:fs/promises"));
function getPaddedNumber(num) {
    return num < 10 ? `0${num}` : `${num}`;
}
function resolveEngineWorkerFileUrl(enginePublicPath) {
    const rel = enginePublicPath.replace(/^\/+/, "");
    const fsPath = node_path_1.default.resolve(process.cwd(), "public", rel);
    return (0, node_url_1.pathToFileURL)(fsPath).href;
}
function ensureNodeLikeBrowserGlobals(workerFileUrl) {
    const g = globalThis;
    if (typeof g.window === "undefined")
        g.window = g;
    if (typeof g.self === "undefined")
        g.self = g;
    if (typeof g.location === "undefined") {
        try {
            g.location = new URL(workerFileUrl);
        }
        catch {
            g.location = new URL("file:///");
        }
    }
    if (typeof g.navigator === "undefined") {
        g.navigator = { userAgent: "node" };
    }
    if (typeof g.fetch === "undefined") {
        g.fetch = async (input, init) => {
            const u = new URL(String(input), g.location?.href ?? "file:///");
            if (u.protocol === "file:") {
                const buf = await promises_1.default.readFile(u);
                return new Response(buf.buffer, { status: 200 });
            }
            return fetch(u, init);
        };
    }
    else {
        const realFetch = g.fetch.bind(globalThis);
        g.fetch = async (input, init) => {
            try {
                const u = new URL(String(input), g.location?.href ?? "file:///");
                if (u.protocol === "file:") {
                    const buf = await promises_1.default.readFile(u);
                    return new Response(buf.buffer, { status: 200 });
                }
                return realFetch(u, init);
            }
            catch {
                return realFetch(input, init);
            }
        };
    }
}
function logErrorToSentry(error, context) {
    console.error("[ERROR]", error, context);
}
//# sourceMappingURL=helpers.js.map