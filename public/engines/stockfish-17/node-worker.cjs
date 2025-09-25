// public/engines/stockfish-17/node-worker.cjs

/* eslint-disable no-undef */
const { parentPort }    = require('worker_threads');
const vm                = require('vm');
const fs                = require('fs');
const path              = require('path');
const { fileURLToPath } = require('url');

// ---------- tiny logger ----------
const log  = (tag, x) => (x !== undefined ? console.debug(`[SF-NODE:${tag}]`, x) : console.debug(`[SF-NODE:${tag}]`));
const warn = (tag, x) => (x !== undefined ? console.warn(`[SF-NODE:${tag}]`, x) : console.warn(`[SF-NODE:${tag}]`));
const err  = (tag, x) => (x !== undefined ? console.error(`[SF-NODE:${tag}]`, x) : console.error(`[SF-NODE:${tag}]`));

// ---------- helpers ----------
function toFsPath(anyPath) {
  try {
    if (typeof anyPath !== 'string') return String(anyPath || '');
    if (anyPath.startsWith('file://')) return fileURLToPath(anyPath);
    if (anyPath.startsWith('http://') || anyPath.startsWith('https://')) return anyPath; 
    return path.isAbsolute(anyPath) ? anyPath : path.join(__dirname, anyPath);
  } catch (e) {
    warn('toFsPath:error', { anyPath, msg: e.message });
    return anyPath;
  }
}
function readText(p) { return fs.readFileSync(toFsPath(p), 'utf8'); }

// ---------- TextEncoder/TextDecoder minimal polyfill ----------
const hasTextEnc = typeof global.TextEncoder !== 'undefined' && typeof global.TextDecoder !== 'undefined';
if (!hasTextEnc) {
  try {
    const util = require('util');
    global.TextEncoder = util.TextEncoder;
    global.TextDecoder = util.TextDecoder;
  } catch {
    global.TextEncoder = class TextEncoder { encode(str){ return new Uint8Array(Buffer.from(String(str),'utf8')); } };
    global.TextDecoder = class TextDecoder { decode(buf){ const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : (buf instanceof Uint8Array ? buf : new Uint8Array(Buffer.from(String(buf) || ''))); return Buffer.from(u8).toString('utf8'); } };
  }
}

// ---------- XMLHttpRequest polyfill (минимум) ----------
class XhrFilePolyfill {
  constructor() {
    this.readyState = 0;
    this.status = 0;
    this.responseType = '';
    this.response = null;
    this.responseText = '';
    this.onreadystatechange = null;
    this.onload = null;
    this.onerror = null;
    this._url = '';
    this._async = true;
  }
  open(_method, url, async = true) {
    this._url = url;
    this._async = !!async;
    this.readyState = 1;
  }
  _finishOK(bufOrText) {
    this.status = 200;
    if (this.responseType === 'arraybuffer') {
      /** @type {Buffer|Uint8Array|ArrayBuffer|string} */
      let u8;
      if (Buffer.isBuffer(bufOrText)) u8 = new Uint8Array(bufOrText);
      else if (bufOrText instanceof Uint8Array) u8 = bufOrText;
      else if (bufOrText instanceof ArrayBuffer) u8 = new Uint8Array(bufOrText);
      else u8 = new Uint8Array(Buffer.from(String(bufOrText), 'utf8'));
      // точный ArrayBuffer без оффсета
      const ab = u8.byteOffset === 0 && u8.byteLength === (u8.buffer?.byteLength || 0)
        ? u8.buffer
        : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      this.response = ab;
      try { console.debug('[SF-NODE:XHR]', 'OK arraybuffer', { bytes: u8.byteLength, url: this._url }); } catch {}
    } else {
      const text = Buffer.isBuffer(bufOrText) ? bufOrText.toString('utf8') : String(bufOrText ?? '');
      this.responseText = text;
      this.response = text;
      try { console.debug('[SF-NODE:XHR]', 'OK text', { bytes: Buffer.byteLength(text, 'utf8'), url: this._url }); } catch {}
    }
    this.readyState = 4;
    try { this.onreadystatechange && this.onreadystatechange(); } catch {}
    try { this.onload && this.onload(); } catch {}
  }
  _finishErr(e) {
    this.status = 404;
    this.readyState = 4;
    try { console.error('[SF-NODE:XHR]', 'ERR', { url: this._url, msg: e?.message }); } catch {}
    try { this.onerror && this.onerror(e); } catch {}
    try { this.onreadystatechange && this.onreadystatechange(); } catch {}
  }
  send(_body = null) {
    const p = toFsPath(this._url);
    if (this._async === false) {
      try {
        const buf = fs.readFileSync(p);
        this._finishOK(buf);
      } catch (e) {
        this._finishErr(e);
      }
      return;
    }
    fs.readFile(p, (e, buf) => {
      if (e) return this._finishErr(e);
      this._finishOK(buf);
    });
  }
}

