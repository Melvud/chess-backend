// Worker for Stockfish engine (Node worker_threads)
// Place at: public/engines/stockfish-17/worker.js

/* ====== LOG HELPERS ====== */
const L  = (s, x) => (x !== undefined ? console.debug(`[SF-WORKER:${s}]`, x) : console.debug(`[SF-WORKER:${s}]`));
const LI = (s, x) => (x !== undefined ? console.info (`[SF-WORKER:${s}]`, x) : console.info (`[SF-WORKER:${s}]`));
const LW = (s, x) => (x !== undefined ? console.warn (`[SF-WORKER:${s}]`, x) : console.warn (`[SF-WORKER:${s}]`));
const LE = (s, x) => (x !== undefined ? console.error(`[SF-WORKER:${s}]`, x) : console.error(`[SF-WORKER:${s}]`));

/* ====== GLOBAL/POLYFILLS ====== */
LI("init:polyfills:start");
const G =
  (typeof globalThis !== "undefined" && globalThis) ||
  (typeof self !== "undefined" && self) ||
  (typeof window !== "undefined" && window) ||
  (function(){ return this; })();

// Make sure common globals exist
if (typeof G.window === "undefined") { G.window = G; L("polyfill:set","window"); }
if (typeof G.self   === "undefined") { G.self   = G; L("polyfill:set","self"); }
/* eslint-disable no-var */
var global = (typeof G.global === "undefined") ? G : G.global;
/* eslint-enable no-var */
if (typeof G.navigator === "undefined") { G.navigator = { userAgent: "node" }; L("polyfill:set","navigator"); }

// TextEncoder/TextDecoder polyfill for Node
if (typeof G.TextEncoder === "undefined") {
  try {
    const util = require('util');
    G.TextEncoder = util.TextEncoder;
    G.TextDecoder = util.TextDecoder;
    L("polyfill:set","TextEncoder/TextDecoder from util");
  } catch {
    G.TextEncoder = class TextEncoder { encode(str){ return new Uint8Array(Buffer.from(str,'utf8')); } };
    G.TextDecoder = class TextDecoder { decode(bytes){ if (bytes instanceof ArrayBuffer) bytes=new Uint8Array(bytes); return Buffer.from(bytes).toString('utf8'); } };
    L("polyfill:set","TextEncoder/TextDecoder fallback");
  }
}

// location with empty hash
(function ensureLocation(g) {
  try {
    if (!g.location || typeof g.location !== "object") {
      const { pathToFileURL } = require("url");
      const href = pathToFileURL(__filename).href;
      g.location = { href, hash: "", toString(){ return this.href; } };
      L("polyfill:location:new", g.location);
    } else {
      if (typeof g.location.hash !== "string") g.location.hash = "";
      L("polyfill:location:ok", { href: g.location.href, hash: g.location.hash });
    }
  } catch {
    g.location = { href: "file:///", hash: "", toString(){ return this.href; } };
    L("polyfill:location:fallback", g.location);
  }
})(G);

// For Emscripten builds exporting factory via document.currentScript._exports
if (!G.document) G.document = {};
if (!G.document.currentScript) G.document.currentScript = { _exports: undefined };

LI("init:polyfills:done");

/* ====== PATH HELPERS ====== */
const __ORIGINAL_HREF__ = (() => {
  try { return (typeof location !== "undefined" && location && typeof location.href === "string") ? location.href : null; }
  catch { return null; }
})();

function computeWorkerBase() {
  if (__ORIGINAL_HREF__ && __ORIGINAL_HREF__ !== "file:///") {
    try {
      const base = new URL("./", __ORIGINAL_HREF__).toString();
      return base.endsWith("/") ? base : base + "/";
    } catch (e) { LW("base:location parse failed", e); }
  }
  if (typeof process !== "undefined" && process.cwd) {
    const cwd = process.cwd();
    const base = `file://${cwd}/public/engines/stockfish-17/`;
    LI("base:from process.cwd", { cwd, base });
    return base;
  }
  LW("base:using fallback file:///");
  return "file:///";
}
const __WORKER_BASE_URL__ = computeWorkerBase();
LI("base:resolved", { base: __WORKER_BASE_URL__, original: __ORIGINAL_HREF__ });

