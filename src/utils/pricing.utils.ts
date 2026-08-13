/**
 * Precios y totales, calculados POR EL SERVIDOR.
 *
 * ── El problema ─────────────────────────────────────────────────────────────
 *
 * El backend le creía al navegador. Del payload de la venta salían tal cual:
 *
 *   · `unitPrice`  → se persistía como precio cobrado, sin contrastarlo con nada
 *   · `totalAmount`→ NUNCA se comparaba contra la suma de los ítems
 *   · `unitCost`   → se leía de `item.unitCost`, un campo que el schema de Zod
 *                    ni siquiera declara
 *
 * Las tres juntas dan un agujero explotable de verdad: mandar ítems por
 * $100.000 con `totalAmount: 1` hacía que se cobrara $1 y el stock bajara
 * completo. Los pagos se validaban contra el total… pero el total lo ponía el
 * cliente, así que la validación se mordía la cola.
 *
 * ── La regla ────────────────────────────────────────────────────────────────
 *
 * Del cliente se acepta QUÉ quiere comprar y CON QUÉ autorización. CUÁNTO
 * cuesta lo decide la base de datos, siempre.
 *
 * El total del cliente sí se usa, pero sólo para contrastar: si no coincide con
 * el autoritativo, la venta se RECHAZA (409). Nunca se cobra en silencio un
 * monto distinto al que el operador vio y confirmó en pantalla.
 *
 * ── Decimal, no float ───────────────────────────────────────────────────────
 *
 * Toda la aritmética usa `Prisma.Decimal`. Con float, `0.1 + 0.2` da
 * `0.30000000000000004`, y un centavo de deriva por línea se acumula hasta que
 * el arqueo no cierra y nadie sabe por qué.
 */

import { Prisma } from "@prisma/client";

import type { PrismaTx } from "../config/db";

/** Dos decimales para plata; cuatro para precios unitarios, como el esquema. */
const MONEY_DP = 2;
const UNIT_DP = 4;

export const toDecimal = (value: unknown): Prisma.Decimal =>
  new Prisma.Decimal(value === null || value === undefined ? 0 : String(value));

const roundMoney = (value: Prisma.Decimal): Prisma.Decimal =>
  value.toDecimalPlaces(MONEY_DP, Prisma.Decimal.ROUND_HALF_UP);

const roundUnit = (value: Prisma.Decimal): Prisma.Decimal =>
  value.toDecimalPlaces(UNIT_DP, Prisma.Decimal.ROUND_HALF_UP);

/** El cliente pidió algo que el catálogo no permite. */
export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingError";
  }
}

/** El total del cliente no coincide con el autoritativo. */
export class TotalMismatchError extends Error {
  constructor(
    public readonly expected: Prisma.Decimal,
    public readonly authoritative: Prisma.Decimal,
    public readonly breakdown: PricedLine[],
  ) {
    super(
      `El total cambió: la pantalla mostraba $${expected.toFixed(2)} y el precio ` +
        `vigente da $${authoritative.toFixed(2)}. Revisá el ticket actualizado antes de cobrar.`,
    );
    this.name = "TotalMismatchError";
  }
}

/** Lo que el cliente PIDE. Precios no: eso lo pone el servidor. */
export type RequestedLine = {
  productId: number;
  quantity: number;
  /** Descuento porcentual de línea, 0-100. Sujeto al tope del rol. */
  discountPct?: number | null;
  /** Precio unitario excepcional. Exige capacidad y queda auditado. */
  priceOverride?: number | null;
};

