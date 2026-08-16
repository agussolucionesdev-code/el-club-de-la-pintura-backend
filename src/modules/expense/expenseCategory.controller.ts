/**
 * Categorías de gasto: la lista y sus colores, administrables desde la app.
 *
 * ── Las tres reglas de este archivo ─────────────────────────────────────────
 *
 * 1. **La lista es cerrada.** Un gasto sólo puede apuntar a una categoría que
 *    exista y esté activa. Antes era texto libre: "Limpieza" y "LIMPIEZA" eran
 *    dos categorías distintas para los gráficos, y cualquier valor fuera del
 *    mapa del frontend salía gris y sin nombre.
 *
 * 2. **Nada se borra si tiene historia.** Una categoría con gastos se desactiva:
 *    deja de poder elegirse, pero sigue nombrando y coloreando el pasado.
 *    Borrarla dejaría años de gastos sin etiqueta.
 *
 * 3. **La clave no se toca, el nombre sí.** `key` es lo que quedó guardado en
 *    cada gasto; renombrar la etiqueta cambia lo que se ve sin reescribir el
 *    histórico.
 */

import { Response } from "express";

import prisma from "../../config/db";
import { logger } from "../../config/logger";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";

/** `#rrggbb`. Se valida porque va directo a un `style` y a los gráficos. */
const COLOR_VALIDO = /^#[0-9a-fA-F]{6}$/u;

/**
 * Clave estable a partir del nombre: "Fletes y logística" → "FLETES_Y_LOGISTICA".
 *
 * Se genera en el servidor y no se le pide al usuario: nadie que administra una
 * pinturería tiene por qué saber qué es una clave estable.
 */
const claveDesdeNombre = (nombre: string): string =>
  nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "") // saca los acentos
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 40);

/** GET /expenses/categories — la lista para pintar y para elegir. */
export const listExpenseCategories = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    // Se devuelven TODAS, activas e inactivas: las inactivas ya no se pueden
    // elegir, pero la pantalla las necesita para nombrar y colorear los gastos
    // viejos que las usaron.
    const categorias = await prisma.expenseCategory.findMany({
      orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
    });

    return res.json({ data: categorias });
  } catch (error) {
    logger.error("Error al listar categorías de gasto:", error);
    return res.status(500).json({ error: "No se pudieron obtener las categorías." });
  }
};

/** POST /expenses/categories — alta. Sólo ADMIN. */
export const createExpenseCategory = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });
    if (authUser.role !== "ADMIN") {
      return res
        .status(403)
        .json({ error: "Sólo el dueño puede crear categorías de gasto." });
    }

    const { label, color } = req.body as { label?: string; color?: string };
    const nombre = String(label ?? "").trim();

    if (nombre.length < 2 || nombre.length > 40) {
      return res
        .status(400)
        .json({ error: "El nombre de la categoría debe tener entre 2 y 40 caracteres." });
    }
    const tono = String(color ?? "#64748b");
    if (!COLOR_VALIDO.test(tono)) {
      return res.status(400).json({ error: "El color debe ser un hexadecimal como #f59e0b." });
    }

    const key = claveDesdeNombre(nombre);
    if (!key) {
      return res
        .status(400)
        .json({ error: "El nombre necesita al menos una letra o número." });
    }

    // Se busca por CLAVE o por NOMBRE.
    //
    // Por nombre es lo que no era obvio: escribir "Sueldos" generaría la clave
    // SUELDOS, distinta de la del sistema (SALARY), y nacerían dos categorías
    // que el usuario ve idénticas. Indistinguibles en pantalla y separadas en
    // el gráfico: exactamente el problema que esta lista vino a resolver.
    const coincidencias = await prisma.expenseCategory.findMany({
      where: {
        OR: [{ key }, { label: { equals: nombre, mode: "insensitive" } }],
      },
    });

    // La activa gana sobre la inactiva, y a igualdad la más vieja.
    //
    // Un `findFirst` sin orden explícito devuelve cualquiera de las que
    // matcheen, así que con dos coincidencias el resultado dependía del humor
    // del planificador de Postgres: a veces 409, a veces reactivar. Un
    // comportamiento no determinista sobre datos es un test que falla un día de
    // cada diez y nadie sabe por qué.
    const yaExiste =
      coincidencias.find((c) => c.isActive) ??
      coincidencias.sort((a, b) => a.id - b.id)[0];

    if (yaExiste) {
      // Si existe pero está inactiva, se reactiva en vez de crear una gemela:
      // dos categorías con el mismo nombre parten el histórico en dos.
      if (!yaExiste.isActive) {
        const revivida = await prisma.expenseCategory.update({
          where: { id: yaExiste.id },
          data: { isActive: true, label: nombre, color: tono },
        });
        return res.status(200).json({
          message: `"${nombre}" ya existía desactivada y se volvió a activar.`,
          data: revivida,
        });
      }
      return res.status(409).json({ error: `Ya existe una categoría "${yaExiste.label}".` });
    }

    const creada = await prisma.expenseCategory.create({
      data: { key, label: nombre, color: tono, createdById: authUser.id },
    });

    logger.info(`[gastos] categoría creada: ${key} por el usuario ${authUser.id}`);
    return res.status(201).json({ message: "Categoría creada.", data: creada });
  } catch (error) {
    logger.error("Error al crear categoría de gasto:", error);
    return res.status(500).json({ error: "No se pudo crear la categoría." });
  }
};

