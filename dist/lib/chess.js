"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatUciPv = exports.getLineEvalLabel = exports.isCheck = exports.getMaterialDifference = exports.getIsPieceSacrifice = exports.isSimplePieceRecapture = exports.uciMoveParams = exports.getWhoIsCheckmated = exports.getIsStalemate = exports.getEvaluationBarValue = exports.moveLineUciToSan = exports.setGameHeaders = exports.getGameToSave = exports.formatGameToDatabase = exports.getGameFromPgn = exports.getEvaluateGameParams = void 0;
const chess_js_1 = require("chess.js");
const winPercentage_1 = require("./engine/helpers/winPercentage");
const getEvaluateGameParams = (game) => {
    const history = game.history({ verbose: true });
    const fens = history.map((move) => move.before);
    fens.push(history[history.length - 1].after);
    const uciMoves = history.map((move) => move.from + move.to + (move.promotion || ""));
    return { fens, uciMoves };
};
exports.getEvaluateGameParams = getEvaluateGameParams;
const getGameFromPgn = (pgn) => {
    const game = new chess_js_1.Chess();
    game.loadPgn(pgn);
    return game;
};
exports.getGameFromPgn = getGameFromPgn;
const formatGameToDatabase = (game) => {
    const headers = game.getHeaders();
    return {
        pgn: game.pgn(),
        event: headers.Event,
        site: headers.Site,
        date: headers.Date,
        round: headers.Round ?? "?",
        white: {
            name: headers.White || "White",
            rating: headers.WhiteElo ? Number(headers.WhiteElo) : undefined,
        },
        black: {
            name: headers.Black || "Black",
            rating: headers.BlackElo ? Number(headers.BlackElo) : undefined,
        },
        result: headers.Result,
        termination: headers.Termination,
        timeControl: headers.TimeControl,
    };
};
exports.formatGameToDatabase = formatGameToDatabase;
const getGameToSave = (game, board) => {
    if (game.history().length)
        return game;
    return (0, exports.setGameHeaders)(board);
};
exports.getGameToSave = getGameToSave;
const setGameHeaders = (game, params = {}) => {
    game.setHeader("Event", "Chesskit Game");
    game.setHeader("Site", "Chesskit.org");
    game.setHeader("Date", new Date().toISOString().split("T")[0].replace(/-/g, "."));
    const { white, black, resigned } = params;
    const whiteHeader = game.getHeaders().White;
    const blackHeader = game.getHeaders().Black;
    const whiteName = white?.name || (whiteHeader !== "?" ? whiteHeader : "White");
    const blackName = black?.name || (blackHeader !== "?" ? blackHeader : "Black");
    game.setHeader("White", whiteName);
    game.setHeader("Black", blackName);
    if (white?.rating)
        game.setHeader("WhiteElo", `${white.rating}`);
    if (black?.rating)
        game.setHeader("BlackElo", `${black.rating}`);
    if (resigned) {
        game.setHeader("Result", resigned === "w" ? "0-1" : "1-0");
        game.setHeader("Termination", `${resigned === "w" ? blackName : whiteName} won by resignation`);
    }
    if (!game.isGameOver())
        return game;
    if (game.isCheckmate()) {
        game.setHeader("Result", game.turn() === "w" ? "0-1" : "1-0");
        game.setHeader("Termination", `${game.turn() === "w" ? blackName : whiteName} won by checkmate`);
    }
    if (game.isInsufficientMaterial()) {
        game.setHeader("Result", "1/2-1/2");
        game.setHeader("Termination", "Draw by insufficient material");
    }
    if (game.isStalemate()) {
        game.setHeader("Result", "1/2-1/2");
        game.setHeader("Termination", "Draw by stalemate");
    }
    if (game.isThreefoldRepetition()) {
        game.setHeader("Result", "1/2-1/2");
        game.setHeader("Termination", "Draw by threefold repetition");
    }
    return game;
};
exports.setGameHeaders = setGameHeaders;
const moveLineUciToSan = (fen) => {
    const game = new chess_js_1.Chess(fen);
    return (moveUci) => {
        try {
            const move = game.move((0, exports.uciMoveParams)(moveUci));
            return move.san;
        }
        catch {
            return moveUci;
        }
    };
};
exports.moveLineUciToSan = moveLineUciToSan;
const getEvaluationBarValue = (position) => {
    const whiteBarPercentage = (0, winPercentage_1.getPositionWinPercentage)(position);
    const bestLine = position.lines[0];
    if (bestLine.mate) {
        return { label: `M${Math.abs(bestLine.mate)}`, whiteBarPercentage };
    }
    const cp = bestLine.cp;
    if (!cp)
        return { whiteBarPercentage, label: "0.0" };
    const pEval = Math.abs(cp) / 100;
    let label = pEval.toFixed(1);
    if (label.toString().length > 3) {
        label = pEval.toFixed(0);
    }
    return { whiteBarPercentage, label };
};
exports.getEvaluationBarValue = getEvaluationBarValue;
const getIsStalemate = (fen) => {
    const game = new chess_js_1.Chess(fen);
    return game.isStalemate();
};
exports.getIsStalemate = getIsStalemate;
const getWhoIsCheckmated = (fen) => {
    const game = new chess_js_1.Chess(fen);
    if (!game.isCheckmate())
        return null;
    return game.turn();
};
exports.getWhoIsCheckmated = getWhoIsCheckmated;
const uciMoveParams = (uciMove) => ({
    from: uciMove.slice(0, 2),
    to: uciMove.slice(2, 4),
    promotion: uciMove.slice(4, 5) || undefined,
});
exports.uciMoveParams = uciMoveParams;
const isSimplePieceRecapture = (fen, uciMoves) => {
    const game = new chess_js_1.Chess(fen);
    const moves = uciMoves.map((uciMove) => (0, exports.uciMoveParams)(uciMove));
    if (moves[0].to !== moves[1].to)
        return false;
    const piece = game.get(moves[0].to);
    if (piece)
        return true;
    return false;
};
exports.isSimplePieceRecapture = isSimplePieceRecapture;
const getIsPieceSacrifice = (fen, playedMove, bestLinePvToPlay) => {
    if (!bestLinePvToPlay.length)
        return false;
    const game = new chess_js_1.Chess(fen);
    const whiteToPlay = game.turn() === "w";
    const startingMaterialDifference = (0, exports.getMaterialDifference)(fen);
    let moves = [playedMove, ...bestLinePvToPlay];
    if (moves.length % 2 === 1) {
        moves = moves.slice(0, -1);
    }
    let nonCapturingMovesTemp = 1;
    const capturedPieces = {
        w: [],
        b: [],
    };
    for (const move of moves) {
        try {
            const fullMove = game.move((0, exports.uciMoveParams)(move));
            if (fullMove.captured) {
                capturedPieces[fullMove.color].push(fullMove.captured);
                nonCapturingMovesTemp = 1;
            }
            else {
                nonCapturingMovesTemp--;
                if (nonCapturingMovesTemp < 0)
                    break;
            }
        }
        catch (e) {
            console.error(e);
            return false;
        }
    }
    for (const p of capturedPieces["w"].slice(0)) {
        if (capturedPieces["b"].includes(p)) {
            capturedPieces["b"].splice(capturedPieces["b"].indexOf(p), 1);
            capturedPieces["w"].splice(capturedPieces["w"].indexOf(p), 1);
        }
    }
    if (Math.abs(capturedPieces["w"].length - capturedPieces["b"].length) <= 1 &&
        capturedPieces["w"].concat(capturedPieces["b"]).every((p) => p === "p")) {
        return false;
    }
    const endingMaterialDifference = (0, exports.getMaterialDifference)(game.fen());
    const materialDiff = endingMaterialDifference - startingMaterialDifference;
    const materialDiffPlayerRelative = whiteToPlay ? materialDiff : -materialDiff;
    return materialDiffPlayerRelative < 0;
};
exports.getIsPieceSacrifice = getIsPieceSacrifice;
const getMaterialDifference = (fen) => {
    const game = new chess_js_1.Chess(fen);
    const board = game.board().flat();
    return board.reduce((acc, square) => {
        if (!square)
            return acc;
        const piece = square.type;
        if (square.color === "w") {
            return acc + getPieceValue(piece);
        }
        return acc - getPieceValue(piece);
    }, 0);
};
exports.getMaterialDifference = getMaterialDifference;
const getPieceValue = (piece) => {
    switch (piece) {
        case "p":
            return 1;
        case "n":
            return 3;
        case "b":
            return 3;
        case "r":
            return 5;
        case "q":
            return 9;
        default:
            return 0;
    }
};
const isCheck = (fen) => {
    const game = new chess_js_1.Chess(fen);
    return game.inCheck();
};
exports.isCheck = isCheck;
const getLineEvalLabel = (line) => {
    if (line.cp !== undefined) {
        return `${line.cp > 0 ? "+" : ""}${(line.cp / 100).toFixed(2)}`;
    }
    if (line.mate) {
        return `${line.mate > 0 ? "+" : "-"}M${Math.abs(line.mate)}`;
    }
    return "?";
};
exports.getLineEvalLabel = getLineEvalLabel;
const formatUciPv = (fen, uciMoves) => {
    const castlingRights = fen.split(" ")[2];
    let canWhiteCastleKingSide = castlingRights.includes("K");
    let canWhiteCastleQueenSide = castlingRights.includes("Q");
    let canBlackCastleKingSide = castlingRights.includes("k");
    let canBlackCastleQueenSide = castlingRights.includes("q");
    return uciMoves.map((uci) => {
        if (uci === "e1h1" && canWhiteCastleKingSide) {
            canWhiteCastleKingSide = false;
            return "e1g1";
        }
        if (uci === "e1a1" && canWhiteCastleQueenSide) {
            canWhiteCastleQueenSide = false;
            return "e1c1";
        }
        if (uci === "e8h8" && canBlackCastleKingSide) {
            canBlackCastleKingSide = false;
            return "e8g8";
        }
        if (uci === "e8a8" && canBlackCastleQueenSide) {
            canBlackCastleQueenSide = false;
            return "e8c8";
        }
        return uci;
    });
};
exports.formatUciPv = formatUciPv;
//# sourceMappingURL=chess.js.map