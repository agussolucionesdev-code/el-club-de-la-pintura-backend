# Respaldos: cómo funcionan y cómo se restaura

> Un respaldo que nadie probó restaurar no es un respaldo: es un archivo.
> Este documento existe para que el día que haga falta, nadie tenga que
> averiguar nada.

## El problema que esto resuelve

Neon en el plan actual **no tiene respaldos automáticos**. Sin esto, un borrado
por error contra la base real no tiene vuelta atrás.

No es hipotético. Durante el desarrollo se aplicaron once migraciones a
producción por accidente, y no se perdió nada **de casualidad, no por diseño**.

## Las dos capas

Se complementan, y hacen falta las dos.

### 1. El respaldo diario — la red de abajo

`.github/workflows/backup.yml`. Corre solo todas las madrugadas a las 03:10
(hora de Argentina), con el negocio cerrado.

- Un `pg_dump` completo, comprimido.
- **Se verifica**: que descomprima, que tenga las tablas principales, y que
  tenga el pie que PostgreSQL escribe al terminar. Un dump cortado a la mitad
  falla el job en vez de guardarse como si estuviera bien.
- Queda guardado **90 días** como artefacto del repositorio.

**Costo: cero.** GitHub Actions da 2.000 minutos gratis por mes en repos
privados; este job tarda menos de uno.

### 2. La branch de Neon — el arnés

Antes de **cualquier** migración o operación riesgosa, se toma a mano una branch
de Neon desde `production`, con datos y esquema, y auto-delete en *Never*.

Es instantánea y no copia los datos físicamente (Neon usa copy-on-write), así
que es gratis y no tarda.

**Por qué hacen falta las dos:** el dump diario no te sirve para recuperar algo
que se rompió hace tres horas. La branch sí, pero sólo si te acordaste de
tomarla antes. Una cubre el olvido, la otra cubre el desastre.

## Puesta en marcha (una sola vez)

1. En GitHub → el repo del backend → **Settings → Secrets and variables →
   Actions → New repository secret**.
2. Nombre: `PRODUCTION_DATABASE_URL`. Valor: la cadena de conexión de Neon.
3. Listo. El primer respaldo corre esa madrugada; para probarlo ya, andá a
   **Actions → Respaldo diario de la base → Run workflow**.

## Cómo restaurar

**Antes de empezar: no restaures sobre la base viva.** Restaurá en una base
nueva, mirá que esté todo, y recién después decidí. Restaurar encima de
producción borra lo que haya pasado desde el respaldo.

```bash
# 1. Bajar el respaldo desde Actions → la corrida que quieras → Artifacts
# 2. Crear una base vacía (una branch nueva de Neon sirve perfecto)
# 3. Restaurar ahí:
gunzip -c respaldo-2026-08-14.sql.gz | psql "<URL-DE-LA-BASE-NUEVA>"
```

El dump se genera con `--clean --if-exists`, así que se puede aplicar sobre una
base que ya tenga las tablas: las borra y las recrea.

Verificar antes de dar nada por bueno:

```sql
SELECT COUNT(*) FROM "Sale";
SELECT COUNT(*) FROM "Product";
SELECT MAX("createdAt") FROM "Sale";   -- ¿hasta cuándo llega?
```

## Lo que hay que tener en cuenta

**El respaldo es la base entera.** Contiene precios, costos, clientes, sueldos y
las cuentas del personal. Cualquiera con acceso al repositorio puede bajarlo. Si
el día de mañana entra gente al repo que no debería ver eso, hay que mover los
respaldos a un lugar con su propio control de acceso.

**Los artefactos se borran solos a los 90 días.** Para tener historia más larga
—cierres de ejercicio, por ejemplo— hay que bajar uno por mes y guardarlo aparte.
Nadie va a hacerlo solo.

**Si el job falla, hay que enterarse.** GitHub manda mail al dueño del repo
cuando un workflow programado falla. Vale la pena confirmar que ese mail llega a
alguien que lo lea, porque un respaldo que dejó de correr hace tres semanas es
exactamente igual a no tener respaldo.

## Prueba de restauración

Al menos una vez, y después cada tantos meses: bajar un respaldo, restaurarlo en
una branch nueva, y contar las filas. Es media hora y es la única forma de saber
que esto funciona **antes** de necesitarlo.