/** PATCH /expenses/categories/:id — renombrar, recolorear o desactivar. */
export const updateExpenseCategory = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });
    if (authUser.role !== "ADMIN") {
      return res
        .status(403)
        .json({ error: "Sólo el dueño puede modificar categorías de gasto." });
    }

    const id = Number(req.params["id"]);
    const categoria = await prisma.expenseCategory.findUnique({ where: { id } });
    if (!categoria) return res.status(404).json({ error: "La categoría no existe." });

    const { label, color, isActive } = req.body as {
      label?: string;
      color?: string;
      isActive?: boolean;
    };

    const datos: { label?: string; color?: string; isActive?: boolean } = {};

    if (label !== undefined) {
      const nombre = String(label).trim();
      if (nombre.length < 2 || nombre.length > 40) {
        return res.status(400).json({ error: "El nombre debe tener entre 2 y 40 caracteres." });
      }
      // Sólo cambia la etiqueta: la `key` queda intacta para no romper el
      // histórico ni los gastos que ya la referencian.
      datos.label = nombre;
    }

    if (color !== undefined) {
      if (!COLOR_VALIDO.test(String(color))) {
        return res.status(400).json({ error: "El color debe ser un hexadecimal como #f59e0b." });
      }
      datos.color = String(color);
    }

    if (isActive !== undefined) {
      if (!isActive && categoria.isSystem) {
        return res.status(409).json({
          error: `"${categoria.label}" vino con el sistema y no se puede desactivar.`,
        });
      }
      datos.isActive = Boolean(isActive);
    }

    const actualizada = await prisma.expenseCategory.update({ where: { id }, data: datos });
    return res.json({ message: "Categoría actualizada.", data: actualizada });
  } catch (error) {
    logger.error("Error al actualizar categoría de gasto:", error);
    return res.status(500).json({ error: "No se pudo actualizar la categoría." });
  }
};

/**
 * DELETE /expenses/categories/:id
 *
 * Borra de verdad SÓLO si nunca se usó. Con gastos apuntando a ella, se
 * desactiva: borrarla dejaría esos gastos sin nombre ni color para siempre.
 */
export const deleteExpenseCategory = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });
    if (authUser.role !== "ADMIN") {
      return res
        .status(403)
        .json({ error: "Sólo el dueño puede eliminar categorías de gasto." });
    }

    const id = Number(req.params["id"]);
    const categoria = await prisma.expenseCategory.findUnique({ where: { id } });
    if (!categoria) return res.status(404).json({ error: "La categoría no existe." });

    if (categoria.isSystem) {
      return res.status(409).json({
        error: `"${categoria.label}" vino con el sistema y no se puede eliminar.`,
      });
    }

    const enUso = await prisma.expense.count({ where: { category: categoria.key } });

    if (enUso > 0) {
      const desactivada = await prisma.expenseCategory.update({
        where: { id },
        data: { isActive: false },
      });
      return res.json({
        message:
          `"${categoria.label}" tiene ${enUso} gasto(s) registrados, así que se desactivó ` +
          `en vez de borrarse: deja de aparecer para cargar, pero sigue nombrando los viejos.`,
        data: desactivada,
      });
    }

    await prisma.expenseCategory.delete({ where: { id } });
    return res.json({ message: `"${categoria.label}" eliminada.`, data: { id } });
  } catch (error) {
    logger.error("Error al eliminar categoría de gasto:", error);
    return res.status(500).json({ error: "No se pudo eliminar la categoría." });
  }
};

/**
 * ¿Se puede cargar un gasto con esta categoría?
 *
 * La usa `registerExpense`. Antes cualquier string entraba, y por eso hoy
 * conviven "LIMPIEZA", "Limpieza" y "LOGISTICA" partiendo los gráficos en
 * pedazos que deberían ser uno.
 */
export const assertCategoriaValida = async (key: string): Promise<void> => {
  const categoria = await prisma.expenseCategory.findUnique({ where: { key } });
  if (!categoria) {
    throw new Error(`La categoría "${key}" no existe. Elegí una de la lista.`);
  }
  if (!categoria.isActive) {
    throw new Error(
      `La categoría "${categoria.label}" está desactivada y no se puede usar para gastos nuevos.`,
    );
  }
};
