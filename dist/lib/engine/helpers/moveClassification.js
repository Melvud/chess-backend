import { getLineWinPercentage, getPositionWinPercentage, } from "./winPercentage";
import { MoveClassification } from "../../../types/enums";
import { openings } from "../../../data/openings";
import { getIsPieceSacrifice, isSimplePieceRecapture } from "../../../lib/chess";
export const getMovesClassification = (rawPositions, uciMoves, fens) => {
    const positionsWinPercentage = rawPositions.map(getPositionWinPercentage);
    let currentOpening = undefined;
    const positions = rawPositions.map((rawPosition, index) => {
        if (index === 0)
            return rawPosition;
        const currentFen = fens[index].split(" ")[0];
        const opening = openings.find((opening) => opening.fen === currentFen);
        if (opening) {
            currentOpening = opening.name;
            return {
                ...rawPosition,
                opening: opening.name,
                moveClassification: MoveClassification.Opening,
            };
        }
        const prevPosition = rawPositions[index - 1];
        if (prevPosition.lines.length === 1) {
            return {
                ...rawPosition,
                opening: currentOpening,
                moveClassification: MoveClassification.Forced,
            };
        }
        const playedMove = uciMoves[index - 1];
        const lastPositionAlternativeLine = prevPosition.lines.filter((line) => line.pv[0] !== playedMove)?.[0];
        const lastPositionAlternativeLineWinPercentage = lastPositionAlternativeLine
            ? getLineWinPercentage(lastPositionAlternativeLine)
            : undefined;
        const bestLinePvToPlay = rawPosition.lines[0].pv;
        const lastPositionWinPercentage = positionsWinPercentage[index - 1];
        const positionWinPercentage = positionsWinPercentage[index];
        const isWhiteMove = index % 2 === 1;
        if (isSplendidMove(lastPositionWinPercentage, positionWinPercentage, isWhiteMove, playedMove, bestLinePvToPlay, fens[index - 1], lastPositionAlternativeLineWinPercentage)) {
            return {
                ...rawPosition,
                opening: currentOpening,
                moveClassification: MoveClassification.Splendid,
            };
        }
        const fenTwoMovesAgo = index > 1 ? fens[index - 2] : null;
        const uciNextTwoMoves = index > 1 ? [uciMoves[index - 2], uciMoves[index - 1]] : null;
        if (isPerfectMove(lastPositionWinPercentage, positionWinPercentage, isWhiteMove, lastPositionAlternativeLineWinPercentage, fenTwoMovesAgo, uciNextTwoMoves)) {
            return {
                ...rawPosition,
                opening: currentOpening,
                moveClassification: MoveClassification.Perfect,
            };
        }
        if (playedMove === prevPosition.bestMove) {
            return {
                ...rawPosition,
                opening: currentOpening,
                moveClassification: MoveClassification.Best,
            };
        }
        const moveClassification = getMoveBasicClassification(lastPositionWinPercentage, positionWinPercentage, isWhiteMove);
        return {
            ...rawPosition,
            opening: currentOpening,
            moveClassification,
        };
    });
    return positions;
};
const getMoveBasicClassification = (lastPositionWinPercentage, positionWinPercentage, isWhiteMove) => {
    const winPercentageDiff = (positionWinPercentage - lastPositionWinPercentage) *
        (isWhiteMove ? 1 : -1);
    if (winPercentageDiff < -20)
        return MoveClassification.Blunder;
    if (winPercentageDiff < -10)
        return MoveClassification.Mistake;
    if (winPercentageDiff < -5)
        return MoveClassification.Inaccuracy;
    if (winPercentageDiff < -2)
        return MoveClassification.Okay;
    return MoveClassification.Excellent;
};
const isSplendidMove = (lastPositionWinPercentage, positionWinPercentage, isWhiteMove, playedMove, bestLinePvToPlay, fen, lastPositionAlternativeLineWinPercentage) => {
    if (!lastPositionAlternativeLineWinPercentage)
        return false;
    const winPercentageDiff = (positionWinPercentage - lastPositionWinPercentage) *
        (isWhiteMove ? 1 : -1);
    if (winPercentageDiff < -2)
        return false;
    const isPieceSacrifice = getIsPieceSacrifice(fen, playedMove, bestLinePvToPlay);
    if (!isPieceSacrifice)
        return false;
    if (isLosingOrAlternateCompletelyWinning(positionWinPercentage, lastPositionAlternativeLineWinPercentage, isWhiteMove)) {
        return false;
    }
    return true;
};
const isLosingOrAlternateCompletelyWinning = (positionWinPercentage, lastPositionAlternativeLineWinPercentage, isWhiteMove) => {
    const isLosing = isWhiteMove
        ? positionWinPercentage < 50
        : positionWinPercentage > 50;
    const isAlternateCompletelyWinning = isWhiteMove
        ? lastPositionAlternativeLineWinPercentage > 97
        : lastPositionAlternativeLineWinPercentage < 3;
    return isLosing || isAlternateCompletelyWinning;
};
const isPerfectMove = (lastPositionWinPercentage, positionWinPercentage, isWhiteMove, lastPositionAlternativeLineWinPercentage, fenTwoMovesAgo, uciMoves) => {
    if (!lastPositionAlternativeLineWinPercentage)
        return false;
    const winPercentageDiff = (positionWinPercentage - lastPositionWinPercentage) *
        (isWhiteMove ? 1 : -1);
    if (winPercentageDiff < -2)
        return false;
    if (fenTwoMovesAgo &&
        uciMoves &&
        isSimplePieceRecapture(fenTwoMovesAgo, uciMoves))
        return false;
    if (isLosingOrAlternateCompletelyWinning(positionWinPercentage, lastPositionAlternativeLineWinPercentage, isWhiteMove)) {
        return false;
    }
    const hasChangedGameOutcome = getHasChangedGameOutcome(lastPositionWinPercentage, positionWinPercentage, isWhiteMove);
    const isTheOnlyGoodMove = getIsTheOnlyGoodMove(positionWinPercentage, lastPositionAlternativeLineWinPercentage, isWhiteMove);
    return hasChangedGameOutcome || isTheOnlyGoodMove;
};
const getHasChangedGameOutcome = (lastPositionWinPercentage, positionWinPercentage, isWhiteMove) => {
    const winPercentageDiff = (positionWinPercentage - lastPositionWinPercentage) *
        (isWhiteMove ? 1 : -1);
    return (winPercentageDiff > 10 &&
        ((lastPositionWinPercentage < 50 && positionWinPercentage > 50) ||
            (lastPositionWinPercentage > 50 && positionWinPercentage < 50)));
};
const getIsTheOnlyGoodMove = (positionWinPercentage, lastPositionAlternativeLineWinPercentage, isWhiteMove) => {
    const winPercentageDiff = (positionWinPercentage - lastPositionAlternativeLineWinPercentage) *
        (isWhiteMove ? 1 : -1);
    return winPercentageDiff > 10;
};
