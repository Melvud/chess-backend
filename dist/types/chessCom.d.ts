export interface ChessComGame {
    uuid?: string;
    id?: string;
    url?: string;
    pgn: string;
    end_time: number;
    time_control?: string;
    white?: {
        username?: string;
        rating?: number;
        title?: string;
    };
    black?: {
        username?: string;
        rating?: number;
        title?: string;
    };
}
//# sourceMappingURL=chessCom.d.ts.map