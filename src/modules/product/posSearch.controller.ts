/**
 * La búsqueda del mostrador.
 *
 * ── Por qué existe, y qué estaba pasando sin ella ───────────────────────────
 *
 * El POS se bajaba el catálogo y buscaba en memoria. Con `limit=3000` sobre
 * 19.358 productos eso significaba que **16.358 no existían para el mostrador**
 * — y lo peor no era que faltaran: al buscar uno de ellos por su SKU exacto, la
 * pantalla mostraba OTROS productos, sin decir que no había encontrado el
 * pedido. Medido: buscando `PERF-POS-000000` aparecían seis artículos distintos
 * y ninguno era ése. Un cajero puede cobrar el equivocado sin enterarse.
 *
 * Acá se busca en la base, que es la única que tiene el catálogo completo.
 *
 * ── Por qué no alcanzaba con `GET /products?search=` ────────────────────────
 *
 * Ese filtro ya existía, pero es PEOR que el que hacía el POS en memoria, y
 * cambiarlo por él habría empeorado el mostrador:
 *
 *   · Manda todo el texto como una sola cadena: "latex blanco" no encuentra
 *     "Látex Interior Mate Blanco", porque busca esas dos palabras juntas y en
 *     ese orden.
 *   · `mode: "insensitive"` ignora mayúsculas, no tildes. "latex" NO encuentra
 *     "Látex" — que es como está escrito medio catálogo.
 *
 * Acá cada palabra se busca por separado y todas tienen que aparecer (igual que
 * el buscador local), y las tildes se aplanan de los dos lados.
 *
 * ── Por qué `translate()` y no `unaccent` ───────────────────────────────────
 *
 * `unaccent` es una extensión: hay que instalarla en la base. `translate()` es
 * núcleo de PostgreSQL y funciona en cualquier lado, incluido Neon, sin
 * migración ni permisos especiales. Sobre este catálogo la diferencia de
 * velocidad no se percibe, y la de riesgo operativo sí.
 */

import { Response } from "express";
import { Prisma } from "@prisma/client";

import prisma from "../../config/db";
import { logger } from "../../config/logger";
import { AuthRequest } from "../../middlewares/auth.middleware";

/**
 * Cuántos resultados vuelven como máximo.
 *
 * Nadie mira más de un puñado en el mostrador: se escribe hasta que aparece lo
 * buscado. Un tope chico mantiene la respuesta liviana y la pantalla legible;
 * si lo que se busca no está en los primeros 25, la respuesta correcta es
 * escribir un poco más, no scrollear doscientos resultados.
 */
const TOPE_POR_DEFECTO = 25;
const TOPE_MAXIMO = 50;

/**
 * Cuántas palabras se toman de la consulta.
 *
 * Cada palabra agrega una condición a la consulta. Seis alcanzan de sobra para
 * "latex interior mate blanco 20 l" y ponen un techo a lo que alguien puede
 * hacerle costar al servidor pegando un párrafo.
 */
const MAX_PALABRAS = 6;

/** Vocales con tilde y sus equivalentes, en el mismo orden. Para `translate()`. */
const CON_TILDE = "áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ";
const SIN_TILDE = "aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC";

/**
 * El texto donde se busca, ya aplanado, armado en SQL.
 *
 * Junta los campos por los que alguien busca en el mostrador. `description` no
 * entra a propósito: es texto largo y hace que una palabra común traiga
 * cualquier cosa.
 */
const CAMPOS_BUSCABLES = Prisma.sql`
  translate(
    lower(
      coalesce("name", '') || ' ' ||
      coalesce("sku", '') || ' ' ||
      coalesce("barcode", '') || ' ' ||
      coalesce("brand", '') || ' ' ||
      coalesce("category", '')
    ),
    ${CON_TILDE}, ${SIN_TILDE}
  )
`;

/** Aplana una palabra del mismo modo que el SQL aplana el catálogo. */
export const aplanar = (texto: string): string =>
  texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .trim();

/**
 * Neutraliza los comodines de `LIKE` dentro de lo que escribió la persona.
 *
 * ── Por qué hace falta aunque la consulta vaya parametrizada ────────────────
 *
 * Parametrizar evita la INYECCIÓN: el texto nunca se concatena al SQL. Pero un
 * `%` que llega como parámetro sigue siendo un comodín para `LIKE`, y `_`
 * sigue valiendo por cualquier carácter.
 *
 * Sin esto, alguien que tipea un `%` en el buscador se lleva el catálogo
 * entero — que es exactamente lo que este endpoint vino a evitar. Lo detectó un
 * test, no una revisión: valía la pena escribirlo.
 *
 * La barra invertida va primero, o escaparía las que agrega este mismo paso.
 */
const escaparComodines = (palabra: string): string =>
  palabra.replace(/\\/gu, "\\\\").replace(/%/gu, "\\%").replace(/_/gu, "\\_");

/** Parte la consulta en palabras buscables, ya sin comodines. */
export const palabrasDe = (consulta: string): string[] =>
  aplanar(consulta)
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, MAX_PALABRAS)
    .map(escaparComodines);

