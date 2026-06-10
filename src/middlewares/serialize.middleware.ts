import { Request, Response, NextFunction } from "express";

/**
 * Recursively converts Prisma Decimal instances to plain JS numbers before
 * JSON serialization. Without this, Decimal fields serialize as strings
 * (e.g., "1234.50") which would break frontend code expecting numbers.
 *
 * Uses duck-typing to detect Decimal (avoids brittle runtime/library import).
 * Registered BEFORE all routes in app.ts so every res.json() call is covered.
 */
function isDecimalLike(value: unknown): value is { toNumber(): number } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).toNumber === "function" &&
    typeof (value as Record<string, unknown>).toFixed === "function"
  );
}

function toSerializable(value: unknown): unknown {
  if (isDecimalLike(value)) return value.toNumber();
  // Dates have no enumerable keys — Object.entries would turn them into {}
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toSerializable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toSerializable(v)])
    );
  }
  return value;
}

export const serializeDecimals = (
  _req: Request,
  res: Response,
  next: NextFunction
): void => {
  const originalJson = res.json.bind(res);
  res.json = (data: unknown) => originalJson(toSerializable(data));
  next();
};
