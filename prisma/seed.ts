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

// ─────────────────────────────────────────────────────────────────────────────
// BRANCHES
// Handles both fresh installs and existing "Sucursal 1/2" installs.
// ─────────────────────────────────────────────────────────────────────────────
const ensureBranchByNameOrLegacy = async (
  targetName: string,
  legacyName: string,
  location: string,
) => {
  // 1. Try to find by the target name first
  const byTarget = await prisma.branch.findFirst({
    where: { name: { equals: targetName, mode: "insensitive" } },
    orderBy: { id: "asc" },
  });
  if (byTarget) return byTarget;

  // 2. Try to find by legacy name and rename it
  const byLegacy = await prisma.branch.findFirst({
    where: { name: { equals: legacyName, mode: "insensitive" } },
    orderBy: { id: "asc" },
  });
  if (byLegacy) {
    return prisma.branch.update({
      where: { id: byLegacy.id },
      data: { name: targetName, location },
    });
  }

  // 3. Create fresh
  return prisma.branch.create({ data: { name: targetName, location } });
};

// ─────────────────────────────────────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────────────────────────────────────
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
        data: { name, role, branches: { set: branches } },
        select: { id: true, email: true, role: true },
      });
    }
    return { id: existing.id, email: existing.email, role: existing.role, preserved: true };
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

// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIERS
// ─────────────────────────────────────────────────────────────────────────────
const ensureSupplier = async (data: {
  companyName: string;
  cuit?: string;
  contactName?: string;
  phone: string;
  email?: string;
  address?: string;
}) => {
  const existing = await prisma.supplier.findFirst({
    where: { companyName: { equals: data.companyName, mode: "insensitive" } },
  });
  if (existing) return existing;
  return prisma.supplier.create({ data });
};

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTS
// Upsert by SKU — idempotent, safe to re-run.
// ─────────────────────────────────────────────────────────────────────────────
const upsertProduct = async (data: {
  sku: string;
  name: string;
  brand: string;
  category: string;
  description?: string;
  costPrice: number;
  profitMargin: number;
  ivaPercentage: number;
  retailPrice: number;
  color?: string;
  finish?: string;
  volume?: number;
  volumeUnit?: string;
  indoorOutdoor?: boolean;
  supplierId?: number;
}) => {
  return prisma.product.upsert({
    where: { sku: data.sku },
    update: {
      name: data.name,
      brand: data.brand,
      category: data.category,
      retailPrice: data.retailPrice,
      costPrice: data.costPrice,
      supplierId: data.supplierId,
    },
    create: { ...data, images: [], isActive: true },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// STOCK
// Upsert stock for a product+branch pair with given quantity.
// ─────────────────────────────────────────────────────────────────────────────
const upsertStock = async (
  productId: number,
  branchId: number,
  quantity: number,
  minStock = 5,
  criticalStock = 2,
) => {
  return prisma.stock.upsert({
    where: { productId_branchId: { productId, branchId } },
    update: { quantity },
    create: { productId, branchId, quantity, minStock, criticalStock },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCT CATALOGUE — realistic pinturas de Argentina
// ─────────────────────────────────────────────────────────────────────────────
const CATALOGUE = [
  // ALBA
  { sku: "ALB-LAT-001", brand: "Alba", name: "Alba Látex Interior Blanco 10L", category: "Látex Interior", costPrice: 18500, margin: 38, color: "Blanco", volume: 10, unit: "L", finish: "Mate", indoor: true, supplier: "Alba" },
  { sku: "ALB-LAT-002", brand: "Alba", name: "Alba Látex Interior Marfil 4L", category: "Látex Interior", costPrice: 8200, margin: 38, color: "Marfil", volume: 4, unit: "L", finish: "Mate", indoor: true, supplier: "Alba" },
  { sku: "ALB-LAT-003", brand: "Alba", name: "Alba Látex Exterior Blanco 10L", category: "Látex Exterior", costPrice: 21000, margin: 35, color: "Blanco", volume: 10, unit: "L", finish: "Satinado", indoor: false, supplier: "Alba" },
  { sku: "ALB-ESM-001", brand: "Alba", name: "Alba Esmalte Sintético Blanco 1L", category: "Esmalte", costPrice: 5800, margin: 42, color: "Blanco", volume: 1, unit: "L", finish: "Brillante", indoor: true, supplier: "Alba" },
  { sku: "ALB-ESM-002", brand: "Alba", name: "Alba Esmalte Sintético Negro 1L", category: "Esmalte", costPrice: 5800, margin: 42, color: "Negro", volume: 1, unit: "L", finish: "Brillante", indoor: true, supplier: "Alba" },
  { sku: "ALB-IMP-001", brand: "Alba", name: "Alba Impermeabilizante Blanco 10L", category: "Impermeabilizante", costPrice: 26000, margin: 33, color: "Blanco", volume: 10, unit: "L", finish: "Mate", indoor: false, supplier: "Alba" },
  { sku: "ALB-FIJ-001", brand: "Alba", name: "Alba Fijador Concentrado 4L", category: "Fijador", costPrice: 7200, margin: 40, color: undefined, volume: 4, unit: "L", finish: undefined, indoor: true, supplier: "Alba" },

  // SHERWIN WILLIAMS
  { sku: "SHW-LAT-001", brand: "Sherwin Williams", name: "Loxon Látex Exterior Blanco 10L", category: "Látex Exterior", costPrice: 32000, margin: 30, color: "Blanco", volume: 10, unit: "L", finish: "Satinado", indoor: false, supplier: "Sherwin Williams" },
  { sku: "SHW-LAT-002", brand: "Sherwin Williams", name: "Loxon Látex Interior Blanco 4L", category: "Látex Interior", costPrice: 14500, margin: 30, color: "Blanco", volume: 4, unit: "L", finish: "Mate", indoor: true, supplier: "Sherwin Williams" },
  { sku: "SHW-ESM-001", brand: "Sherwin Williams", name: "Loxon Esmalte Gris Tráfico 1L", category: "Esmalte", costPrice: 8400, margin: 35, color: "Gris Tráfico", volume: 1, unit: "L", finish: "Semimate", indoor: true, supplier: "Sherwin Williams" },
  { sku: "SHW-PISO-001", brand: "Sherwin Williams", name: "Pintura para Piso Gris 4L", category: "Pisos", costPrice: 18000, margin: 32, color: "Gris", volume: 4, unit: "L", finish: "Satinado", indoor: false, supplier: "Sherwin Williams" },

  // SINTEPLAST
  { sku: "SIN-LAT-001", brand: "Sinteplast", name: "Revear Látex Interior Blanco 20L", category: "Látex Interior", costPrice: 34000, margin: 36, color: "Blanco", volume: 20, unit: "L", finish: "Mate", indoor: true, supplier: "Sinteplast" },
  { sku: "SIN-LAT-002", brand: "Sinteplast", name: "Revear Látex Interior Crema 10L", category: "Látex Interior", costPrice: 19500, margin: 36, color: "Crema", volume: 10, unit: "L", finish: "Mate", indoor: true, supplier: "Sinteplast" },
  { sku: "SIN-ESM-001", brand: "Sinteplast", name: "Sinteplast Esmalte Blanco Brillante 4L", category: "Esmalte", costPrice: 21500, margin: 38, color: "Blanco", volume: 4, unit: "L", finish: "Brillante", indoor: true, supplier: "Sinteplast" },
  { sku: "SIN-IMP-001", brand: "Sinteplast", name: "Sintemplast Hidróxido Zn Blanco 4L", category: "Fondo Anticorrosivo", costPrice: 14000, margin: 40, color: "Blanco", volume: 4, unit: "L", finish: undefined, indoor: false, supplier: "Sinteplast" },
  { sku: "SIN-BARN-001", brand: "Sinteplast", name: "Barniz para Madera Interior 1L", category: "Barniz", costPrice: 6800, margin: 42, color: undefined, volume: 1, unit: "L", finish: "Brillante", indoor: true, supplier: "Sinteplast" },

  // PETRILAC
  { sku: "PET-LAT-001", brand: "Petrilac", name: "Petrilac Látex Interior Blanco 4L", category: "Látex Interior", costPrice: 7800, margin: 40, color: "Blanco", volume: 4, unit: "L", finish: "Mate", indoor: true, supplier: "Petrilac" },
  { sku: "PET-ESM-001", brand: "Petrilac", name: "Petrilac Esmalte Blanco Satinado 1L", category: "Esmalte", costPrice: 5200, margin: 44, color: "Blanco", volume: 1, unit: "L", finish: "Satinado", indoor: true, supplier: "Petrilac" },
  { sku: "PET-ANT-001", brand: "Petrilac", name: "Petrilac Antióxido Rojo 1L", category: "Fondo Anticorrosivo", costPrice: 6100, margin: 42, color: "Rojo Óxido", volume: 1, unit: "L", finish: undefined, indoor: false, supplier: "Petrilac" },
  { sku: "PET-LAT-002", brand: "Petrilac", name: "Petrilac Látex Exterior Blanco 10L", category: "Látex Exterior", costPrice: 22500, margin: 37, color: "Blanco", volume: 10, unit: "L", finish: "Satinado", indoor: false, supplier: "Petrilac" },

  // COLORÍN
  { sku: "COL-LAT-001", brand: "Colorín", name: "Colorín Látex Interior Blanco 10L", category: "Látex Interior", costPrice: 17800, margin: 38, color: "Blanco", volume: 10, unit: "L", finish: "Mate", indoor: true, supplier: "Colorín" },
  { sku: "COL-LAT-002", brand: "Colorín", name: "Colorín Látex Interior Beige 4L", category: "Látex Interior", costPrice: 8100, margin: 38, color: "Beige", volume: 4, unit: "L", finish: "Mate", indoor: true, supplier: "Colorín" },
  { sku: "COL-ESM-001", brand: "Colorín", name: "Colorín Esmalte Blanco 1L", category: "Esmalte", costPrice: 5500, margin: 42, color: "Blanco", volume: 1, unit: "L", finish: "Brillante", indoor: true, supplier: "Colorín" },
  { sku: "COL-IMP-001", brand: "Colorín", name: "Colorín Impermeabilizante Blanco 4L", category: "Impermeabilizante", costPrice: 12500, margin: 35, color: "Blanco", volume: 4, unit: "L", finish: "Mate", indoor: false, supplier: "Colorín" },
  { sku: "COL-BARN-001", brand: "Colorín", name: "Colorín Barniz Marino Ext. 1L", category: "Barniz", costPrice: 7200, margin: 40, color: undefined, volume: 1, unit: "L", finish: "Brillante", indoor: false, supplier: "Colorín" },
];

// Stock quantities per branch — different so the POS demo shows variety
// [lomasQty, temperleyQty]
const STOCK_MAP: Record<string, [number, number]> = {
  "ALB-LAT-001": [24, 12],
  "ALB-LAT-002": [18, 8],
  "ALB-LAT-003": [10, 15],
  "ALB-ESM-001": [30, 20],
  "ALB-ESM-002": [14, 6],
  "ALB-IMP-001": [8, 4],
  "ALB-FIJ-001": [20, 10],
  "SHW-LAT-001": [6, 9],
  "SHW-LAT-002": [12, 5],
  "SHW-ESM-001": [3, 8],
  "SHW-PISO-001": [5, 0],   // Temperley sin stock — para demo
  "SIN-LAT-001": [4, 11],
  "SIN-LAT-002": [16, 3],
  "SIN-ESM-001": [7, 14],
  "SIN-IMP-001": [9, 0],    // Temperley sin stock
  "SIN-BARN-001": [22, 17],
  "PET-LAT-001": [15, 9],
  "PET-ESM-001": [28, 22],
  "PET-ANT-001": [11, 7],
  "PET-LAT-002": [0, 6],    // Lomas sin stock — para demo
  "COL-LAT-001": [19, 8],
  "COL-LAT-002": [13, 4],
  "COL-ESM-001": [25, 18],
  "COL-IMP-001": [6, 12],
  "COL-BARN-001": [0, 3],   // Lomas sin stock
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
const main = async () => {
  console.log("── Seeding branches…");
  const [branchLomas, branchTemp] = await Promise.all([
    ensureBranchByNameOrLegacy("Lomas de Zamora", "Sucursal 1", "Av. Hipólito Yrigoyen 1234, Lomas de Zamora"),
    ensureBranchByNameOrLegacy("Temperley", "Sucursal 2", "Av. Hipólito Yrigoyen 5678, Temperley"),
  ]);
  console.log(`   ✓ ${branchLomas.name} (id: ${branchLomas.id})`);
  console.log(`   ✓ ${branchTemp.name} (id: ${branchTemp.id})`);

  console.log("── Seeding users…");
  const password = getSeedPassword();
  const passwordHash = await bcrypt.hash(password, 10);

  const seededUsers = await Promise.all([
    ensureUser({
      name: "Administrador General",
      email: "admin@clubpintura.local",
      role: "ADMIN",
      branchIds: [branchLomas.id, branchTemp.id],
      passwordHash,
    }),
    ensureUser({
      name: "Encargado Lomas de Zamora",
      email: "encargado.lomas@clubpintura.local",
      role: "ENCARGADO",
      branchIds: [branchLomas.id],
      passwordHash,
    }),
    ensureUser({
      name: "Encargado Temperley",
      email: "encargado.temperley@clubpintura.local",
      role: "ENCARGADO",
      branchIds: [branchTemp.id],
      passwordHash,
    }),
    ensureUser({
      name: "Empleado Lomas de Zamora",
      email: "empleado.lomas@clubpintura.local",
      role: "EMPLOYEE",
      branchIds: [branchLomas.id],
      passwordHash,
    }),
    ensureUser({
      name: "Empleado Temperley",
      email: "empleado.temperley@clubpintura.local",
      role: "EMPLOYEE",
      branchIds: [branchTemp.id],
      passwordHash,
    }),
  ]);

  console.log("── Seeding suppliers…");
  const supplierMap: Record<string, number> = {};
  const suppliersData = [
    { companyName: "Alba", cuit: "30-50000001-0", contactName: "Martín Rodríguez", phone: "1140001111", email: "ventas@alba.com.ar", address: "Av. Córdoba 1234, CABA" },
    { companyName: "Sherwin Williams", cuit: "30-50000002-0", contactName: "Paula González", phone: "1140002222", email: "ventas@sherwin.com.ar", address: "Av. del Libertador 5678, CABA" },
    { companyName: "Sinteplast", cuit: "30-50000003-0", contactName: "Diego López", phone: "1140003333", email: "ventas@sinteplast.com.ar", address: "Ruta 3 Km 26, La Matanza" },
    { companyName: "Petrilac", cuit: "30-50000004-0", contactName: "Sofía Méndez", phone: "1140004444", email: "ventas@petrilac.com.ar", address: "Av. San Martín 900, Avellaneda" },
    { companyName: "Colorín", cuit: "30-50000005-0", contactName: "Carlos Herrera", phone: "1140005555", email: "ventas@colorin.com.ar", address: "Av. Mitre 750, Quilmes" },
  ];

  for (const s of suppliersData) {
    const supplier = await ensureSupplier(s);
    supplierMap[s.companyName] = supplier.id;
    console.log(`   ✓ ${supplier.companyName}`);
  }

  console.log("── Seeding products…");
  const productIds: Record<string, number> = {};

  for (const item of CATALOGUE) {
    const retailPrice = Math.round(item.costPrice * (1 + item.margin / 100) * 1.21);
    const product = await upsertProduct({
      sku: item.sku,
      name: item.name,
      brand: item.brand,
      category: item.category,
      costPrice: item.costPrice,
      profitMargin: item.margin,
      ivaPercentage: 21,
      retailPrice,
      color: item.color,
      finish: item.finish,
      volume: item.volume,
      volumeUnit: item.unit,
      indoorOutdoor: item.indoor,
      supplierId: supplierMap[item.supplier],
    });
    productIds[item.sku] = product.id;
    console.log(`   ✓ ${item.sku}  →  $${retailPrice.toLocaleString("es-AR")}`);
  }

  console.log("── Seeding stock (Lomas de Zamora + Temperley)…");
  let stockCount = 0;
  for (const [sku, [lomasQty, tempQty]] of Object.entries(STOCK_MAP)) {
    const pid = productIds[sku];
    if (!pid) continue;
    await Promise.all([
      upsertStock(pid, branchLomas.id, lomasQty, 5, 2),
      upsertStock(pid, branchTemp.id, tempQty, 5, 2),
    ]);
    stockCount++;
  }
  console.log(`   ✓ ${stockCount} products × 2 branches = ${stockCount * 2} stock records`);

  await prisma.auditLog.create({
    data: {
      action: "SYSTEM_SEED",
      entityType: "OperationalBaseline",
      metadata: {
        branches: [
          { id: branchLomas.id, name: branchLomas.name },
          { id: branchTemp.id, name: branchTemp.name },
        ],
        productCount: CATALOGUE.length,
        users: seededUsers,
        defaultPasswordSource: process.env.SEED_DEFAULT_PASSWORD
          ? "SEED_DEFAULT_PASSWORD"
          : "development-default",
      },
    },
  });

  console.log("\n✅ Seed completed.\n");
  console.table([
    { branch: branchLomas.name, id: branchLomas.id },
    { branch: branchTemp.name, id: branchTemp.id },
  ]);
  console.table(seededUsers);

  if (!process.env.SEED_DEFAULT_PASSWORD && process.env.NODE_ENV !== "production") {
    console.warn(`\n⚠  Dev password: ${DEFAULT_DEV_PASSWORD}\n`);
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
