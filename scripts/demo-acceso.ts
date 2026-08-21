/**
 * Datos para mirar la pantalla de acceso con los ojos, no sólo con tests.
 *
 * Deja una caja enrolada y tres personas en los tres estados que la pantalla
 * tiene que saber distinguir: con código, bloqueada por intentos fallidos, y
 * sin código configurado.
 *
 *   npx ts-node scripts/demo-acceso.ts            crea
 *   npx ts-node scripts/demo-acceso.ts --limpiar  borra y no crea nada
 *
 * ── Por qué el --limpiar no es opcional ─────────────────────────────────────
 *
 * Estos usuarios quedan en la base de tests, y ya pasó dos veces que datos de
 * demo abandonados rompieran otra suite: un EMPLOYEE que sobrevive entre
 * corridas hace fallar los tests de borrado masivo de roles. Se limpia siempre
 * al terminar de mirar.
 *
 * ── Y por qué se niega a correr contra producción ───────────────────────────
 *
 * Porque crea y borra usuarios. Un `DATABASE_URL` mal puesto acá no es un
 * inconveniente, es un incidente.
 */
import { randomBytes } from "crypto";

import bcrypt from "bcrypt";

import prisma from "../src/config/db";
import { hashPin } from "../src/utils/posPin.utils";
import { sha256 } from "../src/utils/terminalDevice.utils";

const MARCA = "DEMO-ACCESO";
const CORREO = "demoacceso";
const SUCURSAL = "893 y 851 (demo)";

const url = process.env.DATABASE_URL ?? "";
if (!/_test/u.test(url)) {
  console.error(
    "\n  ⛔ DATABASE_URL no apunta a una base cuyo nombre termine en _test.\n" +
      "     Este script crea y borra usuarios: no corre contra otra cosa.\n",
  );
  process.exit(1);
}

const limpiar = async () => {
  const gente = await prisma.user.findMany({
    where: { email: { contains: CORREO } },
    select: { id: true },
  });
  const ids = gente.map((persona) => persona.id);

  await prisma.posPinCredential.deleteMany({ where: { userId: { in: ids } } });
  await prisma.posOperatorSession.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.terminalEnrollment.deleteMany({
    where: { terminal: { code: { startsWith: MARCA } } },
  });
  await prisma.terminal.deleteMany({ where: { code: { startsWith: MARCA } } });
  await prisma.branch.deleteMany({ where: { name: SUCURSAL } });

  return ids.length;
};

(async () => {
  const soloLimpiar = process.argv.includes("--limpiar");

  const borrados = await limpiar();

  if (soloLimpiar) {
    console.log(`Limpio. Se quitaron ${borrados} usuarios de demo.`);
    await prisma.$disconnect();
    return;
  }

  const sucursal = await prisma.branch.create({
    data: { name: SUCURSAL, location: "Av. 893 y 851" },
  });

  const password = await bcrypt.hash("demo12345", 10);
  const crear = (name: string, role: string, alias: string) =>
    prisma.user.create({
      data: {
        name,
        email: `${alias}@${CORREO}.test`,
        password,
        role,
        branches: { connect: [{ id: sucursal.id }] },
      },
    });

  const [lucia, martin] = await Promise.all([
    crear("Lucía Cabrera", "ENCARGADO", "lucia"),
    crear("Martín Rossi", "EMPLOYEE", "martin"),
    // Paula queda sin credencial: es el tercer estado de la ficha.
    crear("Paula Duarte", "EMPLOYEE", "paula"),
  ]);

  await prisma.posPinCredential.create({
    data: { userId: lucia.id, pinHash: await hashPin("246813") },
  });
  await prisma.posPinCredential.create({
    data: {
      userId: martin.id,
      pinHash: await hashPin("135791"),
      failedAttempts: 5,
      lockedUntil: new Date(Date.now() + 15 * 60 * 1000),
    },
  });

  const secreto = randomBytes(32).toString("base64url");
  const terminal = await prisma.terminal.create({
    data: {
      code: `${MARCA}-01`,
      name: "Caja del mostrador",
      branchId: sucursal.id,
      deviceSecretHash: sha256(secreto),
      deviceSecretVersion: 1,
    },
  });

  console.log(
    [
      "",
      "  Caja enrolada y gente lista.",
      "",
      `  Credencial de terminal   ${terminal.id}.1.${secreto}`,
      `  Lucía (con código)       id ${lucia.id} · código 246813`,
      `  Martín (bloqueado)       id ${martin.id}`,
      "  Paula (sin código)",
      "",
      "  Al terminar:  npx ts-node scripts/demo-acceso.ts --limpiar",
      "",
    ].join("\n"),
  );

  await prisma.$disconnect();
})();
