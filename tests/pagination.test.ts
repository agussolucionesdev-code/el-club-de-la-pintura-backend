/**
 * Paginación: el servidor no le cree al cliente, y avisa cuando corta.
 *
 * Tres agujeros que estaban abiertos en las listas:
 *
 *   1. **Sin techo** — `limit=999999` intentaba traer el catálogo entero.
 *   2. **`NaN`** — `limit=abc` daba `take: NaN` y reventaba la consulta.
 *   3. **Truncado mudo** — la pantalla pedía 3.000, recibía 3.000 de 19.325, y
 *      no había forma de saber que faltaba el resto.
 *
 * El tercero es el que más caro sale: una lista cortada que se ve igual que una
 * completa es la raíz de casi todos los números equivocados de este proyecto.
 */
import {
  TAMANO_DE_PAGINA_MAXIMO,
  TAMANO_DE_PAGINA_POR_DEFECTO,
  leerPaginacion,
  metadatosDePagina,
} from "../src/utils/pagination.utils";

describe("leerPaginacion", () => {
  it("usa los valores por defecto cuando no viene nada", () => {
    const p = leerPaginacion({});
    expect(p.page).toBe(1);
    expect(p.take).toBe(TAMANO_DE_PAGINA_POR_DEFECTO);
    expect(p.skip).toBe(0);
    expect(p.recortado).toBe(false);
  });

  it("🔒 recorta lo que exceda el máximo y lo DICE", () => {
    const p = leerPaginacion({ limit: 999_999 });
    expect(p.take).toBe(TAMANO_DE_PAGINA_MAXIMO);
    // Que lo diga importa: sin esta bandera el recorte es silencioso.
    expect(p.recortado).toBe(true);
  });

  it("🔒 no propaga NaN cuando el límite no es un número", () => {
    for (const basura of ["abc", "", null, undefined, {}, "12px"]) {
      const p = leerPaginacion({ limit: basura });
      expect(Number.isInteger(p.take)).toBe(true);
      expect(p.take).toBeGreaterThan(0);
    }
  });

  it("rechaza páginas y tamaños absurdos en vez de calcular con ellos", () => {
    // Un `skip` negativo o fraccionario es un error de consulta, no una página.
    for (const mala of [0, -3, 1.5, "-1", "0"]) {
      const p = leerPaginacion({ page: mala });
      expect(p.page).toBe(1);
      expect(p.skip).toBe(0);
    }
    expect(leerPaginacion({ limit: -10 }).take).toBe(
      TAMANO_DE_PAGINA_POR_DEFECTO,
    );
    expect(leerPaginacion({ limit: 0 }).take).toBe(
      TAMANO_DE_PAGINA_POR_DEFECTO,
    );
  });

  it("calcula el salto de cada página", () => {
    expect(leerPaginacion({ page: 3, limit: 20 }).skip).toBe(40);
    expect(leerPaginacion({ page: 1, limit: 20 }).skip).toBe(0);
  });
});

describe("metadatosDePagina", () => {
  it("🔒 avisa que la lista está cortada cuando falta traer filas", () => {
    // El caso real: 19.325 productos, la pantalla pide 500.
    const meta = metadatosDePagina(19_325, leerPaginacion({ limit: 500 }));
    expect(meta.totalRecords).toBe(19_325);
    expect(meta.pageSize).toBe(500);
    expect(meta.truncated).toBe(true);
  });

  it("no avisa de corte cuando la página alcanza para todo", () => {
    const meta = metadatosDePagina(128, leerPaginacion({ limit: 500 }));
    expect(meta.totalRecords).toBe(128);
    expect(meta.truncated).toBe(false);
    expect(meta.totalPages).toBe(1);
  });

  it("la última página no se reporta como cortada", () => {
    // 3 páginas de 50 para 120 filas: la tercera cierra la lista.
    const ultima = metadatosDePagina(120, leerPaginacion({ page: 3, limit: 50 }));
    expect(ultima.truncated).toBe(false);
    expect(ultima.totalPages).toBe(3);

    const primera = metadatosDePagina(120, leerPaginacion({ page: 1, limit: 50 }));
    expect(primera.truncated).toBe(true);
  });

  it("una lista vacía no rompe ni miente", () => {
    const meta = metadatosDePagina(0, leerPaginacion({}));
    expect(meta.totalRecords).toBe(0);
    expect(meta.truncated).toBe(false);
    // Una página, vacía — no cero páginas, que rompería cualquier paginador.
    expect(meta.totalPages).toBe(1);
  });

  it("marca cuando al cliente se le recortó lo que pidió", () => {
    const meta = metadatosDePagina(1000, leerPaginacion({ limit: 50_000 }));
    expect(meta.limitClamped).toBe(true);
    expect(meta.pageSize).toBe(TAMANO_DE_PAGINA_MAXIMO);
  });
});
