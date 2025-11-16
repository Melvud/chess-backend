import { sortLines } from "./engine/helpers/parseResults";
import { LichessError, } from "../types/lichess";
import { formatUciPv } from "./chess";
import { logErrorToSentry } from "./helpers";
export const getLichessEval = async (fen, multiPv = 1) => {
    try {
        const data = await fetchLichessEval(fen, multiPv);
        if ("error" in data) {
            if (data.error === LichessError.NotFound) {
                return {
                    bestMove: "",
                    lines: [],
                };
            }
            throw new Error(data.error);
        }
        const lines = data.pvs.map((pv, index) => ({
            pv: formatUciPv(fen, pv.moves.split(" ")),
            cp: pv.cp,
            mate: pv.mate,
            depth: data.depth,
            multiPv: index + 1,
        }));
        lines.sort(sortLines);
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
        logErrorToSentry(error, { fen, multiPv });
        return {
            bestMove: "",
            lines: [],
        };
    }
};
export const getLichessUserRecentGames = async (username, signal) => {
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
const fetchLichessEval = async (fen, multiPv) => {
    try {
        const res = await fetch(`https://lichess.org/api/cloud-eval?fen=${fen}&multiPv=${multiPv}`, { method: "GET", signal: AbortSignal.timeout(200) });
        return res.json();
    }
    catch (error) {
        console.error(error);
        return { error: LichessError.NotFound };
    }
};
export const fetchLichessGame = async (gameId, signal) => {
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