interface FilaDeProducto {
  id: number;
  sku: string;
  barcode: string | null;
  name: string;
  brand: string;
  category: string;
  retailPrice: Prisma.Decimal | null;
  costPrice: Prisma.Decimal | null;
  images: string[];
  quantity: number | null;
  minStock: number | null;
  criticalStock: number | null;
}

/**
 * GET /products/pos-search?q=&branchId=&limit=
 *
 * Devuelve los productos que coinciden con TODAS las palabras, con el stock de
 * la sucursal pedida, ordenados por qué tan bien coinciden.
 */
export const posSearchProducts = async (req: AuthRequest, res: Response) => {
  try {
    const consulta = String(req.query.q ?? "");
    const palabras = palabrasDe(consulta);

    const branchId = Number(req.query.branchId ?? 0);
    if (!Number.isInteger(branchId) || branchId <= 0) {
      return res.status(400).json({
        error: "Falta la sucursal: el stock que se muestra es el de una caja concreta.",
      });
    }

    // Sin palabras no se devuelve el catálogo entero: eso es justo lo que se
    // vino a eliminar. La pantalla en reposo no muestra productos.
    if (palabras.length === 0) {
      return res.json({ data: [], metadata: { total: 0, truncated: false, query: "" } });
    }

    const pedido = Number(req.query.limit ?? TOPE_POR_DEFECTO);
    const tope = Number.isInteger(pedido) && pedido > 0
      ? Math.min(pedido, TOPE_MAXIMO)
      : TOPE_POR_DEFECTO;

    // Todas las palabras tienen que aparecer. Se arma con fragmentos
    // parametrizados: el texto de la persona nunca se concatena al SQL.
    // `ESCAPE '\'` es lo que le da sentido a los comodines ya neutralizados:
    // sin esto, la barra invertida que agrega `escaparComodines` sería un
    // carácter más y el `%` seguiría siendo comodín.
    const condiciones = palabras.map(
      (palabra) =>
        Prisma.sql`${CAMPOS_BUSCABLES} LIKE ${"%" + palabra + "%"} ESCAPE '\\'`,
    );
    const filtro = Prisma.join(condiciones, " AND ");

    const primera = palabras[0] ?? "";

    /**
     * Orden por relevancia, de más a menos literal:
     *   0. el SKU o el código de barras EXACTO — quien lo tipea sabe qué quiere
     *   1. el nombre EMPIEZA con lo buscado
     *   2. el resto
     * Dentro de cada grupo, alfabético, para que el orden no cambie solo entre
     * dos búsquedas iguales.
     */
    const filas = await prisma.$queryRaw<FilaDeProducto[]>`
      SELECT
        p."id", p."sku", p."barcode", p."name", p."brand", p."category",
        p."retailPrice", p."costPrice", p."images",
        s."quantity", s."minStock", s."criticalStock"
      FROM "Product" p
      LEFT JOIN "Stock" s
        ON s."productId" = p."id" AND s."branchId" = ${branchId}
      WHERE p."isActive" = true AND ${filtro}
      ORDER BY
        CASE
          WHEN lower(p."sku") = ${primera} THEN 0
          WHEN lower(coalesce(p."barcode", '')) = ${primera} THEN 0
          WHEN translate(lower(p."name"), ${CON_TILDE}, ${SIN_TILDE}) LIKE ${primera + "%"} THEN 1
          ELSE 2
        END,
        p."name" ASC
      LIMIT ${tope + 1}
    `;

    // Se pide uno de más para saber si quedó algo afuera SIN tener que contar
    // todo el catálogo: un COUNT en cada tecla es caro y no se usa para nada
    // más que para decir "hay más".
    const hayMas = filas.length > tope;
    const visibles = hayMas ? filas.slice(0, tope) : filas;

    res.json({
      data: visibles.map((fila) => ({
        id: fila.id,
        sku: fila.sku,
        barcode: fila.barcode,
        name: fila.name,
        brand: fila.brand,
        category: fila.category,
        retailPrice: fila.retailPrice === null ? null : Number(fila.retailPrice),
        costPrice: fila.costPrice === null ? null : Number(fila.costPrice),
        images: Array.isArray(fila.images) ? fila.images.slice(0, 1) : [],
        // El stock viaja como la relación que el POS ya sabe leer, para que la
        // pantalla no tenga que distinguir de dónde vino el producto.
        stocks:
          fila.quantity === null
            ? []
            : [
                {
                  branchId,
                  quantity: Number(fila.quantity),
                  minStock: Number(fila.minStock ?? 0),
                  criticalStock: Number(fila.criticalStock ?? 0),
                },
              ],
      })),
      metadata: {
        total: visibles.length,
        // `truncated` existe para que la pantalla lo DIGA. Una lista cortada
        // que se ve igual que una completa es de dónde salieron casi todos los
        // números equivocados de este proyecto.
        truncated: hayMas,
        query: consulta,
      },
    });
  } catch (error) {
    logger.error("[POS] Falló la búsqueda de productos:", error);
    res.status(500).json({ error: "No se pudo buscar en el catálogo." });
  }
};
