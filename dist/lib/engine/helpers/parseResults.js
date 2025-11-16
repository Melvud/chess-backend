"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getResultProperty = exports.sortLines = exports.parseEvaluationResults = void 0;
const chess_1 = require("../../chess");
const parseEvaluationResults = (results, fen) => {
    const parsedResults = {
        lines: [],
    };
    const tempResults = {};
    for (const result of results) {
        if (result.startsWith("bestmove")) {
            const bestMove = (0, exports.getResultProperty)(result, "bestmove");
            if (bestMove) {
                parsedResults.bestMove = bestMove;
            }
        }
        if (result.startsWith("info")) {
            const pv = getResultPv(result, fen);
            const multiPv = (0, exports.getResultProperty)(result, "multipv");
            const depth = (0, exports.getResultProperty)(result, "depth");
            if (!pv || !multiPv || !depth)
                continue;
            if (tempResults[multiPv] &&
                parseInt(depth) < tempResults[multiPv].depth) {
                continue;
            }
            const cp = (0, exports.getResultProperty)(result, "cp");
            const mate = (0, exports.getResultProperty)(result, "mate");
            tempResults[multiPv] = {
                pv,
                cp: cp ? parseInt(cp) : undefined,
                mate: mate ? parseInt(mate) : undefined,
                depth: parseInt(depth),
                multiPv: parseInt(multiPv),
            };
        }
    }
    parsedResults.lines = Object.values(tempResults).sort(exports.sortLines);
    const whiteToPlay = fen.split(" ")[1] === "w";
    if (!whiteToPlay) {
        parsedResults.lines = parsedResults.lines.map((line) => ({
            ...line,
            cp: line.cp ? -line.cp : line.cp,
            mate: line.mate ? -line.mate : line.mate,
        }));
    }
    return parsedResults;
};
exports.parseEvaluationResults = parseEvaluationResults;
const sortLines = (a, b) => {
    if (a.mate !== undefined && b.mate !== undefined) {
        if (a.mate > 0 && b.mate < 0)
            return -1;
        if (a.mate < 0 && b.mate > 0)
            return 1;
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
exports.sortLines = sortLines;
const getResultProperty = (result, property) => {
    const splitResult = result.split(" ");
    const propertyIndex = splitResult.indexOf(property);
    if (propertyIndex === -1 || propertyIndex + 1 >= splitResult.length) {
        return undefined;
    }
    return splitResult[propertyIndex + 1];
};
exports.getResultProperty = getResultProperty;
const getResultPv = (result, fen) => {
    const splitResult = result.split(" ");
    const pvIndex = splitResult.indexOf("pv");
    if (pvIndex === -1 || pvIndex + 1 >= splitResult.length) {
        return undefined;
    }
    const rawPv = splitResult.slice(pvIndex + 1);
    return (0, chess_1.formatUciPv)(fen, rawPv);
};
//# sourceMappingURL=parseResults.js.map