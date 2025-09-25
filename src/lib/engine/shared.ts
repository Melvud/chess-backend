import { EngineName } from "@/types/enums";
import * as Stockfish17 from "./stockfish17";

/**
 * Проверка поддержки базового WASM.
 * Работает и в Node, и в браузере.
 */
export const isWasmSupported = (): boolean => {
  try {
    const W = (globalThis as any).WebAssembly;
    if (typeof W !== "object" || typeof W.validate !== "function") return false;

    // \0asm + версия 1 (0x01 0x00 0x00 0x00)
    const magic = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    return !!W.validate(magic);
  } catch {
    return false;
  }
};

/**
 * Проверка поддержки SharedArrayBuffer + запрет на iOS (по аналогии с исходником).
 */
export const isMultiThreadSupported = (): boolean => {
  try {
    const sab = (globalThis as any).SharedArrayBuffer;
    return typeof sab !== "undefined" && !isIosDevice();
  } catch {
    return false;
  }
};

/**
 * iOS определяем безопасно (в Node navigator отсутствует).
 */
export const isIosDevice = (): boolean => {
  try {
    const ua =
      typeof (globalThis as any).navigator?.userAgent === "string"
        ? (globalThis as any).navigator.userAgent
        : "";
    return /iPhone|iPad|iPod/i.test(ua);
  } catch {
    return false;
  }
};

/**
 * Единая точка: поддержан ли указанный движок в текущем окружении.
 * Всегда возвращает boolean (есть default).
 */
export const isEngineSupported = (name: EngineName): boolean => {
  switch (name) {
    case EngineName.Stockfish17:
    case EngineName.Stockfish17Lite:
      // Если модуль экспортирует свою проверку — используем её,
      // иначе — базовую проверку WASM.
      return typeof (Stockfish17 as any).isSupported === "function"
        ? (Stockfish17 as any).isSupported()
        : isWasmSupported();

    // Добавляйте сюда другие двигатели по мере необходимости:
    // case EngineName.Stockfish16:
    //   return ...

    default:
      // По умолчанию — консервативно false.
      return false;
  }
};
