-- ROLLBACK / FORWARD-FIX de la FASE 3 (terminales físicas).
--
-- ⚠️ ESTE ARCHIVO NO ES UNA MIGRACIÓN. Prisma lo ignora: vive acá para estar a
-- mano junto a las migraciones que revierte. Se ejecuta a MANO, con
-- autorización explícita, y sólo si hace falta dar marcha atrás.
--
-- ── Qué se puede revertir y qué no ──────────────────────────────────────────
--
-- De las cuatro migraciones de la fase, tres son ADITIVAS y no necesitan
-- rollback: alcanza con desplegar el código anterior y quedan inertes.
--
--   20260812160000_add_terminal_expand ......... aditiva → se deja
--   20260812170000_backfill_legacy_terminals ... datos    → se deja
--   20260812180000_shift_per_terminal_index_swap  índices → ver abajo
--   20260812200000_contract_..._required ....... CONTRACT → ver abajo
--
-- Sólo las dos últimas cambian reglas vigentes.
--
-- ── Orden de ejecución ──────────────────────────────────────────────────────
-- Se revierte en el orden INVERSO al que se aplicó. Saltear un paso deja la
-- base en un estado que ninguna versión del código espera.

-- ───────────────────────────────────────────────────────────────────────────
-- PASO 1 — Deshacer el CONTRACT: la columna vuelve a admitir nulos.
--
-- Seguro e inmediato: aflojar una restricción nunca puede fallar por datos.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "CashRegister" ALTER COLUMN "terminalId" DROP NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- PASO 2 — Volver a "un turno abierto por SUCURSAL".
--
-- ⚠️ EL ORDEN IMPORTA: primero se crea el índice viejo y DESPUÉS se borra el
-- nuevo. Al revés quedaría una ventana sin ninguna restricción, y en esa
-- ventana dos aperturas simultáneas crearían turnos duplicados —el bug P0-3 que
-- la Fase 1 vino a cerrar—.
--
-- ⚠️ PRECONDICIÓN: si en este momento hay DOS terminales de la misma sucursal
-- con caja abierta —algo que la Fase 3 habilita—, este índice NO se puede
-- crear. Hay que cerrar uno de esos turnos con su arqueo antes de seguir.
-- Para saber si es el caso:
--
--   SELECT "branchId", COUNT(*) FROM "CashRegister"
--   WHERE status = 'OPEN' GROUP BY 1 HAVING COUNT(*) > 1;
--
-- Si devuelve filas, cerrá esos turnos por la aplicación (no a mano en la base:
-- el cierre calcula el arqueo y emite el comprobante).
-- ───────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "cash_register_one_open_per_branch_TRANSITIONAL"
  ON "CashRegister" ("branchId")
  WHERE status = 'OPEN';

DROP INDEX IF EXISTS "cash_register_one_open_per_terminal";

-- ───────────────────────────────────────────────────────────────────────────
-- PASO 3 — Desplegar el código anterior a la Fase 3.
--
-- Las tablas `Terminal` y `TerminalEnrollment` y las columnas `terminalId`
-- quedan puestas y sin usar. NO se borran: contienen el historial de qué caja
-- hizo cada venta, y ese dato no se recupera. Si algún día se decide eliminarlas
-- de verdad, es una decisión aparte y con su propio respaldo.
-- ───────────────────────────────────────────────────────────────────────────

-- ── Verificación posterior ─────────────────────────────────────────────────
-- Después de correr esto, confirmá el estado:
--
--   SELECT indexname FROM pg_indexes WHERE tablename = 'CashRegister';
--     → debe estar  cash_register_one_open_per_branch_TRANSITIONAL
--     → NO debe estar cash_register_one_open_per_terminal
--
--   SELECT is_nullable FROM information_schema.columns
--   WHERE table_name = 'CashRegister' AND column_name = 'terminalId';
--     → debe decir YES
