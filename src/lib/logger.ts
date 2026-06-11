type LogLevel = "INFO" | "WARN" | "ERROR";

export function createLogger(source: string) {
  const log = (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    console.log(`[${timestamp}] [${source}] ${level}: ${message}${metaStr}`);
  };

  return {
    info: (msg: string, meta?: Record<string, unknown>) => log("INFO", msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => log("WARN", msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => log("ERROR", msg, meta),
  };
}