/** Lo que el servidor RESUELVE, listo para persistir. */
export type PricedLine = {
  productId: number;
  productName: string;
  sku: string;
  quantity: number;
  /** Precio de lista vigente en la base. */
  listPrice: Prisma.Decimal;
  /** Precio efectivamente cobrado por unidad. */
  unitPrice: Prisma.Decimal;
  subtotal: Prisma.Decimal;
  discountPct: Prisma.Decimal | null;
  /**
   * Costo congelado. `null` significa DESCONOCIDO, no cero.
   * Un producto sin costo cargado no costó nada: no sabemos cuánto costó, y
   * decir "cero" inventaría un margen del 100% que después alimentaría mal los
   * incentivos.
   */
  unitCost: Prisma.Decimal | null;
  /** Hubo precio excepcional: se audita aparte. */
  overridden: boolean;
};

/** Tope de descuento de línea por rol, sin autorización extra. */
export const MAX_LINE_DISCOUNT_BY_ROLE: Record<string, number> = {
  ADMIN: 100,
  ENCARGADO: 100,
  EMPLOYEE: 15,
};

/**
 * Junta las líneas repetidas del mismo producto ANTES de tocar stock.
 *
 * Sin esto, mandar dos líneas de 1 unidad de un producto con 1 sola disponible
 * pasaba: cada línea se validaba por separado contra el mismo stock. La guarda
 * atómica de la Fase 1 ya lo frenaría en la segunda, pero abortaría la venta
 * entera por algo que en realidad es una sola compra de 2 unidades. Sumarlas
 * primero da el error correcto —o la venta correcta— desde el principio.
 *
 * Sólo se fusionan líneas con el MISMO trato comercial: mismo descuento y mismo
 * override. Dos líneas del mismo producto a precios distintos son deliberadas
 * (media docena con descuento y una suelta sin él) y se respetan.
 */
export const mergeDuplicateLines = (lines: RequestedLine[]): RequestedLine[] => {
  const merged = new Map<string, RequestedLine>();

  for (const line of lines) {
    const key = [
      line.productId,
      line.discountPct ?? "sin-descuento",
      line.priceOverride ?? "sin-override",
    ].join("|");

    const previo = merged.get(key);
    if (previo) {
      previo.quantity += line.quantity;
    } else {
      merged.set(key, { ...line });
    }
  }

  return [...merged.values()];
};

/**
 * Resuelve el precio de cada línea contra la base y devuelve el total real.
 *
 * Corre DENTRO de la transacción de la venta: el precio que se congela es el
 * mismo que el que se validó, sin ventana para que cambie en el medio.
 */