function fromWorkerDir(rel) {
  try {
    if (/^(?:[a-z]+:)?\/\//i.test(rel)) return rel;
    const url = new URL(rel, __WORKER_BASE_URL__).toString();
    L("fromWorkerDir", { rel, base: __WORKER_BASE_URL__, result: url });
    return url;
  } catch (e) {
    LW("fromWorkerDir:error", { rel, error: e.message });
    return rel;
  }
}
function fileURLToPath(urlStr) { return new URL(urlStr).pathname; }

/* ====== SAVE ORIGINAL REQUIRE/PROCESS BEFORE HIDING ====== */
const __ORIG_PROCESS__ = (typeof self.process !== "undefined") ? self.process : undefined;
const __ORIG_REQUIRE__ = (typeof self.require  !== "undefined") ? self.require  : undefined;

/* ====== BEFORE ENGINE LOAD: prepare Module & wasmBinary ====== */
LI("init:emscripten:setup");
self.Module = self.Module || {};

// global handlers / stdin buffer
const __MESSAGE_HANDLERS__ = [];
const __STDIN_QUEUE__ = [];

// print hooks (fallback — перехватим ниже inst.print всё равно)
const outputBuffer = [];
self.Module.print = self.Module.print || function(text) {
  L("engine:stdout", text);
  outputBuffer.push(text);
  __MESSAGE_HANDLERS__.forEach(fn => { try { fn({ data: String(text) }); } catch {} });
};
self.Module.printErr = self.Module.printErr || function(text) { L("engine:stderr", text); };

// preRun: wire FS stdin if available
self.Module.preRun = self.Module.preRun || [];
self.Module.preRun.push(function() {
  try {
    const M = self.Module;
    if (M.FS && M.FS.init) {
      M.FS.init(
        () => (__STDIN_QUEUE__.length ? __STDIN_QUEUE__.shift() : null),
        () => {},
        (c) => { if (M.printErr) M.printErr(String.fromCharCode(c)); }
      );
      LI("prerun:fs.init");
    }
  } catch (e) { LE("prerun:fs.init:error", e); }
});

// locateFile
function makeLocateFile(engineBase, multipartPresent) {
  return (filename) => {
    if (typeof filename === "string" && filename.endsWith(".wasm")) {
      if (/^stockfish(?:-lite)?\.wasm$/i.test(filename)) {
        if (!multipartPresent) {
          const rewritten = `${engineBase}.wasm`;
          L("locateFile:rewrite", { from: filename, to: rewritten });
          return fromWorkerDir(rewritten);
        }
        const url = fromWorkerDir("stockfish.wasm");
        L("locateFile:keep-multipart", { from: filename, to: url });
        return url;
      }
      const m = /(part-\d+\.wasm)$/i.exec(filename);
      if (m && !filename.includes(engineBase)) {
        const rewritten = `${engineBase}-${m[1]}`;
        L("locateFile:rewrite", { from: filename, to: rewritten });
        return fromWorkerDir(rewritten);
      }
    }
    if (typeof filename === "string" && /stockfish\.worker\.js(\?.*)?$/i.test(filename)) {
      const workerUrl = fromWorkerDir("stockfish.worker.js");
      LW("locateFile:pthreads-worker", { from: filename, to: workerUrl });
      return workerUrl;
    }
    const res = fromWorkerDir(filename);
    L("locateFile", { filename, result: res });
    return res;
  };
}

let __ENGINE_FACTORY__ = null;
let __ENGINE_NAME__    = null;
let __ENGINE_INSTANCE__ = null;

/* ====== Choose engine JS ====== */
const __ENGINE_URL__ = fromWorkerDir("stockfish-17.1-8e4d048.js");
const engineBase = (() => { const m = /([^/]+)\.js(?:$|\?)/.exec(__ENGINE_URL__); return m ? m[1] : "stockfish"; })();

/* ====== Detect and stitch part-N.wasm into Module.wasmBinary ====== */
let multipartPresent = false;
(function prepareWasmBinaryFromParts() {
  try {
    if (typeof __ORIG_REQUIRE__ !== "function") { LW("wasmBinary:prepare:no-require","Not in Node.js environment"); return; }
    const fs = __ORIG_REQUIRE__("fs");
    const path = __ORIG_REQUIRE__("path");
    const baseDir = fileURLToPath(__WORKER_BASE_URL__);
    const parts = [];
    for (let i=0;i<100;i++){
      const fname = `${engineBase}-part-${i}.wasm`;
      const full = path.join(baseDir, fname);
      if (fs.existsSync(full)) {
        const buf = fs.readFileSync(full);
        parts.push(buf);
        L("wasmBinary:found-part", { i, fname, bytes: buf.length });
      } else if (parts.length>0) break;
    }
    if (parts.length>0){
      multipartPresent = true;
      const total = parts.reduce((a,b)=>a+b.length,0);
      const stitched = new Uint8Array(total);
      let off=0; for (const b of parts){ stitched.set(b instanceof Uint8Array? b : new Uint8Array(b), off); off+=b.length; }
      self.Module.wasmBinary = stitched;
      LI("wasmBinary:stitched", { parts: parts.length, totalBytes: total });
    } else {
      LI("wasmBinary:multipart:not-found", { engineBase });
    }
  } catch(e){ LW("wasmBinary:prepare:error", String(e?.message||e)); }
})();

self.Module.locateFile = makeLocateFile(engineBase, multipartPresent);
self.Module.noInitialRun = false;
self.Module.noExitRuntime = true;

/* ====== LOAD ENGINE (hide process/require during import) ====== */
try { self.process = undefined; } catch {}
try { self.require  = undefined; } catch {}

// Real pthreads in Node
const OriginalWorker = self.Worker;
(function enableNodePthreadsWorker(){
  try {
    const { fileURLToPath: _fileURLToPath } = __ORIG_REQUIRE__ ? __ORIG_REQUIRE__("url") : require("url");
    const path = __ORIG_REQUIRE__ ? __ORIG_REQUIRE__("path") : require("path");
    const { Worker: NodeWorker } = __ORIG_REQUIRE__ ? __ORIG_REQUIRE__("worker_threads") : require("worker_threads");

    self.Worker = class NodePthreadWorker {
      constructor(url) {
        let absPath;
        if (typeof url === 'string' && url.startsWith('file:')) absPath = _fileURLToPath(url);
        else if (typeof url === 'string') {
          const baseDir = path.dirname(_fileURLToPath(new URL("./", __WORKER_BASE_URL__).toString()));
          absPath = path.isAbsolute(url) ? url : path.join(baseDir, url);
        } else { throw new Error('Unsupported worker script URL: ' + String(url)); }
        this._w = new NodeWorker(absPath, { eval: false });
        this.postMessage = (data) => this._w.postMessage(data);
        this.terminate   = () => this._w.terminate();
        this.addEventListener = (type, handler) => {
          if (type === 'message') this._w.on('message', (data) => handler({ data }));
          else if (type === 'error') this._w.on('error', (err) => handler(err));
          else if (type === 'exit') this._w.on('exit', (code) => handler({ code }));
        };
        this.removeEventListener = (type, handler) => {
          if (type === 'message') this._w.off('message', handler);
          else if (type === 'error') this._w.off('error', handler);
          else if (type === 'exit') this._w.off('exit', handler);
        };
      }
    };
    LW("pthreads:node-worker:enabled", true);
  } catch (e) { LW("pthreads:node-worker:disabled", String(e?.message || e)); }
})();

function pickFactoryNow() {
  if (self.document?.currentScript?._exports) { __ENGINE_NAME__ = "document.currentScript._exports"; return self.document.currentScript._exports; }
  if (typeof self.STOCKFISH === "function") { __ENGINE_NAME__ = "STOCKFISH()"; return (opts)=>self.STOCKFISH(opts); }
  if (typeof self.Stockfish === "function") { __ENGINE_NAME__ = "Stockfish()"; return (opts)=>self.Stockfish(opts); }
  if (typeof self.stockfish === "function") { __ENGINE_NAME__ = "stockfish()"; return (opts)=>self.stockfish(opts); }
  if (self.Module && typeof self.Module.Stockfish === "function") { __ENGINE_NAME__ = "Module.Stockfish()"; return (opts)=>self.Module.Stockfish(opts); }
  if (typeof self.Module === "function") { __ENGINE_NAME__ = "Module()"; return (opts)=>self.Module(opts); }
  return null;
}
async function waitFactory(timeoutMs = 2500) {
  const t0 = Date.now();
  for (;;) {
    if (__ENGINE_FACTORY__) return __ENGINE_FACTORY__;
    const f = pickFactoryNow(); if (f) return f;
    if (Date.now() - t0 >= timeoutMs) throw new Error("Stockfish factory not found after importScripts");
    await new Promise(r => setTimeout(r, 10));
  }
}

try {
  LI("engine:importScripts:begin", __ENGINE_URL__);
  importScripts(__ENGINE_URL__);
  LI("engine:importScripts:ok");
  if (self.document?.currentScript?._exports) { __ENGINE_FACTORY__ = self.document.currentScript._exports; L("engine:factory:captured", true); }
} catch (e) {
  LE("engine:importScripts:error", e);
} finally {
  try { if (typeof __ORIG_PROCESS__ !== "undefined") self.process = __ORIG_PROCESS__; } catch {}
  try { if (typeof __ORIG_REQUIRE__ !== "undefined") self.require = __ORIG_REQUIRE__; else delete self.require; } catch {}
  if (OriginalWorker) self.Worker = OriginalWorker;
}

/* ====== CREATE ENGINE INSTANCE ====== */
async function createEngineInstance() {
  if (__ENGINE_INSTANCE__) { LI("engine:reusing-instance"); return __ENGINE_INSTANCE__; }

  const factory = __ENGINE_FACTORY__ || (await waitFactory());
  __ENGINE_FACTORY__ = factory;

  const opts = {
    locateFile: self.Module.locateFile,
    noInitialRun: false,
    noExitRuntime: true,
    print: self.Module.print,
    printErr: self.Module.printErr,
  };
  if (self.Module.wasmBinary) opts.wasmBinary = self.Module.wasmBinary;

  let inst;
  try { inst = factory.length > 0 ? factory(opts) : factory(); }
  catch { inst = factory(opts); }

  if (inst && typeof inst.then === "function") { LI("factory:return:promise", __ENGINE_NAME__ || "unknown"); inst = await inst; }
  else { LI("factory:return:sync", __ENGINE_NAME__ || "unknown"); }

  if (!inst) throw new Error("Factory returned falsy instance");

  try {
    if (inst.ready && typeof inst.ready.then === "function") { LI("engine:ready:await"); await inst.ready; LI("engine:ready:ok"); }
  } catch (e) { LW("engine:ready:skip", String(e?.message || e)); }

  LI("engine:instance:type", {
    hasPostMessage: typeof inst.postMessage === "function",
    hasCcall: typeof inst.ccall === "function",
    hasPrint: typeof inst.print === "function",
    hasFS: !!inst.FS,
    hasCallMain: typeof inst.callMain === "function",
    keys: Object.keys(inst).filter(k => !k.startsWith('_')).slice(0, 10)
  });

  // ---------- IMPORTANT: forward engine output to message handlers ----------
  try {
    const origPrint = inst.print || ((t)=>console.log(t));
    inst.print = (text) => {
      try { origPrint(text); } finally {
        __MESSAGE_HANDLERS__.forEach(fn => { try { fn({ data: String(text) }); } catch {} });
      }
    };
    if (typeof inst.printErr === "function") {
      const origErr = inst.printErr;
      inst.printErr = (text) => {
        try { origErr(text); } finally {
          // stderr обычно не нужен слушателям, но оставим для отладки при желании
        }
      };
    }
    LI("engine:stdout:hooked");
  } catch (e) {
    LW("engine:stdout:hook-failed", String(e?.message || e));
  }

  // ---------- Command sender: stdin (FS) or ccall(export 'command') ----------
  let sendFn = null;

  if (inst.FS && typeof inst.FS.init === "function") {
    sendFn = (msg) => {
      const bytes = new TextEncoder().encode(msg + "\n");
      for (const b of bytes) __STDIN_QUEUE__.push(b);
    };
    LI("engine:send:mode", "stdin");
  } else if (typeof inst.ccall === "function") {
    const prefer = ["command","stockfish_command","send_command","sendLine","send_line","uci","input_line","inputLine"];
    let chosen = null;

    try {
      if (typeof inst.inspect === "function") {
        const info = inst.inspect();
        const funcs = (info && (info.functions || info.exports || info.symbols)) || [];
        const names = Array.isArray(funcs) ? funcs.map(String) : Object.keys(funcs || {});
        for (const cand of prefer) { const hit = names.find(n => n.toLowerCase() === cand.toLowerCase()); if (hit) { chosen = hit; break; } }
        if (!chosen) for (const cand of prefer) { const hit = names.find(n => n.toLowerCase().includes(cand.toLowerCase())); if (hit) { chosen = hit; break; } }
      }
    } catch (e) { LW("engine:inspect:error", String(e?.message || e)); }

    if (!chosen) chosen = "command";
    LI("engine:send:mode", "ccall");

    sendFn = (msg) => {
      try {
        // NB: добавляем \n — некоторые сборки ожидают линию с LF
        inst.ccall(chosen, null, ["string"], [msg + "\n"]);
      } catch (e) {
        LE("engine:ccall:fail", { fnName: chosen, err: String(e?.message || e) });
      }
    };
  } else {
    sendFn = () => LE("engine:send:error","no FS, no ccall");
    LE("engine:send:mode", "unavailable");
  }

  __ENGINE_INSTANCE__ = {
    postMessage: (msg) => { L("engine:input", msg); try { sendFn(msg); } catch (e) { LE("engine:input:error", e); } },
    terminate: () => { try { if (inst._quit) inst._quit(); if (inst.abort) inst.abort(); __ENGINE_INSTANCE__ = null; } catch {} },
    set onmessage(fn) { if (fn) __MESSAGE_HANDLERS__.push(fn); }
  };

  LI("engine:wrapper:created");
  return __ENGINE_INSTANCE__;
}

/* ====== UCI WRAPPER ====== */
class StockfishUci {
  constructor() {
    LI("StockfishUci:constructor:start");
    this.sf = undefined;
    this.listeners = [];
    this._initPromise = null;
    LI("StockfishUci:constructor:done");
  }
  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      this.sf = await createEngineInstance();

      this.sf.onmessage = (e) => {
        const line = String((e && e.data) ?? e ?? "");
        L("sf.onmessage", line);
        for (const fn of this.listeners) { try { fn(line); } catch (err) { LE("listener:error", err); } }
      };

      // kick UCI
      await new Promise(r => setTimeout(r, 50));
      await new Promise((resolve) => {
        const h = (line) => { if (line.includes("uciok")) { this.offLine(h); resolve(); } };
        this.onLine(h);
        this.send("uci");
      });

      // ensure ready
      await this.waitReadyWithRetry();
      LI("init:done");
      return true;
    })();
    return this._initPromise;
  }

  onLine(fn) { this.listeners.push(fn); L("onLine:add", { total: this.listeners.length }); }
  offLine(fn) { this.listeners = this.listeners.filter((f) => f !== fn); L("offLine:remove", { total: this.listeners.length }); }
  send(cmd) {
    L("send", cmd);
    try {
      if (this.sf?.postMessage) this.sf.postMessage(cmd);
      else LE("send:no method available");
    } catch (e) { LE("send:error", e); }
  }

  async waitReady() {
    return new Promise((resolve) => {
      const handler = (line) => { if (line.includes("readyok")) { this.offLine(handler); resolve(); } };
      this.onLine(handler);
      this.send("isready");
    });
  }
  async waitReadyWithRetry() {
    const start = Date.now();
    const timeout = 5000;
    while (true) {
      let got = false;
      await Promise.race([
        this.waitReady().then(()=>{ got = true; }),
        new Promise(res => setTimeout(res, 700))
      ]);
      if (got) return;
      if (Date.now() - start > timeout) { LW("waitReady:retry:timeout"); return; }
      LW("waitReady:retry");
    }
  }

  async newGame() { this.send("ucinewgame"); await this.waitReadyWithRetry(); }
  terminate() { try { this.sf?.terminate?.(); } catch {} }
}

