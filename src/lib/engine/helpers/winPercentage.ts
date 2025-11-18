import { ceilsNumber } from "@/lib/math";
import { LineEval, PositionEval } from "@/types/eval";

export const getPositionWinPercentage = (position: PositionEval): number => {
  return getLineWinPercentage(position.lines[0]);
};

export const getLineWinPercentage = (line: LineEval): number => {
  if (line.cp !== undefined) {
    return getWinPercentageFromCp(line.cp);
  }

  if (line.mate !== undefined) {
    return getWinPercentageFromMate(line.mate);
  }

  throw new Error("No cp or mate in line");
};

const getWinPercentageFromMate = (mate: number): number => {
  // КРИТИЧНО: mate должен быть > 0 или < 0, НЕ >= 0!
  // mate > 0 = белые выигрывают (мат в пользу белых)
  // mate < 0 = черные выигрывают (мат в пользу черных)
  // mate === 0 = НЕ ДОЛЖНО существовать после нормализации
  if (mate > 0) return 100;
  if (mate < 0) return 0;
  
  // mate === 0 - ошибка, возвращаем 50% для безопасности
  console.warn(`⚠️ WARNING: mate=0 detected! This should not happen after parseResults.ts normalization.`);
  return 50;
};

const getWinPercentageFromCp = (cp: number): number => {
  const cpCeiled = ceilsNumber(cp, -1000, 1000);
  const MULTIPLIER = -0.00368208;
  const winChances = 2 / (1 + Math.exp(MULTIPLIER * cpCeiled)) - 1;
  return 50 + 50 * winChances;
};