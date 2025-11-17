"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeAccuracy = void 0;
const math_1 = require("../../math");
const winPercentage_1 = require("./winPercentage");
const computeAccuracy = (positions) => {
    const positionsWinPercentage = positions.map(winPercentage_1.getPositionWinPercentage);
    const weights = getAccuracyWeights(positionsWinPercentage);
    const movesAccuracy = getMovesAccuracy(positionsWinPercentage);
    const whiteAccuracy = getPlayerAccuracy(movesAccuracy, weights, "white");
    const blackAccuracy = getPlayerAccuracy(movesAccuracy, weights, "black");
    return {
        white: whiteAccuracy,
        black: blackAccuracy,
    };
};
exports.computeAccuracy = computeAccuracy;
const getPlayerAccuracy = (movesAccuracy, weights, player) => {
    const remainder = player === "white" ? 0 : 1;
    const playerAccuracies = movesAccuracy.filter((_, index) => index % 2 === remainder);
    const playerWeights = weights.filter((_, index) => index % 2 === remainder);
    const weightedMean = (0, math_1.getWeightedMean)(playerAccuracies, playerWeights);
    const harmonicMean = (0, math_1.getHarmonicMean)(playerAccuracies);
    return (weightedMean + harmonicMean) / 2;
};
const getAccuracyWeights = (movesWinPercentage) => {
    const windowSize = (0, math_1.ceilsNumber)(Math.ceil(movesWinPercentage.length / 10), 2, 8);
    const windows = [];
    const halfWindowSize = Math.round(windowSize / 2);
    for (let i = 1; i < movesWinPercentage.length; i++) {
        const startIdx = i - halfWindowSize;
        const endIdx = i + halfWindowSize;
        if (startIdx < 0) {
            windows.push(movesWinPercentage.slice(0, windowSize));
            continue;
        }
        if (endIdx > movesWinPercentage.length) {
            windows.push(movesWinPercentage.slice(-windowSize));
            continue;
        }
        windows.push(movesWinPercentage.slice(startIdx, endIdx));
    }
    const weights = windows.map((window) => {
        const std = (0, math_1.getStandardDeviation)(window);
        return (0, math_1.ceilsNumber)(std, 0.5, 12);
    });
    return weights;
};
const getMovesAccuracy = (movesWinPercentage) => movesWinPercentage.slice(1).map((winPercent, index) => {
    const lastWinPercent = movesWinPercentage[index];
    const isWhiteMove = index % 2 === 0;
    const winDiff = isWhiteMove
        ? Math.max(0, lastWinPercent - winPercent)
        : Math.max(0, winPercent - lastWinPercent);
    const rawAccuracy = 103.1668100711649 * Math.exp(-0.04354415386753951 * winDiff) -
        3.166924740191411;
    return Math.min(100, Math.max(0, rawAccuracy + 1));
});
//# sourceMappingURL=accuracy.js.map