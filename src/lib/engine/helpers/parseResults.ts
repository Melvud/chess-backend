// src/lib/engine/helpers/parseResults.ts
import { formatUciPv } from "@/lib/chess";
import type { LineEval, PositionEval } from "@/types/eval";

/** Сырой item из UCI info; тип либеральный, чтобы не падать на неожиданных полях */
type RawEngineInfo = {
  depth?: number;
  seldepth?: number;
  multipv?: number;
  pv?: string | string[];           // UCI PV: строка или массив
  score?: { cp?: number; mate?: number };
  nps?: number;
  nodes?: number;
  time?: number;                    // мс (встречается как time или t)
  t?: number;                       // мс
  bestmove?: string;
  ponder?: string;
};

const toArray = (pv?: string | string[]): string[] => {
  if (!pv) return [];
  if (Array.isArray(pv)) return pv;
  return pv.trim().length ? pv.trim().split(/\s+/) : [];
};

/** cp как есть; mate N → sign*(32000-|N|) для сортировки по «силе» */
const scoreToSortable = (cp?: number, mate?: number): number | undefined => {
  if (typeof cp === "number" && Number.isFinite(cp)) return cp;
  if (typeof mate === "number" && Number.isFinite(mate)) {
    const sign = Math.sign(mate) || 1;
    const dist = Math.abs(mate);
    return sign * (32000 - dist);
  }
  return undefined;
};

/** Берём самую позднюю/глубокую запись для каждого multipv */
const pickLatestByMultipv = (items: RawEngineInfo[]): RawEngineInfo[] => {
  const byMp = new Map<number, RawEngineInfo>();
  for (const it of items) {
    const mp = (it.multipv ?? 1) | 0;
    const prev = byMp.get(mp);
    if (!prev) {
      byMp.set(mp, it);
      continue;
    }
    const prevDepth = prev.depth ?? 0;
    const curDepth = it.depth ?? 0;
    if (curDepth >= prevDepth) byMp.set(mp, it);
  }
  return [...byMp.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
};

/**
 * Главный парсер: собираем PositionEval из info-объектов и bestmove/ponder.
 * Важно: структура соответствует типам из "@/types/eval".
 */
export const parseEvaluationResults = (
  fen: string,
  entries: RawEngineInfo[],
  best?: { bestmove?: string; ponder?: string }
): PositionEval => {
  const list = Array.isArray(entries) ? entries : [];
  const latest = pickLatestByMultipv(list);

  const lines: LineEval[] = latest.map((raw): LineEval => {
    const cp = raw.score?.cp;
    const mate = raw.score?.mate;

    // ВАЖНО: передаём ОБА аргумента — fen и массив uciMoves
    const uciMoves = toArray(raw.pv);
    const pv = formatUciPv(fen, uciMoves);

    const line: LineEval = {
      multipv: raw.multipv ?? 1,
      depth: raw.depth ?? 0,
      pv,
      nodes: raw.nodes,
      t: (raw.t ?? raw.time) as number | undefined,
      cp,
      mate,
      bestMove: raw.bestmove ?? best?.bestmove,
    } as LineEval;

    return line;
  });

  // стабильная сортировка: multipv, затем сила оценки
  const sorted = [...lines].sort((a, b) => {
    const mpa = a.multipv ?? 1;
    const mpb = b.multipv ?? 1;
    if (mpa !== mpb) return mpa - mpb;
    const sa = scoreToSortable(a.cp, a.mate);
    const sb = scoreToSortable(b.cp, b.mate);
    if (sa == null && sb == null) return 0;
    if (sa == null) return 1;
    if (sb == null) return -1;
    return sb - sa;
  });

  // В верхнем уровне PositionEval нет поля ponder — не добавляем
  const result: PositionEval = {
    lines: sorted,
    bestMove: best?.bestmove,
  };

  return result;
};
