-- Cómo trabaja el POS: dos modos, y el dueño elige.
--
-- ── El problema ────────────────────────────────────────────────────────────
--
-- Hasta ahora había un solo modo posible, y cambiar de operador CERRABA la
-- sesión del anterior. En un mostrador donde tres personas se alternan sobre
-- una misma caja, eso es identificarse de cero todo el día.
--
-- Pero no todos los locales trabajan igual: en otro puede haber una
-- computadora por persona, cada una con su sesión, y ahí las terminales
-- compartidas sólo agregan pasos.
--
-- ── Los dos modos ──────────────────────────────────────────────────────────
--
--   SESION_POR_USUARIO   (por defecto, es como funciona hoy)
--     Cada quien en su computadora con su sesión. Sin pestañas, sin PIN de
--     mostrador. Si alguien más tiene que vender, inicia sesión con su cuenta.
--
--   TERMINAL_COMPARTIDA
--     Una computadora hace de caja central y varias personas venden desde ahí,
--     cada una en su pestaña, entrando con su código. Nadie cierra sesión.
--
-- ── Por qué el modo por defecto es el de hoy ───────────────────────────────
--
-- Porque una migración no debe cambiarle el modo de trabajo a nadie. Quien
-- quiera terminales compartidas las enciende; quien no toque nada sigue igual.
--
-- La pieza que hace posible el modo compartido ya existía: el índice único de
-- "una sola sesión ACTIVA por terminal" es parcial, así que varias sesiones
-- LOCKED conviven sin violarlo. Una pestaña por sesión — la que se está usando
-- queda ACTIVE, las demás LOCKED. Cada venta se sigue atribuyendo contra la
-- única sesión activa, que es lo que la mantiene confiable.
ALTER TABLE "AppSetting"
  ADD COLUMN IF NOT EXISTS "posModoOperacion" TEXT NOT NULL DEFAULT 'SESION_POR_USUARIO';

-- Si al volver a la pestaña de otro hay que reingresar su código.
--
-- Encendido por defecto, y a propósito: sin esto, cualquiera que pase por la
-- caja puede tocar la pestaña de un compañero y vender a su nombre. Con la
-- comisión calculada por vendedor, eso no es una molestia teórica.
-- El dueño puede apagarlo si prioriza velocidad sobre trazabilidad.
ALTER TABLE "AppSetting"
  ADD COLUMN IF NOT EXISTS "posPinAlCambiarDePestana" BOOLEAN NOT NULL DEFAULT true;
