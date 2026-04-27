import "dotenv/config";
import bcrypt from "bcrypt";

import prisma from "../src/config/db";

const DEFAULT_DEV_PASSWORD = "ClubPintura2026!";

const getSeedPassword = () => {
  const configuredPassword = process.env.SEED_DEFAULT_PASSWORD?.trim();
  if (configuredPassword) return configuredPassword;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SEED_DEFAULT_PASSWORD is required before creating default production users.",
    );
  }
  return DEFAULT_DEV_PASSWORD;
};

const ensureBranch = async (name: string, location: string) => {
  const normalizedName = name.trim().replace(/\s+/g, " ");
  const existing = await prisma.branch.findFirst({
    where: { name: { equals: normalizedName, mode: "insensitive" } },
    orderBy: { id: "asc" },
  });
  if (existing) {
    return prisma.branch.update({
      where: { id: existing.id },
      data: { location: existing.location || location },
    });
  }
  return prisma.branch.create({ data: { name: normalizedName, location } });
};

const ensureUser = async ({
  name,
  email,
  role,
  branchIds,
  passwordHash,
}: {
  name: string;
  email: string;
  role: "ADMIN" | "ENCARGADO" | "EMPLOYEE";
  branchIds: number[];
  passwordHash: string;
}) => {
  const branches = branchIds.map((id) => ({ id }));
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (process.env.SEED_OVERWRITE_USERS === "true") {
      return prisma.user.update({
        where: { id: existing.id },
        data: {
          name,
          role,
          branches: { set: branches },
        },
        select: { id: true, email: true, role: true },
      });
    }

    return {
      id: existing.id,
      email: existing.email,
      role: existing.role,
      preserved: true,
    };
  }

  return prisma.user.create({
    data: {
      name,
      email,
      password: passwordHash,
      role,
      branches: { connect: branches },
    },
    select: { id: true, email: true, role: true },
  });
};

const main = async () => {
  const [branchOne, branchTwo] = await Promise.all([
    ensureBranch("Sucursal 1", "Sucursal principal editable"),
    ensureBranch("Sucursal 2", "Sucursal secundaria editable"),
  ]);

  const password = getSeedPassword();
  const passwordHash = await bcrypt.hash(password, 10);

  const seededUsers = await Promise.all([
    ensureUser({
      name: "Administrador General",
      email: "admin@clubpintura.local",
      role: "ADMIN",
      branchIds: [branchOne.id, branchTwo.id],
      passwordHash,
    }),
    ensureUser({
      name: "Encargado Sucursal 1",
      email: "encargado.sucursal1@clubpintura.local",
      role: "ENCARGADO",
      branchIds: [branchOne.id],
      passwordHash,
    }),
    ensureUser({
      name: "Empleado Sucursal 1",
      email: "empleado.sucursal1@clubpintura.local",
      role: "EMPLOYEE",
      branchIds: [branchOne.id],
      passwordHash,
    }),
  ]);

  await prisma.auditLog.create({
    data: {
      action: "SYSTEM_SEED",
      entityType: "OperationalBaseline",
      metadata: {
        branches: [
          { id: branchOne.id, name: branchOne.name },
          { id: branchTwo.id, name: branchTwo.name },
        ],
        users: seededUsers,
        defaultPasswordSource: process.env.SEED_DEFAULT_PASSWORD
          ? "SEED_DEFAULT_PASSWORD"
          : "development-default",
      },
    },
  });

  console.log("Seed completed.");
  console.table([
    { branch: branchOne.name, id: branchOne.id },
    { branch: branchTwo.name, id: branchTwo.id },
  ]);
  console.table(seededUsers);
  if (!process.env.SEED_DEFAULT_PASSWORD && process.env.NODE_ENV !== "production") {
    console.warn(`Development default password: ${DEFAULT_DEV_PASSWORD}`);
  }
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
