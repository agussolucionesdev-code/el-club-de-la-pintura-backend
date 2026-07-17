/**
 * Settings Controller — the shop-wide switches the owner controls.
 *
 * Reading is open to any signed-in role because the UI needs these to decide
 * what to render; writing is ADMIN only, enforced by the route guard. The
 * settings themselves are never secrets — the thing they gate (the discount
 * code) is protected at its own endpoint, not by hiding this one.
 *
 * @module settings.controller
 */
import { Response } from "express";
import { logger } from "../../config/logger";
import prisma from "../../config/db";
import { AuthRequest } from "../../middlewares/auth.middleware";

export interface AppSettings {
  discountCodeVisibleToEncargado: boolean;
  alertCashEnabled: boolean;
  alertStockEnabled: boolean;
  alertStockMinCount: number;
  alertAccountsEnabled: boolean;
  alertAccountsMinDebt: number;
  alertPayrollEnabled: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  discountCodeVisibleToEncargado: true,
  alertCashEnabled: true,
  alertStockEnabled: true,
  alertStockMinCount: 1,
  alertAccountsEnabled: true,
  alertAccountsMinDebt: 0,
  alertPayrollEnabled: true,
};

/**
 * Reads the single settings row, creating it on first use.
 *
 * Shared with the alerts controller, and it never throws: if the table is not
 * there yet the app falls back to defaults instead of breaking the sidebar —
 * a missing setting must not take the menu down with it.
 */
export const readSettings = async (): Promise<AppSettings> => {
  try {
    const row = await prisma.appSetting.findUnique({ where: { id: 1 } });
    if (row) return row;
    return await prisma.appSetting.create({ data: { id: 1 } });
  } catch (err) {
    logger.warn("No se pudo leer AppSetting; usando valores por defecto:", err);
    return DEFAULT_SETTINGS;
  }
};

/** GET /settings — any signed-in role. */
export const getSettings = async (_req: AuthRequest, res: Response) => {
  try {
    res.status(200).json({ data: await readSettings() });
  } catch (error) {
    logger.error("Error al leer la configuración:", error);
    res.status(500).json({ error: "No se pudo leer la configuración." });
  }
};

/** Clamp so a typo cannot silently disable an alert forever. */
const asCount = (value: unknown, fallback: number, max: number) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
};

/** PUT /settings — ADMIN only (guarded on the route). */
export const updateSettings = async (req: AuthRequest, res: Response) => {
  try {
    const current = await readSettings();
    const b = req.body ?? {};

    const next: AppSettings = {
      discountCodeVisibleToEncargado:
        typeof b.discountCodeVisibleToEncargado === "boolean"
          ? b.discountCodeVisibleToEncargado
          : current.discountCodeVisibleToEncargado,
      alertCashEnabled:
        typeof b.alertCashEnabled === "boolean" ? b.alertCashEnabled : current.alertCashEnabled,
      alertStockEnabled:
        typeof b.alertStockEnabled === "boolean" ? b.alertStockEnabled : current.alertStockEnabled,
      alertStockMinCount: asCount(b.alertStockMinCount, current.alertStockMinCount, 999),
      alertAccountsEnabled:
        typeof b.alertAccountsEnabled === "boolean"
          ? b.alertAccountsEnabled
          : current.alertAccountsEnabled,
      alertAccountsMinDebt: asCount(b.alertAccountsMinDebt, current.alertAccountsMinDebt, 999_999_999),
      alertPayrollEnabled:
        typeof b.alertPayrollEnabled === "boolean"
          ? b.alertPayrollEnabled
          : current.alertPayrollEnabled,
    };

    const saved = await prisma.appSetting.upsert({
      where: { id: 1 },
      update: next,
      create: { id: 1, ...next },
    });

    res.status(200).json({ message: "Configuración actualizada.", data: saved });
  } catch (error) {
    logger.error("Error al guardar la configuración:", error);
    res.status(500).json({ error: "No se pudo guardar la configuración." });
  }
};
