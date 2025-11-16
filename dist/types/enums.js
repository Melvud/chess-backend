"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Color = exports.MoveClassification = exports.EngineName = exports.GameOrigin = void 0;
var GameOrigin;
(function (GameOrigin) {
    GameOrigin["Pgn"] = "pgn";
    GameOrigin["ChessCom"] = "chesscom";
    GameOrigin["Lichess"] = "lichess";
})(GameOrigin || (exports.GameOrigin = GameOrigin = {}));
var EngineName;
(function (EngineName) {
    EngineName["Stockfish17"] = "stockfish_17";
    EngineName["Stockfish17Lite"] = "stockfish_17_lite";
    EngineName["Stockfish16_1"] = "stockfish_16_1";
    EngineName["Stockfish16_1Lite"] = "stockfish_16_1_lite";
    EngineName["Stockfish16NNUE"] = "stockfish_16_nnue";
    EngineName["Stockfish16"] = "stockfish_16";
    EngineName["Stockfish11"] = "stockfish_11";
})(EngineName || (exports.EngineName = EngineName = {}));
var MoveClassification;
(function (MoveClassification) {
    MoveClassification["Blunder"] = "blunder";
    MoveClassification["Mistake"] = "mistake";
    MoveClassification["Inaccuracy"] = "inaccuracy";
    MoveClassification["Okay"] = "okay";
    MoveClassification["Excellent"] = "excellent";
    MoveClassification["Best"] = "best";
    MoveClassification["Forced"] = "forced";
    MoveClassification["Opening"] = "opening";
    MoveClassification["Perfect"] = "perfect";
    MoveClassification["Splendid"] = "splendid";
})(MoveClassification || (exports.MoveClassification = MoveClassification = {}));
var Color;
(function (Color) {
    Color["White"] = "w";
    Color["Black"] = "b";
})(Color || (exports.Color = Color = {}));
//# sourceMappingURL=enums.js.map