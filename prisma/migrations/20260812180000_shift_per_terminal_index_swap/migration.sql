-- FASE 3 · PASOS 4 y 5: el turno pasa a ser POR TERMINAL.
--
-- ⚠️ ESTE ES EL PASO QUE FALTABA EN LA PRIMERA VERSIÓN DEL PLAN.
--
-- La Fase 1 creó un índice único parcial de "un turno abierto por SUCURSAL"
-- (`cash_register_one_open_per_branch_TRANSITIONAL`) para cerrar P0-3 cuando
-- todavía no existía el modelo `Terminal`. Si ese índice sobreviviera a esta
-- migración, **dos terminales de la misma sucursal nunca podrían tener caja
-- abierta a la vez** — justo lo que esta fase viene a habilitar. El sistema
-- quedaría peor que antes de empezar.
--
-- Los dos pasos van en la MISMA migración a propósito: entre crear el índice
-- nuevo y borrar el viejo, la restricción anterior sigue vigente. No hay ni un
-- instante sin protección contra turnos duplicados.
--
-- Sin CONCURRENTLY: PostgreSQL lo prohíbe dentro del bloque transaccional que
-- Prisma abre por migración, y `CashRegister` es una tabla chica (un puñado de
-- turnos por día). El lock dura milisegundos.

-- Precondición: ningún turno abierto puede haber quedado sin terminal.
-- Si el backfill no corrió, esto aborta la migración en vez de crear un índice
-- sobre datos incompletos.
DO $$
DECLARE
  huerfanos INTEGER;
BEGIN
  SELECT COUNT(*) INTO huerfanos
  FROM "CashRegister"
  WHERE status = 'OPEN' AND "terminalId" IS NULL;

  IF huerfanos > 0 THEN
    RAISE EXCEPTION
      'Hay % turno(s) abierto(s) sin terminal asignada. Corré el backfill (20260812170000) antes de esta migración.',
      huerfanos;
  END IF;
END $$;

-- PASO 4: un turno ABIERTO por terminal.
CREATE UNIQUE INDEX IF NOT EXISTS "cash_register_one_open_per_terminal"
  ON "CashRegister" ("terminalId")
  WHERE status = 'OPEN';

-- PASO 5: retirar el índice transitorio por sucursal. Nace para morir acá.
DROP INDEX IF EXISTS "cash_register_one_open_per_branch_TRANSITIONAL";
