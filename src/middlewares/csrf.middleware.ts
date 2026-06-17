import { doubleCsrf } from "csrf-csrf";
import { Request, Response, NextFunction } from "express";

const isProduction = process.env.NODE_ENV === "production";

const { generateCsrfToken, doubleCsrfProtection } = doubleCsrf({
  // Uses JWT_SECRET so no extra env var is needed. Fail closed: never fall back
  // to a hardcoded secret — a guessable CSRF secret defeats the protection.
  getSecret: () => {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error(
        "JWT_SECRET no está configurado. Es obligatorio para firmar los tokens CSRF y de sesión.",
      );
    }
    return secret;
  },

  // Session identifier: use the auth cookie value, fallback to IP
  getSessionIdentifier: (req: Request) =>
    (req.cookies?.club_token as string) ?? (req.ip ?? "anonymous"),

  cookieName: "XSRF-TOKEN",

  cookieOptions: {
    httpOnly: false,  // Must be JS-readable so Axios can read and send it
    sameSite: (process.env.COOKIE_SAME_SITE as "none" | "lax" | "strict") ?? (isProduction ? "none" : "lax"),
    secure: isProduction,
    path: "/",
  },

  // Only validate CSRF on these methods; GET/HEAD/OPTIONS pass freely
  ignoredMethods: ["GET", "HEAD", "OPTIONS"],

  getCsrfTokenFromRequest: (req: Request) =>
    (req.headers["x-xsrf-token"] as string) ??
    (req.headers["x-csrf-token"] as string) ??
    undefined,
});

/**
 * Issues/refreshes the XSRF-TOKEN cookie on the response.
 * Call this on every GET request (via global GET middleware in app.ts)
 * and on successful login (to rotate the token after privilege change).
 *
 * Also mirrors the token value in the X-CSRF-Token response header so
 * cross-origin clients (e.g. Vercel → Render) can capture it via JS.
 * JavaScript cannot read cookies set by a different domain, so the cookie
 * alone is not sufficient in a cross-origin deployment.
 */
export function attachCsrfToken(req: Request, res: Response): void {
  const token = generateCsrfToken(req, res);
  res.setHeader("X-CSRF-Token", token);
}

/**
 * Validates X-XSRF-TOKEN on POST/PUT/PATCH/DELETE.
 * Returns 403 if the token is missing, expired, or invalid.
 */
export const csrfProtection = (req: Request, res: Response, next: NextFunction): void => {
  doubleCsrfProtection(req, res, (err?: unknown) => {
    if (err) {
      res.status(403).json({
        error: "Token CSRF inválido o ausente. Recargá la página e intentá de nuevo.",
      });
      return;
    }
    next();
  });
};
