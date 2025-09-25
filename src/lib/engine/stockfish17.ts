import { EngineName } from "@/types/enums";
import { UciEngine } from "./uciEngine";
import { isMultiThreadSupported, isWasmSupported } from "./shared";

/**
 * Обёртка фабрики под Stockfish 17.
 * Никаких упрощений: сохраняем проверки поддержки, выбор lite/не-lite и логику мультитреда.
 * Единственное изменение — в качестве скрипта для Worker используем нашу обёртку worker.js,
 * которая и реализует протокол (progress/result) для UciEngine.
 */
export class Stockfish17 {
  public static async create(lite?: boolean): Promise<UciEngine> {
    if (!Stockfish17.isSupported()) {
      throw new Error("Stockfish 17 is not supported");
    }

    const multiThreadIsSupported = isMultiThreadSupported();
    if (!multiThreadIsSupported) {
      // Не меняем поведение — просто информируем, как и ранее
      console.log("Single thread mode");
    }

    // ВАЖНО: подсовываем именно worker-обёртку, а не сам движок.
    // Обёртка внутри подберёт нужный бандл (lite/обычный, single/multi),
    // и будет пересылать progress/result по нашему протоколу.
    const engineWorkerPath = "engines/stockfish-17/worker.js";

    const engineName = lite
      ? EngineName.Stockfish17Lite
      : EngineName.Stockfish17;

    return UciEngine.create(engineName, engineWorkerPath);
  }

  public static isSupported() {
    return isWasmSupported();
  }
}
