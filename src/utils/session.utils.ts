/**
 * La sesión de usuario: un solo lugar donde nace, y uno donde muere.
 *
 * ── Por qué existe este archivo ─────────────────────────────────────────────
 *
 * La emisión del token estaba escrita adentro del login por contraseña. Con una
 * segunda puerta de entrada (el código de seis dígitos de la terminal) eso se
 * iba a duplicar, y dos copias de la firma de una sesión derivan: alguien
 * cambia el `sameSite` en una y se olvida de la otra, y entonces una de las dos
 * formas de entrar deja de funcionar en producción y nadie sabe por qué.
 *
 * ── El desajuste que había, y que acá no puede volver a pasar ───────────────
 *
 * El token se firmaba con `JWT_EXPIRES_IN` (24 h por defecto) y la cookie se
 * seteaba con `maxAge` de 7 días. Los cuatro días del medio el navegador seguía
 * mandando una credencial ya vencida: la persona parecía tener sesión, la
 * aplicación cargaba, y recién al primer pedido de datos le saltaba "sesión
 * expirada". Acá el vencimiento de la cookie se DERIVA del token firmado, así
 * que no hay dos números que puedan discrepar: hay uno solo.
 *
 * ── Nivel de autenticación ──────────────────────────────────────────────────
 *
 * El token dice CÓMO se probó la identidad. No es lo mismo escribir una
 * contraseña que marcar seis dígitos en el mostrador, y hay acciones que no
 * deberían quedar habilitadas por lo segundo. Ver `requireFullAuth`.
 */

import { CookieOptions, Request, Response } from "express";
import jwt from "jsonwebtoken";

import { attachCsrfToken } from "../middlewares/csrf.middleware";

/** Nombre de la cookie de sesión. Estaba escrito a mano en tres lugares. */
export const SESSION_COOKIE = "club_token";

/**
 * Cómo se probó la identidad de quien tiene esta sesión.
 *
 * `PASSWORD` — email y contraseña. Acceso pleno.
 * `PIN`      — código de seis dígitos en una terminal enrolada. Alcanza para
 *              vender y operar el mostrador; NO para administrar el sistema.
 */
export type AuthLevel = "PASSWORD" | "PIN";

/**
 * `sameSite` de las cookies de sesión.
 *
 * El despliegue real es cross-origin (el front en Vercel, la API en Render), y
 * ahí `lax` hace que la cookie no viaje. Se controla con `COOKIE_SAME_SITE`,
 * igual que el resto de las cookies de la aplicación.
 */
const sameSiteDeSesion = (): "none" | "lax" | "strict" =>
  (process.env.COOKIE_SAME_SITE as "none" | "lax" | "strict") ?? "lax";

/**
 * Opciones de la cookie de sesión.
 *
 * Se exporta para que el cierre de sesión borre EXACTAMENTE la misma cookie que
 * se creó: si los atributos no coinciden, el navegador ignora el borrado y la
 * sesión sigue viva. Es una fuente clásica de "cerré sesión y seguía adentro".
 */
export const sessionCookieOptions = (maxAgeMs?: number): CookieOptions => {
  const sameSite = sameSiteDeSesion();
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || sameSite === "none",
    sameSite,
    ...(maxAgeMs === undefined ? {} : { maxAge: maxAgeMs }),
  };
};

/** Lo que la aplicación necesita saber de quien acaba de entrar. */
export interface PublicSessionUser {
  id: number;
  name: string;
  email: string;
  role: string;
  avatarUrl: string | null;
  branches: { id: number; name: string }[];
  /** Cómo entró. El front lo usa para explicar qué no va a poder hacer. */
  authLevel: AuthLevel;
}

interface UsuarioParaSesion {
  id: number;
  name: string;
  email: string;
  role: string;
  avatarUrl: string | null;
  branches: { id: number; name: string }[];
}

/**
 * Firma el token, lo deja en la cookie y rota el token de CSRF.
 *
 * @returns el perfil público, listo para responder.
 * @throws si falta `JWT_SECRET`. Fallar acá es correcto: sin clave de firma no
 *         hay sesión posible, y emitir algo sin firmar sería mucho peor.
 */
export const emitirSesion = (
  req: Request,
  res: Response,
  usuario: UsuarioParaSesion,
  authLevel: AuthLevel,
): PublicSessionUser => {
  const secreto = process.env.JWT_SECRET;
  if (!secreto) {
    throw new Error("Clave de firma JWT_SECRET no configurada.");
  }

  const branchIds = usuario.branches.map((sucursal) => sucursal.id);

  const token = jwt.sign(
    { id: usuario.id, role: usuario.role, branchIds, authLevel },
    secreto,
    {
      expiresIn: (process.env.JWT_EXPIRES_IN ||
        "24h") as jwt.SignOptions["expiresIn"],
    },
  );

  // El `exp` del token firmado es la ÚNICA fuente del vencimiento: la cookie no
  // puede sobrevivirle. Si por lo que sea no se pudiera leer, se manda una
  // cookie de sesión (sin `maxAge`), que muere al cerrar el navegador — más
  // corta de lo previsto, nunca más larga.
  const decodificado = jwt.decode(token);
  const expEnMs =
    decodificado && typeof decodificado === "object" && typeof decodificado.exp === "number"
      ? decodificado.exp * 1000 - Date.now()
      : undefined;

  res.cookie(
    SESSION_COOKIE,
    token,
    sessionCookieOptions(expEnMs !== undefined && expEnMs > 0 ? expEnMs : undefined),
  );

  // Token de CSRF nuevo en cada login, para que el cliente arranque con uno
  // válido y no falle su primer pedido de escritura.
  attachCsrfToken(req, res);

  return {
    id: usuario.id,
    name: usuario.name,
    email: usuario.email,
    role: usuario.role,
    avatarUrl: usuario.avatarUrl,
    branches: usuario.branches,
    authLevel,
  };
};

/** Borra la cookie de sesión con los mismos atributos con los que se creó. */
export const limpiarSesion = (res: Response): void => {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
};
