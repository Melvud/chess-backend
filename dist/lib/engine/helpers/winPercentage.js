"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLineWinPercentage = exports.getPositionWinPercentage = void 0;
const math_1 = require("../../math");
const getPositionWinPercentage = (position) => {
    return (0, exports.getLineWinPercentage)(position.lines[0]);
};
exports.getPositionWinPercentage = getPositionWinPercentage;
const getLineWinPercentage = (line) => {
    if (line.cp !== undefined) {
        return getWinPercentageFromCp(line.cp);
    }
    if (line.mate !== undefined) {
        return getWinPercentageFromMate(line.mate);
    }
    throw new Error("No cp or mate in line");
};
exports.getLineWinPercentage = getLineWinPercentage;
const getWinPercentageFromMate = (mate) => {
    return mate > 0 ? 100 : 0;
};
const getWinPercentageFromCp = (cp) => {
    const cpCeiled = (0, math_1.ceilsNumber)(cp, -1000, 1000);
    const MULTIPLIER = -0.00368208;
    const winChances = 2 / (1 + Math.exp(MULTIPLIER * cpCeiled)) - 1;
    return 50 + 50 * winChances;
};
//# sourceMappingURL=winPercentage.js.map