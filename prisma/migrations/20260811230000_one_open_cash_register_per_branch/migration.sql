-- Un solo turno de caja ABIERTO por sucursal, impuesto por la base.
--
-- Hasta ahora la regla vivía sólo en código: `openShift` hacía un `findFirst`
-- y después un `create`, sin transacción y sin constraint. Entre esas dos
-- sentencias hay una ventana real: dos aperturas simultáneas para la misma
-- sucursal pasaban ambas el chequeo y creaban dos turnos abiertos. Con dos
-- turnos abiertos el arqueo es irreconciliable — las ventas se reparten entre
-- los dos y ninguno cuadra.
--
-- ⚠️ TRANSITORIO. Se retira en la Fase 3, paso 5, cuando exista el modelo
-- `Terminal` y la regla pase a ser "un turno abierto por TERMINAL". Si este
-- índice sobreviviera a esa fase, dos terminales de la misma sucursal nunca
-- podrían tener caja abierta a la vez — justo lo que la Fase 3 viene a
-- habilitar. El sufijo del nombre está para que nadie dude de su destino.
--
-- Índice parcial: sólo restringe las filas con status='OPEN'. Los turnos
-- cerrados históricos no se ven afectados, y puede haber tantos como quiera
-- por sucursal.
--
-- Sin CONCURRENTLY a propósito: PostgreSQL lo prohíbe dentro del bloque
-- transaccional que Prisma abre por migración, y `CashRegister` es una tabla
-- chica (un puñado de turnos por día). El lock dura milisegundos.

CREATE UNIQUE INDEX IF NOT EXISTS "cash_register_one_open_per_branch_TRANSITIONAL"
  ON "CashRegister" ("branchId")
  WHERE status = 'OPEN';
