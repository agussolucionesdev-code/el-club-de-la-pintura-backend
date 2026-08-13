/**
 * Descuento de stock a prueba de concurrencia.
 *
 * ── El bug que esto cierra ──────────────────────────────────────────────────
 *
 * El patrón que había en las tres rutas que descuentan stock era:
 *
 *     const stock = await tx.stock.findUnique(...);          // lee 1
 *     if (stock.quantity < pedido) throw ...;                // valida contra 1
 *     await tx.stock.update({ data: { quantity: stock.quantity - pedido } });
 *                                     // ↑ escribe un valor calculado en JS
 *
 * Con dos cajas vendiendo la última unidad al mismo tiempo, ambas leen
 * `quantity = 1`, ambas pasan la validación, y ambas escriben `0`. Se vendieron
 * dos unidades de un stock de una. PostgreSQL bloquea la fila en el `UPDATE`,
 * así que la segunda transacción espera — pero cuando arranca escribe **su
 * valor precalculado**, que ya está viejo. Es un *lost update* de manual.
 *
 * ── Por qué esto sí funciona ────────────────────────────────────────────────
 *
 * Dos cambios, ambos necesarios:
 *
 *   1. La condición viaja en el **WHERE**, no en un `if` de JavaScript:
 *      `where: { ..., quantity: { gte: pedido } }`.
 *   2. El valor es **relativo**, no absoluto: `{ decrement: pedido }`.
 *
 * En READ COMMITTED, cuando un `UPDATE` se destraba porque la otra transacción
 * commiteó, PostgreSQL **vuelve a evaluar el WHERE** contra la versión nueva de
 * la fila. Si ya no hay stock, la fila no matchea y `count` da 0. Ahí sabemos
 * que perdimos la carrera y abortamos — sin haber escrito nada.
 *
 * No hace falta `SELECT ... FOR UPDATE` ni subir el nivel de aislamiento: la
 * condición y la escritura ocurren en la misma sentencia atómica.
 */

import { Prisma } from "@prisma/client";

import type { PrismaTx } from "../config/db";

/**
 * ¿El error es una violación de índice único de PostgreSQL (P2002)?
 *
 * Se usa donde la unicidad la impone la base y no el código: perder esa carrera
 * es un caso de negocio esperable, no un fallo del servidor, y merece un 400
 * con un mensaje entendible en vez de un 500.
 */
export const isUniqueConstraintViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/**
 * Falta stock para completar la operación.
 *
 * Es un conflicto de negocio esperable —alguien se llevó la última unidad—, no
 * un fallo del sistema. Quien lo captura puede ofrecer una salida al operador.
 */
export class InsufficientStockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientStockError";
  }
}

/**
 * La cantidad pedida no es un entero positivo.
 *
 * Tipo APARTE de `InsufficientStockError` a propósito: son problemas distintos
 * y quien los captura reacciona distinto. El replay offline, por ejemplo,
 * traduce la falta de stock a "conflicto de inventario, revisá las unidades" —
 * decirle eso a alguien cuyo verdadero problema es una cantidad fraccionaria lo
 * manda a contar latas por algo que no tiene nada que ver.
 */
export class InvalidQuantityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidQuantityError";
  }
}

/** Toda cantidad de stock es un entero positivo. No hay media lata. */
const assertPositiveInteger = (quantity: number, operacion: string): void => {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new InvalidQuantityError(
      `Cantidad inválida para ${operacion}: ${quantity}. Debe ser un entero positivo.`,
    );
  }
};

type StockLocator = {
  productId: number;
  branchId: number;
};

/**
 * Arma el mensaje de error leyendo el estado real en el momento del fallo.
 * Se llama sólo en el camino de error, así que no cuesta nada en el camino feliz.
 */
const buildShortageMessage = async (
  tx: PrismaTx,
  { productId, branchId }: StockLocator,
  requested: number,
): Promise<string> => {
  const [stock, product] = await Promise.all([
    tx.stock.findUnique({
      where: { productId_branchId: { productId, branchId } },
      select: { quantity: true },
    }),
    tx.product.findUnique({
      where: { id: productId },
      select: { name: true, sku: true },
    }),
  ]);

  const label = product ? `${product.name} (${product.sku})` : `producto ID ${productId}`;

  if (!stock) {
    return `Stock no encontrado para ${label} en esta sucursal.`;
  }

  return (
    `Stock insuficiente para "${label}": hay ${stock.quantity} ud. disponibles ` +
    `pero se pidieron ${requested}.`
  );
};

/**
 * Descuenta `quantity` unidades de forma atómica, o lanza.
 *
 * Debe llamarse SIEMPRE dentro de una transacción: quien lo llama necesita que
 * el descuento se revierta junto con la venta, el movimiento y el comprobante
 * si algo posterior falla.
 */
export const decrementStockOrThrow = async (
  tx: PrismaTx,
  locator: StockLocator,
  quantity: number,
): Promise<void> => {
  assertPositiveInteger(quantity, "descontar stock");

  const result = await tx.stock.updateMany({
    // `quantity: { gte }` es la guarda. Si otra transacción se llevó las
    // unidades mientras esperábamos el lock, esta fila deja de matchear.
    where: {
      productId: locator.productId,
      branchId: locator.branchId,
      quantity: { gte: quantity },
    },
    // Relativo, nunca un valor precalculado en JS.
    data: { quantity: { decrement: quantity } },
  });

  // `@@unique([productId, branchId])` garantiza que el máximo sea 1.
  // 0 significa: no existe la fila, o ya no alcanza el stock.
  if (result.count !== 1) {
    throw new InsufficientStockError(
      await buildShortageMessage(tx, locator, quantity),
    );
  }
};

/**
 * Suma stock de forma atómica, creando la fila si no existía.
 * Los incrementos no necesitan guarda —nunca dejan un valor inválido— pero sí
 * ser relativos, por el mismo motivo de *lost update*.
 */
export const incrementStock = async (
  tx: PrismaTx,
  locator: StockLocator,
  quantity: number,
  defaults?: { minStock?: number; criticalStock?: number; healthyStock?: number },
): Promise<void> => {
  // Sin esta validación, una cantidad negativa convertiría el `increment` en un
  // descuento encubierto — saltándose la guarda de disponibilidad y pudiendo
  // dejar el stock en negativo por la puerta de atrás.
  assertPositiveInteger(quantity, "sumar stock");

  await tx.stock.upsert({
    where: {
      productId_branchId: {
        productId: locator.productId,
        branchId: locator.branchId,
      },
    },
    update: { quantity: { increment: quantity } },
    create: {
      productId: locator.productId,
      branchId: locator.branchId,
      quantity,
      minStock: defaults?.minStock ?? 5,
      ...(defaults?.criticalStock !== undefined
        ? { criticalStock: defaults.criticalStock }
        : {}),
      ...(defaults?.healthyStock !== undefined
        ? { healthyStock: defaults.healthyStock }
        : {}),
    },
  });
};