// ---------- sandbox ----------
const sandbox = {
  // worker-like API
  postMessage: (msg) => parentPort.postMessage(msg),
  onmessage: undefined,

  // std / timers / perf
  setTimeout, clearTimeout, setInterval, clearInterval,
  performance: global.performance || { now: () => Date.now() },
  console, URL, URLSearchParams,

  // навигация/окружение
  navigator: { userAgent: 'node-worker' },

  // ВАЖНО: передаём require и process для чтения part-файлов
  require: require,
  process: process,
};
sandbox.global = sandbox;
sandbox.self   = sandbox;
sandbox.window = sandbox;

// document для Emscripten (фабрика в document.currentScript._exports)
sandbox.document = { currentScript: { _exports: undefined }, createElement: () => ({}) };

// "адрес" воркера (для относительных путей)
sandbox.location = { href: `file://${path.join(__dirname, 'worker.js')}`, hash: '', toString(){ return this.href; } };

// XHR полифилл в sandbox
sandbox.XMLHttpRequest = XhrFilePolyfill;

// addEventListener/removeEventListener совместимые с WebWorker
(function initEventTargetPolyfill(sb){
  const listeners = { message: new Set(), error: new Set(), messageerror: new Set() };
  sb.addEventListener = function(type, fn){ if (listeners[type]) listeners[type].add(fn); };
  sb.removeEventListener = function(type, fn){ if (listeners[type]) listeners[type].delete(fn); };
  sb.__dispatchEvent = function(type, payload){
    if (!listeners[type]) return;
    listeners[type].forEach((fn) => {
      try { fn(payload); } catch (e) { err('listener', e); }
    });
  };
})(sandbox);

// ---------- importScripts shim ----------
const context = vm.createContext(sandbox);

function importScriptsShim(...urls) {
  for (const u of urls) {
    const abs = toFsPath(u);
    if (!abs || abs.startsWith('http')) throw new Error(`importScripts cannot load non-file URL: ${u}`);
    log('importScripts', abs);

    const prologue =
      `var __filename = ${JSON.stringify(abs)};\n` +
      `var __dirname  = ${JSON.stringify(path.dirname(abs))};\n` +
      `var onmessage  = (typeof onmessage === 'undefined') ? undefined : onmessage;\n` +
      `var global = globalThis;\nvar self = globalThis;\nvar window = globalThis;\n` +
      `if (!globalThis.document) globalThis.document = {};\n` +
      `if (!globalThis.document.currentScript) globalThis.document.currentScript = { _exports: undefined };\n`;

    const code = readText(abs);
    vm.runInContext(prologue + code, context, { filename: abs });
  }
}
sandbox.importScripts = (...args) => importScriptsShim(...args);

// ---------- bridge parentPort -> sandbox.onmessage ----------
parentPort.on('message', (msg) => {
  try {
    // Совместимость: worker.js может использовать self.onmessage ИЛИ addEventListener('message', ...)
    if (typeof sandbox.onmessage === 'function') {
      sandbox.onmessage({ data: msg });
    } else if (typeof sandbox.self?.onmessage === 'function') {
      sandbox.self.onmessage({ data: msg });
    }
    // всегда продублируем в EventTarget стиль
    sandbox.__dispatchEvent('message', { data: msg });
  } catch (e) {
    err('onmessage:dispatch', e);
  }
});

// postMessage уже замкнут на parentPort
sandbox.postMessage = (data) => parentPort.postMessage(data);

// ---------- boot ----------
try {
  const workerJs = path.join(__dirname, 'worker.js');
  log('boot', { workerJs });
  importScriptsShim(workerJs);
} catch (e) {
  err('boot', e);
  parentPort.postMessage({ type: 'ready', error: String(e?.message || e) });
}
