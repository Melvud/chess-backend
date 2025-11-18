import { formatUciPv } from "@/lib/chess";
import { LineEval, PositionEval } from "@/types/eval";

export const parseEvaluationResults = (
  results: string[],
  fen: string
): PositionEval => {
  const parsedResults: PositionEval = {
    lines: [],
  };
  const tempResults: Record<string, LineEval> = {};

  for (const result of results) {
    if (result.startsWith("bestmove")) {
      const bestMove = getResultProperty(result, "bestmove");
      if (bestMove) {
        parsedResults.bestMove = bestMove;
      }
    }

    if (result.startsWith("info")) {
      const pv = getResultPv(result, fen);
      const multiPv = getResultProperty(result, "multipv");
      const depth = getResultProperty(result, "depth");
      if (!pv || !multiPv || !depth) continue;

      if (
        tempResults[multiPv] &&
        parseInt(depth) < tempResults[multiPv].depth
      ) {
        continue;
      }

      const cp = getResultProperty(result, "cp");
      const mate = getResultProperty(result, "mate");

      tempResults[multiPv] = {
        pv,
        cp: cp ? parseInt(cp) : undefined,
        mate: mate ? parseInt(mate) : undefined,
        depth: parseInt(depth),
        multiPv: parseInt(multiPv),
      };
    }
  }

  parsedResults.lines = Object.values(tempResults).sort(sortLines);

  const whiteToPlay = fen.split(" ")[1] === "w";

  // Нормализация оценок к перспективе белых (positive = белые выигрывают)
  parsedResults.lines = parsedResults.lines.map((line) => {
    let normalizedCp = line.cp;
    let normalizedMate = line.mate;

    if (!whiteToPlay) {
      // Ход черных - инвертируем знаки для перспективы белых
      normalizedCp = line.cp !== undefined ? -line.cp : undefined;
      normalizedMate = line.mate !== undefined
        ? (line.mate === 0 ? 1 : -line.mate)  // mate:0 означает черные заматованы → +1 для белых
        : undefined;
    } else {
      // Ход белых - обрабатываем особый случай mate:0
      normalizedMate = line.mate !== undefined
        ? (line.mate === 0 ? -1 : line.mate)  // mate:0 означает белые заматованы → -1
        : undefined;
    }

    return {
      ...line,
      cp: normalizedCp,
      mate: normalizedMate,
    };
  });

  return parsedResults;
};

export const sortLines = (a: LineEval, b: LineEval): number => {
  if (a.mate !== undefined && b.mate !== undefined) {
    if (a.mate > 0 && b.mate < 0) return -1;
    if (a.mate < 0 && b.mate > 0) return 1;
    return a.mate - b.mate;
  }

  if (a.mate !== undefined) {
    return -a.mate;
  }

  if (b.mate !== undefined) {
    return b.mate;
  }

  return (b.cp ?? 0) - (a.cp ?? 0);
};

export const getResultProperty = (
  result: string,
  property: string
): string | undefined => {
  const splitResult = result.split(" ");
  const propertyIndex = splitResult.indexOf(property);

  if (propertyIndex === -1 || propertyIndex + 1 >= splitResult.length) {
    return undefined;
  }

  return splitResult[propertyIndex + 1];
};

const getResultPv = (result: string, fen: string): string[] | undefined => {
  const splitResult = result.split(" ");
  const pvIndex = splitResult.indexOf("pv");

  if (pvIndex === -1 || pvIndex + 1 >= splitResult.length) {
    return undefined;
  }

  const rawPv = splitResult.slice(pvIndex + 1);
  return formatUciPv(fen, rawPv);
};