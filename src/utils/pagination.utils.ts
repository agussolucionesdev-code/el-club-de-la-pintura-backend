/**
 * Paginación: leer `page` y `limit` sin creerle al cliente.
 *
 * ── El problema que resuelve ────────────────────────────────────────────────
 *
 * Varias listas hacían `take: Number(req.query.limit)` a secas. Eso tiene tres
 * agujeros, y los tres estaban abiertos:
 *
 *   1. **Sin techo.** Un cliente podía pedir `limit=999999` y el servidor
 *      intentaba traer el catálogo entero —19.325 productos con sus
 *      relaciones— en una sola consulta.
 *   2. **`NaN`.** `Number("abc")` no es un número, y `take: NaN` revienta la
 *      consulta con un error que no explica nada.
 *   3. **Truncado mudo.** La pantalla pedía 3.000, recibía 3.000 de 19.325, y
 *      no había forma de saber que faltaba el resto. Ese silencio es el que
 *      convierte una lista incompleta en un total que miente.
 *
 * ── Por qué un techo y no "traer todo" ─────────────────────────────────────
 *
 * Porque el catálogo real de esta pinturería tiene 19.325 productos. Cualquier
 * pantalla que los cargue todos de una vez va a tardar, va a comer memoria en
 * una computadora de mostrador, y va a hacerlo peor a medida que el negocio
 * crezca. El techo obliga a paginar o a buscar, que es lo correcto.
 */

/** Cuántas filas devuelve una lista si nadie pide otra cosa. */
export const TAMANO_DE_PAGINA_POR_DEFECTO = 50;

/**
 * El máximo que un cliente puede pedir de una sola vez.
 *
 * 5.000 es el mismo techo que ya usaba Proveedores. No se eligió más bajo
 * porque el POS carga el catálogo entero para buscar sin latencia: recortarlo a
 * unos cientos rompería la búsqueda del mostrador, que es la pantalla más
 * usada del sistema.
 *
 * ⚠️ Con el catálogo real (19.325 productos) este techo TAMBIÉN corta. No es
 * un descuido: taparlo de verdad exige mover la búsqueda del POS al servidor,
 * que es un trabajo aparte. Lo que este techo garantiza es que nadie pueda
 * pedir el universo de una sola vez, y que cuando se corte, **se sepa** —para
 * eso está `truncated` en los metadatos.
 */
export const TAMANO_DE_PAGINA_MAXIMO = 5_000;

export type Paginacion = {
  /** Página pedida, 1 o mayor. */
  page: number;
  /** Cuántas filas traer, ya recortado al máximo. */
  take: number;
  /** Cuántas saltear. */
  skip: number;
  /** `true` si el cliente pidió más de lo permitido y se le recortó. */
  recortado: boolean;
};

/**
 * Lee `page` y `limit` de una query, sin confiar en ninguno de los dos.
 *
 * Un valor ausente, negativo, fraccionario o no numérico cae al valor por
 * defecto en vez de propagarse como `NaN`.
 */
export const leerPaginacion = (
  query: { page?: unknown; limit?: unknown },
  porDefecto = TAMANO_DE_PAGINA_POR_DEFECTO,
): Paginacion => {
  const enteroPositivo = (valor: unknown, caida: number) => {
    const n = Number(valor);
    return Number.isInteger(n) && n > 0 ? n : caida;
  };

  const page = enteroPositivo(query.page, 1);
  const pedido = enteroPositivo(query.limit, porDefecto);
  const take = Math.min(pedido, TAMANO_DE_PAGINA_MAXIMO);

  return {
    page,
    take,
    skip: (page - 1) * take,
    recortado: pedido > TAMANO_DE_PAGINA_MAXIMO,
  };
};

export type MetadatosDePagina = {
  totalRecords: number;
  totalPages: number;
  currentPage: number;
  pageSize: number;
  /**
   * `true` cuando hay más filas de las que se devolvieron.
   *
   * Existe para que la pantalla pueda DECIRLO. Una lista cortada que se ve
   * igual que una lista completa es la raíz de casi todos los números
   * equivocados que aparecieron en este proyecto.
   */
  truncated: boolean;
  /** El cliente pidió más del máximo permitido y se le recortó. */
  limitClamped: boolean;
};

/** Arma los metadatos que acompañan a cualquier lista paginada. */
export const metadatosDePagina = (
  total: number,
  paginacion: Paginacion,
): MetadatosDePagina => {
  const { page, take, recortado } = paginacion;
  const devueltas = Math.max(0, Math.min(take, total - (page - 1) * take));
  return {
    totalRecords: total,
    totalPages: Math.max(1, Math.ceil(total / take)),
    currentPage: page,
    pageSize: take,
    truncated: (page - 1) * take + devueltas < total,
    limitClamped: recortado,
  };
};