/* ====== HELPERS ====== */
function sideToMoveFromFen(fen){ return (fen.split(" ")[1] === "b" ? "b" : "w"); }
function parseInfoLine(line){
  const t = line.trim().split(/\s+/g), out = {};
  for (let i = 0; i < t.length; i++) {
    const x = t[i];
    if (x === "multipv" && t[i+1]) out.multipv = Number(t[++i]);
    else if (x === "depth" && t[i+1]) out.depth = Number(t[++i]);
    else if (x === "score" && t[i+1]) {
      const kind = t[++i];
      if (kind === "cp" && t[i+1]) out.cp = Number(t[++i]);
      else if (kind === "mate" && t[i+1]) out.mate = Number(t[++i]);
    } else if (x === "pv") { out.pv = t.slice(i+1); break; }
  }
  return out;
}
function classifyByLoss(loss){ return loss<=5?"Best":loss<=20?"Excellent":loss<=60?"Good":loss<=100?"Inaccuracy":loss<=300?"Mistake":"Blunder"; }
const avg = (a)=>a.length? a.reduce((x,y)=>x+y,0)/a.length : 0;
const accuracyFromAcpl = (acpl)=>Math.max(0, Math.min(100, 100 - 12*Math.log10(1+Math.max(0,acpl)))) ;

