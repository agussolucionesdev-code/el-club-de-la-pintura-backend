/**
 * Quién vendió, quién cobró: atribución derivada del servidor.
 *
 * ── La regla de oro ─────────────────────────────────────────────────────────
 *
 * **El navegador no es autoridad sobre quién vendió.** De ese dato dependen la
 * comisión que se paga y de quién es el faltante en el arqueo. Aceptar un
 * `sellerId` del cuerpo del request sería dejar que el cliente escriba su
 * propia liquidación.
 *
 * Todo sale del contexto que el servidor resuelve:
 *
 *   · Con sesión de operador  → el operador ACTIVO (el del PIN).
 *   · Sin sesión de operador  → el dueño del token, marcado como inferido.
 *
 * ── Por qué se rechaza en vez de ignorar ────────────────────────────────────
 *
 * Si el cuerpo declara una identidad que no coincide con la derivada, la venta
 * se rechaza con 409. Ignorarla en silencio dejaría a un cliente desincronizado
 * creyendo que registró una cosa mientras el servidor registró otra — y nadie
 * se enteraría hasta que las comisiones no cierren a fin de mes.
 */

import type { PrismaTx } from "../config/db";
import type { PosRequestContext } from "../core/pos-context";

export class IdentityMismatchError extends Error {
  readonly code = "IDENTITY_MISMATCH";
  constructor(message: string) {
    super(message);
    this.name = "IdentityMismatchError";
  }
}

export type SaleAttribution = {
  /** Quien recibe el crédito de la venta y la comisión. */
  sellerId: number;
  /** Quien recibió o registró el cobro. */
  cashierId: number;
  /** Con qué sesión de operador. `null` si no había ninguna. */
  operatorSessionId: number | null;
  /** Nombres congelados: el historial no cambia si después renombran a alguien. */
  sellerNameSnapshot: string;
  cashierNameSnapshot: string;
  /** `true` = no hubo sesión de operador; se sabe quién estaba logueado, no quién atendía. */
  attributionLegacy: boolean;
};

/**
 * Lo que el cliente DICE sobre la identidad. No se usa para nada más que para
 * contrastarlo y, si contradice al servidor, rechazar.
 */
export type DeclaredIdentity = {
  userId?: number | null;
  sellerId?: number | null;
  cashierId?: number | null;
  branchId?: number | null;
  cashRegisterId?: number | null;
};

export const resolveSaleAttribution = async (
  tx: PrismaTx,
  {
    posContext,
    authUser,
    declared,
    resolvedBranchId,
    resolvedCashRegisterId,
  }: {
    posContext: PosRequestContext | null;
    authUser: { id: number; role: string };
    declared: DeclaredIdentity;
    resolvedBranchId: number;
    resolvedCashRegisterId: number;
  },
): Promise<SaleAttribution> => {
  // ── 1. Quién es el operador efectivo ──
  //
  // Con contexto de POS, el operador activo. Sin contexto —porque la
  // computadora todavía no está enrolada como terminal— sólo se conoce al dueño
  // del token, y eso se dice con todas las letras en `attributionLegacy`.
  const operador = posContext
    ? {
        id: posContext.effectiveUser.id,
        name: posContext.effectiveUser.name,
        sessionId: posContext.operatorSession.id,
      }
    : await (async () => {
        const usuario = await tx.user.findUnique({
          where: { id: authUser.id },
          select: { id: true, name: true },
        });
        if (!usuario) {
          throw new IdentityMismatchError(
            "El usuario de la sesión ya no existe. Volvé a iniciar sesión.",
          );
        }
        return { id: usuario.id, name: usuario.name, sessionId: null };
      })();

  // ── 2. Contraste con lo declarado ──
  //
  // Se comparan sólo los campos que el cliente MANDÓ. Un campo ausente no es un
  // conflicto: es un cliente que confía en el servidor, que es lo correcto.
  const conflicto = (campo: string, declarado: number, derivado: number) =>
    new IdentityMismatchError(
      `La venta declara ${campo} ${declarado} pero el servidor resolvió ${derivado}. ` +
        "Refrescá la página antes de seguir: los datos de la pantalla quedaron viejos.",
    );

  if (declared.userId != null && Number(declared.userId) !== operador.id) {
    throw conflicto("un vendedor", Number(declared.userId), operador.id);
  }
  if (declared.sellerId != null && Number(declared.sellerId) !== operador.id) {
    throw conflicto("un vendedor", Number(declared.sellerId), operador.id);
  }
  if (declared.cashierId != null && Number(declared.cashierId) !== operador.id) {
    throw conflicto("un cajero", Number(declared.cashierId), operador.id);
  }
  if (declared.branchId != null && Number(declared.branchId) !== resolvedBranchId) {
    throw conflicto("una sucursal", Number(declared.branchId), resolvedBranchId);
  }
  if (
    declared.cashRegisterId != null &&
    Number(declared.cashRegisterId) !== resolvedCashRegisterId
  ) {
    throw conflicto("una caja", Number(declared.cashRegisterId), resolvedCashRegisterId);
  }

  // ── 3. Coherencia entre la terminal y la sucursal de la venta ──
  //
  // La computadora está donde está. Vender de una sucursal desde la terminal de
  // otra rompería el arqueo de las dos al mismo tiempo.
  if (posContext && posContext.branchId !== resolvedBranchId) {
    throw new IdentityMismatchError(
      `Esta computadora es la terminal "${posContext.terminal.code}", que pertenece a otra ` +
        "sucursal. No se puede vender de una sucursal distinta desde acá.",
    );
  }

  // Vendedor y cajero son la misma persona: quien está atendiendo cobra lo que
  // vende. Son campos separados porque en la Fase 7 el pago diferido de una
  // cuenta corriente lo puede tomar otra persona, y ahí van a divergir.
  return {
    sellerId: operador.id,
    cashierId: operador.id,
    operatorSessionId: operador.sessionId,
    sellerNameSnapshot: operador.name,
    cashierNameSnapshot: operador.name,
    attributionLegacy: posContext === null,
  };
};

/**
 * Qué CLASE de operación es.
 *
 * El consumo del personal hoy es una venta ordinaria a un `Customer` de tipo
 * INTERNAL: se cuela en la facturación, en el margen y en el ranking de
 * vendedores como si fuera una venta a un cliente real. Marcarlo permite
 * excluirlo de los reportes desde ya, sin borrar ni migrar nada.
 */
export const resolveSaleKind = async (
  tx: PrismaTx,
  customerId: number | null,
): Promise<"SALE" | "INTERNAL_CONSUMPTION"> => {
  if (!customerId) return "SALE";
  const cliente = await tx.customer.findUnique({
    where: { id: customerId },
    select: { type: true },
  });
  return cliente?.type === "INTERNAL" ? "INTERNAL_CONSUMPTION" : "SALE";
};
