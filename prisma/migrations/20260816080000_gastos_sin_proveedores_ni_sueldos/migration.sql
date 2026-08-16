-- Saca "Pago a proveedor" y "Sueldos" del submódulo de Gastos.
--
-- ── Por qué ────────────────────────────────────────────────────────────────
--
-- Gastos, dentro de Finanzas, registra lo que SALE DEL CAJÓN en la operación
-- diaria: un flete, un producto de limpieza, la boleta de luz.
--
-- Un pago a proveedor ya tiene su lugar en Compras, y un sueldo en
-- Liquidaciones. Tenerlos también acá invita a cargar la misma plata dos veces
-- —una en cada módulo— y a partir del segundo mes nadie sabe cuál de los dos
-- números es el bueno.
--
-- ── Por qué se DESACTIVAN y no se borran ───────────────────────────────────
--
-- Se verificó contra producción: hoy no hay ningún gasto con estas dos
-- categorías, así que no hay histórico en juego. Aun así se desactivan en vez
-- de borrarse, porque es reversible: si mañana el criterio cambia, el dueño las
-- vuelve a activar desde la aplicación sin necesidad de una migración.
--
-- Dejan de ser "del sistema" justamente para que pueda administrarlas.
UPDATE "ExpenseCategory"
   SET "isActive"  = false,
       "isSystem"  = false,
       "updatedAt" = NOW()
 WHERE "key" IN ('SUPPLIER_PAYMENT', 'SALARY');
