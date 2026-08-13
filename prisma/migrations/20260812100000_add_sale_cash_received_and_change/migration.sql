-- Efectivo recibido y vuelto en la venta.
--
-- El POS los calculaba en pantalla y los DESCARTABA al confirmar: el handler de
-- `onConfirm` ignoraba el argumento `cashReceived`, así que nunca llegaban al
-- servidor. El arqueo no podía contrastar lo que el cajero dijo haber recibido
-- contra lo que había en el cajón.
--
-- Ambas nullable: `null` significa "no registrado" — ventas históricas y cobros
-- sin componente en efectivo.

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "cashReceived" DECIMAL(14,2),
ADD COLUMN     "changeGiven" DECIMAL(14,2);

