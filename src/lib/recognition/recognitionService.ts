import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import pino from "pino";

const log = pino({ name: "recognition-service" }).child({ srv: "python-ml" });

class RecognitionService {
  private child: ChildProcess | null = null;
  private url: string;
  private startingPromise: Promise<void> | null = null;

  constructor(url: string = "http://127.0.0.1:8000") {
    this.url = url;
  }

  async ensureReady(): Promise<void> {
    // If already running and healthy, do nothing
    if (this.child) {
      try {
        const res = await fetch(`${this.url}/health`);
        if (res.ok) return;
      } catch (e) {
        log.warn("Service marked as running but health check failed, restarting...");
        this.stop();
      }
    }

    if (this.startingPromise) return this.startingPromise;

    this.startingPromise = (async () => {
      try {
        log.info("Starting Python Recognition Service...");
        
        const scriptPath = path.join(process.cwd(), "chessml/fastapi_server.py");
        
        this.child = spawn("python3", [scriptPath], {
          stdio: "inherit",
          env: { ...process.env, PYTHON_PORT: "8000" }
        });

        this.child.on("exit", (code) => {
          if (code !== 0 && code !== null) {
            log.error({ code }, "Python Recognition Service crashed");
          } else {
            log.info("Python Recognition Service stopped");
          }
          this.child = null;
        });

        // Wait for health check
        const maxRetries = 60;
        for (let i = 0; i < maxRetries; i++) {
          try {
            const res = await fetch(`${this.url}/health`);
            if (res.ok) {
              log.info("Python Recognition Service is ready");
              return;
            }
          } catch (e) {
            // Wait and retry
          }
          await new Promise(r => setTimeout(r, 2000));
          if ((i + 1) % 5 === 0) {
            log.info(`Still waiting for Python service (${i + 1}/${maxRetries})...`);
          }
        }

        throw new Error("Python recognition service failed to start within timeout");
      } catch (e) {
        this.stop();
        throw e;
      } finally {
        this.startingPromise = null;
      }
    })();

    return this.startingPromise;
  }

  stop() {
    if (this.child) {
      log.info("Stopping Python Recognition Service (IDLE)...");
      this.child.kill();
      this.child = null;
    }
    this.startingPromise = null;
  }

  isRunning(): boolean {
    return !!this.child;
  }
}

export const recognitionService = new RecognitionService(
  process.env.RECOGNITION_SERVICE_URL || "http://127.0.0.1:8000"
);