/* ====== POSITION EVAL ====== */
async function evaluatePosition(sf, fen, depth, multiPv){
  await sf.init(); await sf.newGame();
  sf.send(`setoption name MultiPV value ${multiPv}`); await sf.waitReadyWithRetry();
  sf.send(`position fen ${fen}`); await sf.waitReadyWithRetry();

  const lines = []; let bestMove;
  const onLine = (line) => {
    if (line.startsWith("info ")){
      const info = parseInfoLine(line);
      if (!info.multipv || !info.pv) return;
      const rec = { multipv: info.multipv, cp: info.cp, mate: info.mate, pv: info.pv, depth: info.depth || depth };
      const i = lines.findIndex(l => l.multipv === rec.multipv);
      if (i>=0) lines[i]=rec; else lines.push(rec);
    } else if (line.startsWith("bestmove ")) bestMove = line.split(/\s+/g)[1];
  };
  sf.onLine(onLine);
  sf.send(`go depth ${depth}`);
  await new Promise((resolve)=>{ const h=(l)=>{ if(l.startsWith("bestmove ")){ sf.offLine(h); resolve(); } }; sf.onLine(h); });
  sf.offLine(onLine);

  return { fen, bestMove, lines: lines.sort((a,b)=>a.multipv-b.multipv).slice(0, multiPv) };
}

