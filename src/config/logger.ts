/**
 * Application-wide structured logger built on Winston.
 *
 * Outputs:
 *  - Development: colorized, human-readable console output with stack traces.
 *  - Production : JSON lines to stdout so container log drivers can forward them.
 *
 * Usage:
 *   import { logger } from "./config/logger";
 *   logger.info("Server started", { port: 4000 });
 *   logger.error("Database error", { err });
 */
import winston from "winston";

const isDev = process.env.NODE_ENV !== "production";

const devFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: "HH:mm:ss" }),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length
      ? "\n" + JSON.stringify(meta, null, 2)
      : "";
    return `${timestamp as string} [${level}] ${String(message)}${metaStr}`;
  }),
);

const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

export const logger = winston.createLogger({
  level: isDev ? "debug" : "info",
  format: isDev ? devFormat : prodFormat,
  transports: [new winston.transports.Console()],
  // Never crash the process on logger errors
  exitOnError: false,
});
