"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchLichessGame = exports.getLichessUserRecentGames = exports.getLichessEval = void 0;
const parseResults_1 = require("./engine/helpers/parseResults");
const lichess_1 = require("../types/lichess");
const chess_1 = require("./chess");
const helpers_1 = require("./helpers");
const getLichessEval = async (fen, multiPv = 1) => {
    try {
        const data = await fetchLichessEval(fen, multiPv);
        if ("error" in data) {
            if (data.error === lichess_1.LichessError.NotFound) {
                return {
                    bestMove: "",
                    lines: [],
                };
            }
            throw new Error(data.error);
        }
        const lines = data.pvs.map((pv, index) => ({
            pv: (0, chess_1.formatUciPv)(fen, pv.moves.split(" ")),
            cp: pv.cp,
            mate: pv.mate,
            depth: data.depth,
            multiPv: index + 1,
        }));
        lines.sort(parseResults_1.sortLines);
        const isWhiteToPlay = fen.split(" ")[1] === "w";
        if (!isWhiteToPlay)
            lines.reverse();
        const bestMove = lines[0].pv[0];
        const linesToKeep = lines.slice(0, multiPv);
        return {
            bestMove,
            lines: linesToKeep,
        };
    }
    catch (error) {
        (0, helpers_1.logErrorToSentry)(error, { fen, multiPv });
        return {
            bestMove: "",
            lines: [],
        };
    }
};
exports.getLichessEval = getLichessEval;
const getLichessUserRecentGames = async (username, signal) => {
    const res = await fetch(`https://lichess.org/api/games/user/${username}?until=${Date.now()}&max=50&pgnInJson=true&sort=dateDesc&clocks=true`, { method: "GET", headers: { accept: "application/x-ndjson" }, signal });
    if (res.status >= 400) {
        throw new Error("Error fetching games from Lichess");
    }
    const rawData = await res.text();
    const games = rawData
        .split("\n")
        .filter((game) => game.length > 0)
        .map((game) => JSON.parse(game));
    return games.map(formatLichessGame);
};
exports.getLichessUserRecentGames = getLichessUserRecentGames;
const fetchLichessEval = async (fen, multiPv) => {
    try {
        const res = await fetch(`https://lichess.org/api/cloud-eval?fen=${fen}&multiPv=${multiPv}`, { method: "GET", signal: AbortSignal.timeout(200) });
        return res.json();
    }
    catch (error) {
        console.error(error);
        return { error: lichess_1.LichessError.NotFound };
    }
};
const fetchLichessGame = async (gameId, signal) => {
    try {
        const res = await fetch(`https://lichess.org/game/export/${gameId}?pgnInJson=true&clocks=true`, { method: "GET", headers: { accept: "application/x-ndjson" }, signal });
        if (res.status >= 400) {
            throw new Error(`Error fetching game ${gameId} from Lichess`);
        }
        const gameData = await res.json();
        return gameData.pgn;
    }
    catch (error) {
        console.error(error);
        return { error: error instanceof Error ? error.message : "Unknown error" };
    }
};
exports.fetchLichessGame = fetchLichessGame;
const formatLichessGame = (data) => {
    return {
        id: data.id,
        pgn: data.pgn || "",
        white: {
            name: data.players.white.user?.name || "White",
            rating: data.players.white.rating,
            title: data.players.white.user?.title,
        },
        black: {
            name: data.players.black.user?.name || "Black",
            rating: data.players.black.rating,
            title: data.players.black.user?.title,
        },
        result: getGameResult(data),
        timeControl: `${Math.floor((data.clock?.initial ?? 0) / 60)}+${data.clock?.increment ?? 0}`,
        date: new Date(data.createdAt || data.lastMoveAt).toLocaleDateString(),
        movesNb: data.moves?.split(" ").length || 0,
        url: `https://lichess.org/${data.id}`,
    };
};
const getGameResult = (data) => {
    if (data.status === "draw")
        return "1/2-1/2";
    if (data.winner)
        return data.winner === "white" ? "1-0" : "0-1";
    return "*";
};
//# sourceMappingURL=lichess.js.map