/* ====== GAME EVAL ====== */
async function evaluateGameAll(sf, fens, uciMoves, depth, multiPv, progressId){
  const positions = []; const moves = [];
  for (let i = 0; i < fens.length; i++) {
    const fen = fens[i];

    // Отправим в движок, дождёмся bestmove
    const pos = await evaluatePosition(sf, fen, depth, multiPv);
    positions.push(pos);

    // Прогресс по позициям
    if (progressId) {
      const progress = Math.round(((i + 1) / fens.length) * 100);
      self.postMessage({ id: progressId, type: "progress", value: progress });
    }

    if (i < (uciMoves?.length ?? 0)) {
      const played = uciMoves[i];
      const evalBefore = pos.lines[0]?.cp ?? 0;
      const playedLine = pos.lines.find(l => l.pv[0] === played);
      const evalPlayed = typeof playedLine?.cp === "number" ? playedLine.cp : evalBefore - 50;
      const lossCp = Math.max(0, evalBefore - evalPlayed);

      moves.push({
        idx: i,
        side: i % 2 === 0 ? "w" : "b",
        fen,
        played,
        best: pos.lines[0]?.pv?.[0],
        evalBefore,
        evalPlayed,
        lossCp
      });
    }
  }
  const whiteLosses = moves.filter(m=>m.side==="w").map(m=>m.lossCp||0);
  const blackLosses = moves.filter(m=>m.side==="b").map(m=>m.lossCp||0);
  const acplWhite = Math.round(avg(whiteLosses));
  const acplBlack = Math.round(avg(blackLosses));
  const accW = Math.round(accuracyFromAcpl(acplWhite)*10)/10;
  const accB = Math.round(accuracyFromAcpl(acplBlack)*10)/10;
  const overall = Math.round(((accW+accB)/2)*10)/10;

  return {
    moves, positions,
    acpl:{white:acplWhite, black:acplBlack},
    accuracy:{white:accW, black:accB, overall},
    settings:{ engine:"stockfish_17.1_modular", depth, multiPv, date:new Date().toISOString() }
  };
}

