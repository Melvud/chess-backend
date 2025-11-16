"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWeightedMean = exports.getStandardDeviation = exports.getHarmonicMean = exports.ceilsNumber = void 0;
const ceilsNumber = (number, min, max) => {
    if (number > max)
        return max;
    if (number < min)
        return min;
    return number;
};
exports.ceilsNumber = ceilsNumber;
const getHarmonicMean = (array) => {
    const sum = array.reduce((acc, curr) => acc + 1 / curr, 0);
    return array.length / sum;
};
exports.getHarmonicMean = getHarmonicMean;
const getStandardDeviation = (array) => {
    const n = array.length;
    const mean = array.reduce((a, b) => a + b) / n;
    return Math.sqrt(array.map((x) => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / n);
};
exports.getStandardDeviation = getStandardDeviation;
const getWeightedMean = (array, weights) => {
    if (array.length > weights.length)
        throw new Error("Weights array is too short");
    const weightedSum = array.reduce((acc, curr, index) => acc + curr * weights[index], 0);
    const weightSum = weights
        .slice(0, array.length)
        .reduce((acc, curr) => acc + curr, 0);
    return weightedSum / weightSum;
};
exports.getWeightedMean = getWeightedMean;
//# sourceMappingURL=math.js.map