-- FASE 3 · PASO 6 (CONTRACT): `CashRegister.terminalId` pasa a OBLIGATORIA.
--
-- Es el último paso del expand-migrate-contract, y el único con rollback real:
-- todos los anteriores son aditivos y se pueden dejar puestos.
--
-- ── Por qué acá SÍ corresponde exigirla ─────────────────────────────────────
--
-- Un turno de caja sin terminal es un arqueo sin cajón: no se puede decir de
-- qué máquina salió la plata, que es justamente el problema que esta fase vino
-- a resolver. `openShift` ya resuelve la terminal siempre y rechaza la apertura
-- si no puede, así que todo escritor la completa.
--
-- `Sale.terminalId`, en cambio, SIGUE siendo nullable a propósito: una venta
-- puede ocurrir en una sucursal que todavía no tiene terminales configuradas, y
-- dejar de vender por eso sería inaceptable en un mostrador.
--
-- ── Precondiciones ──────────────────────────────────────────────────────────
--
-- Se verifican acá adentro y la migración ABORTA si no se cumplen, en vez de
-- fallar a mitad del ALTER con un mensaje de PostgreSQL que no dice qué hacer.

DO $$
DECLARE
  sin_terminal INTEGER;
  incoherentes INTEGER;
BEGIN
  SELECT COUNT(*) INTO sin_terminal
  FROM "CashRegister" WHERE "terminalId" IS NULL;

  IF sin_terminal > 0 THEN
    RAISE EXCEPTION
      'Hay % turno(s) sin terminal asignada. Corré el backfill (20260812170000) antes de este paso.',
      sin_terminal;
  END IF;

  SELECT COUNT(*) INTO incoherentes
  FROM "CashRegister" cr
  JOIN "Terminal" t ON t.id = cr."terminalId"
  WHERE t."branchId" <> cr."branchId";

  IF incoherentes > 0 THEN
    RAISE EXCEPTION
      'Hay % turno(s) apuntando a una terminal de OTRA sucursal. Revisalos antes de continuar.',
      incoherentes;
  END IF;
END $$;

ALTER TABLE "CashRegister" ALTER COLUMN "terminalId" SET NOT NULL;

-- La clave foránea se recrea a propósito.
--
-- Al pasar la columna de nullable a obligatoria cambia la forma de la relación
-- (`Terminal?` → `Terminal`), y Prisma espera la restricción declarada con esa
-- forma. Sin esto, `migrate diff` reporta deriva permanente entre el esquema y
-- la base — y ese chequeo es justamente el que se agregó al CI para que una
-- migración incompleta no pase en verde. Lo detectó en esta misma migración.
ALTER TABLE "CashRegister" DROP CONSTRAINT "CashRegister_terminalId_fkey";

ALTER TABLE "CashRegister" ADD CONSTRAINT "CashRegister_terminalId_fkey"
  FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