/* ====== NEXT MOVE AT ELO ====== */
async function nextMoveAtElo(sf, fen, elo, depth){
  await sf.init(); await sf.newGame();
  sf.send("setoption name UCI_LimitStrength value true");
  sf.send(`setoption name UCI_Elo value ${Math.max(600, Math.min(elo, 3000))}`); await sf.waitReadyWithRetry();
  sf.send(`position fen ${fen}`); await sf.waitReadyWithRetry();

  let best;
  const h = (l)=>{ if(l.startsWith("bestmove ")){ best = l.split(/\s+/g)[1]; } };
  sf.onLine(h); sf.send(`go depth ${Math.max(6, depth|0)}`);
  await new Promise((r)=>{ const fin=(l)=>{ if(l.startsWith("bestmove ")){ sf.offLine(fin); r(); } }; sf.onLine(fin); });
  sf.offLine(h);
  return best || "0000";
}

/* ====== ENGINE INSTANCE + READY QUEUE ====== */
LI("engine:init:start");
const sfEngine = new StockfishUci();
LI("engine:init:constructed");

const readyPromise = (async () => {
  await sfEngine.init();
  self.postMessage({ type: "ready" });
  return true;
})().catch((err) => {
  LE("engine:init:error", err);
  self.postMessage({ type: "ready", error: String(err?.message ?? err) });
});
LI("engine:init:done");

