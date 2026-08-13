/**
 * Resolución de la terminal física.
 *
 * ── Regla de oro ────────────────────────────────────────────────────────────
 *
 * El navegador NO puede decir en qué terminal está. Un `terminalId` suelto en
 * el cuerpo de un request es una afirmación sin respaldo: cualquiera podría
 * atribuirle sus ventas a otra caja, o abrir turno en una sucursal ajena.
 *
 * La terminal se deriva de una credencial de dispositivo que el servidor emitió
 * al enrolar. Mientras el enrolamiento no esté desplegado, se cae a la terminal
 * legado de la sucursal — que es exactamente el estado de hoy, con un solo
 * puesto por local, sólo que ahora tiene nombre.
 */

import type { PrismaTx } from "../config/db";

export class TerminalResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalResolutionError";
  }
}

/** Código de la terminal creada por el backfill para una sucursal. */
export const legacyTerminalCode = (branchId: number): string => `LEGACY-${branchId}`;

/**
 * Devuelve la terminal en la que se está operando.
 *
 * @param requestedTerminalId  Lo que dice el cliente. **Sólo se acepta si
 *   coincide con una terminal ACTIVA de esa misma sucursal**; nunca se toma
 *   como verdad. Si no coincide, se rechaza en vez de sobrescribir en silencio,
 *   para que un cliente desincronizado se entere en vez de atribuir mal.
 */
export const resolveTerminal = async (
  tx: PrismaTx,
  branchId: number,
  requestedTerminalId?: number | null,
  /**
   * Terminal PROBADA por la credencial de dispositivo (`req.terminal`).
   * Tiene prioridad absoluta sobre lo que declare el cliente.
   */
  provenTerminal?: { id: number; code: string; branchId: number } | null,
): Promise<{ id: number; code: string }> => {
  // ── La credencial gana siempre ──
  // Si esta computadora está enrolada, ES esa terminal. Un `terminalId` en el
  // cuerpo que diga otra cosa no se acepta ni se ignora en silencio: se
  // rechaza, para que un cliente desincronizado se entere en vez de atribuir
  // sus ventas a la caja equivocada.
  if (provenTerminal) {
    if (provenTerminal.branchId !== branchId) {
      throw new TerminalResolutionError(
        `Esta computadora está enrolada como "${provenTerminal.code}", que pertenece a otra sucursal. ` +
          "No se puede operar una sucursal distinta desde esta terminal.",
      );
    }
    if (requestedTerminalId && requestedTerminalId !== provenTerminal.id) {
      throw new TerminalResolutionError(
        `La operación declara una terminal distinta de la que esta computadora tiene enrolada ` +
          `("${provenTerminal.code}"). Refrescá la página antes de seguir.`,
      );
    }
    return { id: provenTerminal.id, code: provenTerminal.code };
  }

  if (requestedTerminalId) {
    const declarada = await tx.terminal.findUnique({
      where: { id: requestedTerminalId },
      select: { id: true, code: true, branchId: true, status: true },
    });

    if (!declarada || declarada.status !== "ACTIVE") {
      throw new TerminalResolutionError(
        "La terminal indicada no existe o está desactivada.",
      );
    }
    if (declarada.branchId !== branchId) {
      throw new TerminalResolutionError(
        "La terminal indicada pertenece a otra sucursal. " +
          "No se puede operar una caja desde una sucursal distinta.",
      );
    }
    return { id: declarada.id, code: declarada.code };
  }

  // Sin terminal declarada: la legado de la sucursal. Es el comportamiento
  // actual —un puesto por local— pero ya con identidad propia, así que el
  // arqueo puede empezar a hablar de terminales desde el día uno.
  const legado = await tx.terminal.findUnique({
    where: { code: legacyTerminalCode(branchId) },
    select: { id: true, code: true },
  });

  if (!legado) {
    throw new TerminalResolutionError(
      `La sucursal ${branchId} no tiene ninguna terminal registrada. ` +
        "Creá una desde Configuración → Terminales antes de operar.",
    );
  }

  return legado;
};

/**
 * Igual que `resolveTerminal`, pero devuelve `null` si la sucursal simplemente
 * no tiene ninguna terminal todavía.
 *
 * ── Por qué existe: semántica de la fase de DUAL-WRITE ──────────────────────
 *
 * `Sale.terminalId` es nullable **a propósito** durante esta etapa: el código
 * completa la terminal cuando puede, y lo que todavía no migró sigue andando.
 * Hacer fallar una venta porque a una sucursal le falta una terminal sería un
 * paso de *contract* adelantado — y, en un mostrador, dejar de vender por una
 * fila faltante en una tabla de configuración es inaceptable.
 *
 * Lo que SÍ sigue siendo un error duro es la incoherencia: una terminal
 * declarada que no existe, que está desactivada, que es de otra sucursal, o que
 * contradice la credencial de dispositivo. Eso no es "falta configuración", es
 * "alguien está atribuyendo esta venta al lugar equivocado", y se rechaza.
 */
export const resolveTerminalIfAvailable = async (
  tx: PrismaTx,
  branchId: number,
  requestedTerminalId?: number | null,
  provenTerminal?: { id: number; code: string; branchId: number } | null,
): Promise<{ id: number; code: string } | null> => {
  // Sin nada declarado ni probado: se intenta la legado y, si no hay, se sigue
  // sin terminal. La columna nullable absorbe este caso.
  if (!requestedTerminalId && !provenTerminal) {
    return tx.terminal.findUnique({
      where: { code: legacyTerminalCode(branchId) },
      select: { id: true, code: true },
    });
  }

  // Hay una afirmación sobre la terminal: se valida en serio.
  return resolveTerminal(tx, branchId, requestedTerminalId, provenTerminal);
};
