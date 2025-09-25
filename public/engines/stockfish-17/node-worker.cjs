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
    open(method, url, async = true) {
      this._url = url;
      this._async = !!async;
      this.readyState = 1;
    }
    _finishOK(bufOrText) {
      this.status = 200;
      if (this.responseType === 'arraybuffer') {
        // НОРМАЛИЗУЕМ В ТОЧНЫЙ ArrayBuffer (без лишнего пула и смещений)
        /** @type {Buffer|Uint8Array} */
        const u8 = Buffer.isBuffer(bufOrText) ? new Uint8Array(bufOrText) :
                   bufOrText instanceof Uint8Array ? bufOrText :
                   new Uint8Array(Buffer.from(String(bufOrText), 'utf8'));
        // Создаём копию-буфер ровно нужной длины
        const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        this.response = ab;
        // Доп. лог для отладки размера
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
        const buf = fs.readFileSync(p);                // бросит, если файла нет
        this._finishOK(buf);
        return;
      }
      fs.readFile(p, (e, buf) => {
        if (e) return this._finishErr(e);              // увидим ENOENT и т.п.
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

// ---------- importScripts shim ----------
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

// ---------- context ----------
const context = vm.createContext(sandbox);
sandbox.importScripts = (...args) => importScriptsShim(...args);

// ---------- bridge parentPort -> sandbox.onmessage ----------
parentPort.on('message', (msg) => {
  try {
    if (typeof sandbox.onmessage === 'function') {
      sandbox.onmessage({ data: msg });
    } else if (typeof sandbox.self?.onmessage === 'function') {
      sandbox.self.onmessage({ data: msg });
    } else {
      // попытка совместимости через addEventListener
      if (typeof sandbox.addEventListener === 'function') {
        sandbox.addEventListener('message', { data: msg });
      } else {
        warn('onmessage:missing', msg);
      }
    }
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