const __PENDING__ = []; let __DRAINING__ = false;
function enqueue(msg){ __PENDING__.push(msg); drain(); }
async function drain(){ if(__DRAINING__) return; __DRAINING__=true; try{ await readyPromise; while(__PENDING__.length){ await handleMessage(__PENDING__.shift()); } } finally { __DRAINING__=false; } }

function respond(msg, result, error){
  const took = Date.now() - (msg.__startedAt || Date.now());
  (error ? LE : LI)("respond:" + (error ? "error" : "ok"), { id: msg.id, type: msg.type, tookMs: took, error });
  self.postMessage({ id: msg.id, result, error });
}

async function handleMessage(msg){
  try{
    switch(msg.type){
      case "evaluate-position": {
        const { fen, depth, multiPv } = msg.payload || {};
        const out = await evaluatePosition(
          sfEngine, String(fen),
          Number.isFinite(depth)?+depth:16,
          Number.isFinite(multiPv)?+multiPv:3
        );
        respond(msg, out); break;
      }
      case "evaluate-game": {
        const { fens, uciMoves, depth, multiPv, progressId } = msg.payload || {};
        if (!Array.isArray(fens) || !fens.length) return respond(msg, undefined, "invalid_fens");

        // Фолбэк: если progressId не пришёл, используем id запроса
        const __progressId = progressId || msg.id;

        const out = await evaluateGameAll(
          sfEngine,
          fens.map(String),
          Array.isArray(uciMoves) ? uciMoves.map(String) : undefined,
          Number.isFinite(depth) ? +depth : 16,
          Number.isFinite(multiPv) ? +multiPv : 3,
          __progressId
        );
        respond(msg, out);
        break;
      }
      case "next-move": {
        const { fen, elo, depth } = msg.payload || {};
        const mv = await nextMoveAtElo(sfEngine, String(fen), Number(elo), Number(depth)||12);
        respond(msg, mv); break;
      }
      case "stop": {
        sfEngine.send("stop"); await sfEngine.waitReadyWithRetry(); respond(msg); break;
      }
      default: respond(msg, undefined, "unknown_message_type");
    }
  } catch (err) { respond(msg, undefined, String(err?.message ?? err)); }
}

self.onmessage = (e) => {
  const msg = e?.data;
  if (!msg || !msg.type || !msg.id) return;
  msg.__startedAt = Date.now();
  enqueue(msg);
};
