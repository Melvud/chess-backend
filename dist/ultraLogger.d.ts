import type { Request, Response, NextFunction } from "express";
type LogLevel = "debug" | "info" | "warn" | "error";
export declare function makeReqId(): string;
export declare function log(level: LogLevel, msg: string, meta?: Record<string, any>): void;
export declare function reqLogMiddleware(): (req: Request, res: Response, next: NextFunction) => void;
export declare function withStepLogs<T extends (...args: any[]) => any>(name: string, fn: T): T;
export declare function makeProgressLogger(scope: string, reqId: string, total?: number): {
    onStart(meta?: Record<string, any>): void;
    onProgress(done: number, _total?: number): void;
    onFinish(meta?: Record<string, any>): void;
    onWarn(msg: string, meta?: Record<string, any>): void;
    onError(err: any): void;
};
export {};
//# sourceMappingURL=ultraLogger.d.ts.map