export const priceSaleLines = async (
  tx: PrismaTx,
  requested: RequestedLine[],
  context: { role: string; canOverridePrice: boolean },
): Promise<{ lines: PricedLine[]; total: Prisma.Decimal }> => {
  if (requested.length === 0) {
    throw new PricingError("La venta debe contener al menos un producto.");
  }

  const lines = mergeDuplicateLines(requested);

  // Una sola consulta para todos los productos: sin N+1.
  const products = await tx.product.findMany({
    where: { id: { in: [...new Set(lines.map((line) => line.productId))] } },
    select: {
      id: true,
      name: true,
      sku: true,
      retailPrice: true,
      costPrice: true,
      isActive: true,
    },
  });
  const byId = new Map(products.map((product) => [product.id, product]));

  const maxDiscount = MAX_LINE_DISCOUNT_BY_ROLE[context.role] ?? 0;
  const priced: PricedLine[] = [];
  let total = new Prisma.Decimal(0);

  for (const line of lines) {
    const product = byId.get(line.productId);
    if (!product) {
      throw new PricingError(`El producto ID ${line.productId} no existe en el catálogo.`);
    }
    if (!product.isActive) {
      throw new PricingError(`"${product.name}" está dado de baja y no se puede vender.`);
    }
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new PricingError(
        `Cantidad inválida para "${product.name}": ${line.quantity}. Debe ser un entero positivo.`,
      );
    }
    if (product.retailPrice === null || product.retailPrice === undefined) {
      throw new PricingError(
        `"${product.name}" no tiene precio de venta cargado. Cargalo antes de venderlo.`,
      );
    }

    // ── Precio de lista: de la BASE, nunca del cliente ──
    const listPrice = roundUnit(toDecimal(product.retailPrice));

    const discountPct =
      line.discountPct !== null && line.discountPct !== undefined
        ? toDecimal(line.discountPct)
        : null;

    if (discountPct) {
      if (discountPct.lessThan(0) || discountPct.greaterThan(100)) {
        throw new PricingError(
          `Descuento inválido para "${product.name}": ${discountPct.toFixed(2)}%. Debe estar entre 0 y 100.`,
        );
      }
      if (discountPct.greaterThan(maxDiscount)) {
        throw new PricingError(
          `Tu rol permite hasta ${maxDiscount}% de descuento por línea. ` +
            `Se pidió ${discountPct.toFixed(2)}% en "${product.name}".`,
        );
      }
    }

    // ── Precio cobrado ──
    let unitPrice: Prisma.Decimal;
    let overridden = false;

    if (line.priceOverride !== null && line.priceOverride !== undefined) {
      if (!context.canOverridePrice) {
        throw new PricingError(
          `No tenés permiso para fijar un precio excepcional en "${product.name}".`,
        );
      }
      const override = toDecimal(line.priceOverride);
      if (override.lessThan(0)) {
        throw new PricingError(`El precio excepcional de "${product.name}" no puede ser negativo.`);
      }
      unitPrice = roundUnit(override);
      overridden = true;
    } else if (discountPct) {
      const factor = new Prisma.Decimal(1).minus(discountPct.dividedBy(100));
      unitPrice = roundUnit(listPrice.times(factor));
    } else {
      unitPrice = listPrice;
    }

    const subtotal = roundMoney(unitPrice.times(line.quantity));
    total = total.plus(subtotal);

    priced.push({
      productId: product.id,
      productName: product.name,
      sku: product.sku,
      quantity: line.quantity,
      listPrice,
      unitPrice,
      subtotal,
      discountPct,
      // Desconocido se guarda como desconocido.
      unitCost:
        product.costPrice === null || product.costPrice === undefined
          ? null
          : roundUnit(toDecimal(product.costPrice)),
      overridden,
    });
  }

  return { lines: priced, total: roundMoney(total) };
};

/**
 * Contrasta el total que el operador vio contra el autoritativo.
 * Tolerancia de un centavo: por debajo de eso es redondeo, no discrepancia.
 */
export const assertTotalMatches = (
  clientTotal: unknown,
  authoritative: Prisma.Decimal,
  breakdown: PricedLine[],
): void => {
  const expected = roundMoney(toDecimal(clientTotal));
  if (expected.minus(authoritative).abs().greaterThan("0.01")) {
    throw new TotalMismatchError(expected, authoritative, breakdown);
  }
};

/**
 * Valida efectivo recibido y vuelto contra el COMPONENTE EN EFECTIVO, no contra
 * el total de la venta.
 *
 * En un pago mixto de $10.000 con $6.000 en tarjeta y $4.000 en efectivo, si el
 * cliente entrega $5.000 el vuelto es $1.000. Compararlo contra los $10.000
 * daba un vuelto negativo y hacía ver como insuficiente un pago que estaba bien.
 */
export const resolveCashChange = (
  cashReceived: unknown,
  cashComponent: Prisma.Decimal,
): { cashReceived: Prisma.Decimal | null; changeGiven: Prisma.Decimal | null } => {
  if (cashReceived === null || cashReceived === undefined || cashReceived === "") {
    return { cashReceived: null, changeGiven: null };
  }

  const received = roundMoney(toDecimal(cashReceived));

  if (received.lessThan(cashComponent)) {
    throw new PricingError(
      `El efectivo recibido ($${received.toFixed(2)}) no cubre la parte en efectivo ` +
        `de la venta ($${cashComponent.toFixed(2)}).`,
    );
  }

  return { cashReceived: received, changeGiven: roundMoney(received.minus(cashComponent)) };
};
