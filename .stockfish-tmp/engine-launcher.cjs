
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const engineFsPath = workerData.engineFsPath;
const engineDir = path.dirname(engineFsPath);
const engineDirFileURL = pathToFileURL(engineDir + path.sep).toString();

// --- Эмуляция web worker окружения ---
globalThis.self = globalThis;
globalThis.navigator = { userAgent: 'NodeWorker/Stockfish' };
globalThis.location = { href: engineDirFileURL };

// fetch c поддержкой file:// (TS-типы нас не волнуют в воркере)
globalThis.fetch = async function(url, init) {
  const u = typeof url === 'string' ? url : url.toString();
  if (u.startsWith('file://')) {
    const filePath = new URL(u);
    const buf = fs.readFileSync(filePath);
    // "Response" нет в node по-умолчанию, симулируем простейший интерфейс
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      text: async () => buf.toString('utf8'),
      json: async () => JSON.parse(buf.toString('utf8')),
    };
  }
  // На всякий случай: позволяем http/https если вдруг понадобится
  const nodeFetch = (await import('node-fetch')).default;
  return nodeFetch(u, init);
};

// importScripts-эмуляция
globalThis.importScripts = function(...urls) {
  for (const url of urls) {
    const u = typeof url === 'string' ? url : url.toString();
    let full;
    if (u.startsWith('file://')) {
      full = new URL(u);
    } else if (u.startsWith('http://') || u.startsWith('https://')) {
      throw new Error('importScripts http/https не поддержан в серверном воркере');
    } else {
      // относительный путь от директории движка
      full = pathToFileURL(path.join(engineDir, u));
    }
    const code = fs.readFileSync(full, 'utf8');
    // Выполняем в текущем контексте
    (0, eval)(code);
  }
};

// Сообщения из движка наружу → к нам, затем -> в main thread
globalThis.postMessage = (data) => parentPort.postMessage(data);

// Сообщения внутрь движка (как в web worker)
globalThis.onmessage = null;
parentPort.on('message', (data) => {
  if (typeof globalThis.onmessage === 'function') {
    globalThis.onmessage({ data });
  }
});

// Загрузим сам движок
const code = fs.readFileSync(engineFsPath, 'utf8');
(0, eval)(code);

// Готово. Движок теперь должен слушать onmessage и писать postMessage().
