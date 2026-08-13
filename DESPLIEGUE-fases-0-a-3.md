# Despliegue de las Fases 0 a 3 — paso a paso

Nueve migraciones nuevas. Ninguna se aplicó a producción todavía.

> **Regla que no se rompe:** cada paso se verifica antes de pasar al siguiente.
> Si un paso no da el resultado esperado, se detiene todo y se revisa. No se
> avanza "a ver si se arregla solo".

---

## Antes de empezar — tres cosas obligatorias

### 1. Punto de recuperación

Neon **no tiene backups automáticos** en el plan actual. Antes de tocar nada:

- Entrá a Neon → proyecto → **Branches** → crear una branch desde `production`
  llamada `respaldo-pre-fase3`, con **data y schema** (no schema-only).
- Auto-delete en **Never**.

Es el único camino de vuelta si algo sale mal con datos reales.

### 2. Variable de entorno nueva en Render

```
COOKIE_SAME_SITE=none
```

**Por qué es obligatoria:** el frontend está en Vercel y la API en Render — son
orígenes distintos. Con `SameSite=Lax` la cookie de terminal **no viaja**, así
que el enrolamiento andaría en local y fallaría en el mostrador.

Si ya está puesta (la usa el cookie de sesión), verificá que diga `none`.

### 3. Momento

Fuera del horario de atención de las dos sucursales. El paso 5 toma un lock de
milisegundos sobre `CashRegister`, pero el paso 6 exige que **no haya turnos
abiertos duplicados**, y eso se verifica mejor con las cajas cerradas.

---

## Paso 1 — Reconciliar la migración de la Fase 0

**Qué:** marcar como aplicada, SIN ejecutarla, la migración que crea la tabla
`Return` y `Branch.isActive`.

**Por qué:** esos objetos **ya existen en producción** — se crearon en su
momento con `prisma db push`, que no deja registro en el historial de
migraciones. La migración los declara para que una base nueva los tenga; contra
producción sería un no-op.

```bash
npx prisma migrate resolve --applied 20260811220000_reconcile_return_table_and_branch_isactive
```

**Verificar:**
```bash
npx prisma migrate status
```
→ debe listar las otras ocho como pendientes, y **no** esta.

---

## Paso 2 — Aplicar las migraciones aditivas

Las cinco siguientes son **aditivas puras**: tablas, enums y columnas nullable.
Ninguna fila existente cambia y el código desplegado hoy las ignora.

```bash
npx prisma migrate deploy
```

Esto aplica, en orden:

| Migración | Qué agrega |
|---|---|
| `..._one_open_cash_register_per_branch` | Índice único parcial (transitorio) |
| `..._add_idempotency_record` | Tabla + enum de idempotencia |
| `..._add_sale_cash_received_and_change` | Efectivo recibido y vuelto |
| `..._add_refund_settlement` | Liquidación de reintegros |
| `..._add_terminal_expand` | Terminales (tablas + columnas nullable) |
| `..._backfill_legacy_terminals` | Una terminal legado por sucursal |
| `..._shift_per_terminal_index_swap` | Turno por terminal + retiro del transitorio |
| `..._contract_..._required` | `terminalId` pasa a obligatoria |

> ⚠️ **El paso 6 (`shift_per_terminal_index_swap`) y el 7 (`contract`) abortan
> solos** si detectan turnos abiertos sin terminal o apuntando a otra sucursal.
> No hace falta cuidarlos a mano: la migración se defiende.

**Verificar antes de desplegar código:**

```sql
-- Ningún turno sin terminal
SELECT COUNT(*) FROM "CashRegister" WHERE "terminalId" IS NULL;             -- 0

-- Ningún turno con terminal de otra sucursal
SELECT COUNT(*) FROM "CashRegister" cr
JOIN "Terminal" t ON t.id = cr."terminalId"
WHERE t."branchId" <> cr."branchId";                                        -- 0

-- Una terminal legado por sucursal
SELECT b.name, t.code FROM "Branch" b LEFT JOIN "Terminal" t ON t."branchId" = b.id;

-- El índice transitorio ya no está; sí el nuevo
SELECT indexname FROM pg_indexes WHERE tablename = 'CashRegister';
--   ✓ cash_register_one_open_per_terminal
--   ✗ cash_register_one_open_per_branch_TRANSITIONAL
```

Si alguna no da lo esperado: **frenar**. El runbook de vuelta atrás es
`prisma/migrations/ROLLBACK-fase-3.sql`.

---

## Paso 3 — Desplegar el backend

Push a `main` → Render redeploya solo.

El arranque corre `prisma migrate deploy` de nuevo (es idempotente, no hace
nada) y levanta.

**Verificar:**
```bash
curl https://<api>/api/health
```

---

## Paso 4 — Desplegar el frontend

Push a `main` → Vercel redeploya solo.

**Verificar en el navegador, con sesión de admin:**

1. **Configuración → Terminales** lista las dos terminales `LEGACY-*`, ambas
   *SIN ENROLAR*, con su sucursal correcta.
2. Abrir caja desde el POS y confirmar que la terminal queda asociada.
3. Cobrar una venta de prueba y comprobar que el ticket dice
   `Terminal: LEGACY-… · Turno: …`.

---

## Paso 5 — Enrolar las computadoras reales

Una vez por máquina, y sólo cuando estés parado frente a ella:

1. **Configuración → Terminales** → *Enrolar* en la terminal que corresponda.
2. Copiar el token (se muestra **una sola vez**, vence en 30 minutos).
3. En **esa** computadora, ir al POS y pegarlo en el recuadro de arriba.
4. El recuadro se reduce a una línea: *"Esta computadora es LEGACY-318 · Caja
   principal"*.

Conviene renombrar las terminales a algo que el personal diga en voz alta
(`893-CAJA-01`, `DONATO-CAJA-01`) antes de enrolarlas.

---

## Lo que cambia para quien atiende

| Antes | Después |
|---|---|
| Un turno abierto por **sucursal** | Un turno abierto por **terminal** |
| El ticket decía sólo el nº de turno | Dice terminal **y** turno |
| El precio lo podía fijar el cliente | Lo pone la base, siempre |
| El vuelto se calculaba en pantalla y se perdía | Queda registrado en la venta |
| Un reintento de red podía duplicar la venta | La clave de idempotencia lo impide |
| Devolución de venta pagada no movía la caja | Se liquida y se registra por dónde volvió |

**Un cambio visible que conviene avisar:** si el precio de un producto cambia
mientras alguien arma un ticket, al cobrar aparece un aviso con el importe
vigente y hay que confirmarlo. Es deliberado: el sistema **nunca** cobra un
monto distinto al que el operador vio en pantalla.

---

## Si algo sale mal

1. **Durante las migraciones** → el paso falla solo y no deja nada a medias
   (cada una corre en su transacción). Revisar el mensaje, corregir, reintentar.
2. **Después de desplegar** → `prisma/migrations/ROLLBACK-fase-3.sql`, ejecutado
   a mano y **en orden**, más desplegar el commit anterior.
3. **Con datos ya escritos** → restaurar desde la branch `respaldo-pre-fase3`.

Las tablas y columnas nuevas **nunca se borran** en un rollback: contienen el
historial de qué caja hizo cada venta, y ese dato no se recupera.
