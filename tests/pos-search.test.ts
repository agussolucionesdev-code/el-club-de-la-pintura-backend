/**
 * La búsqueda del mostrador.
 *
 * Lo que estos tests protegen, en orden de gravedad:
 *
 *   1. Que un producto que EXISTE se pueda encontrar aunque el catálogo tenga
 *      más productos de los que el POS solía bajarse. Ése era el defecto: con
 *      19.358 productos y un tope de 3.000, buscar uno de los otros 16.358
 *      devolvía artículos EQUIVOCADOS sin decir que no lo había encontrado.
 *   2. Que "latex" encuentre "Látex". Medio catálogo está escrito con tilde y
 *      nadie la tipea en el mostrador.
 *   3. Que "latex blanco" encuentre "Látex Interior Mate Blanco": las palabras
 *      se buscan por separado, no como una frase.
 *   4. Que el texto de quien busca nunca llegue al SQL.
 */
import bcrypt from "bcrypt";
import request from "supertest";

import app from "../src/app";
import prisma from "../src/config/db";
import { generateTestToken } from "./helpers/auth";

const RUTA = "/api/products/pos-search";

describe("Búsqueda del mostrador", () => {
  const runId = Date.now();
  const MARCA = `BUSQ${runId}`;

  let sucursalId = 0;
  let otraSucursalId = 0;
  let token = "";
  let usuarioId = 0;

  /** Los productos que se van a buscar, con su nombre tal cual se escribe. */
  const CATALOGO = [
    { sku: `${MARCA}-0001`, name: "Látex Interior Mate Blanco 20L", brand: "Alba", category: "Látex Interior" },
    { sku: `${MARCA}-0002`, name: "Esmalte Sintético Brillante Negro 1L", brand: "Sinteplast", category: "Esmalte" },
    { sku: `${MARCA}-0003`, name: "Látex Exterior Satinado Beige 4L", brand: "Colorín", category: "Látex Exterior" },
    { sku: `${MARCA}-0004`, name: "Barniz Marino Brillante 1L", brand: "Petrilac", category: "Barniz" },
  ];

  const buscar = (q: string, extra: Record<string, string | number> = {}) =>
    request(app)
      .get(RUTA)
      .set("Authorization", `Bearer ${token}`)
      .query({ q, branchId: sucursalId, ...extra });

  const nombres = (body: { data: { name: string }[] }) => body.data.map((p) => p.name);

  /**
   * Sólo los productos de ESTE test.
   *
   * La base de tests es compartida y tiene catálogo de otras corridas y del
   * seed. Comparar la respuesta completa contra una lista fija hacía fallar
   * tests correctos cada vez que alguien agregaba un producto en otro lado —
   * un test que se rompe solo deja de creerse, y termina ignorándose.
   */
  const mios = (body: { data: { name: string; sku: string }[] }) =>
    body.data.filter((p) => p.sku.startsWith(MARCA)).map((p) => p.name);

  beforeAll(async () => {
    const [sucursal, otra] = await Promise.all([
      prisma.branch.create({ data: { name: `Búsqueda ${runId}`, location: "A" } }),
      prisma.branch.create({ data: { name: `Otra búsqueda ${runId}`, location: "B" } }),
    ]);
    sucursalId = sucursal.id;
    otraSucursalId = otra.id;

    const usuario = await prisma.user.create({
      data: {
        name: `Buscador ${runId}`,
        email: `buscador_${runId}@x.com`,
        password: await bcrypt.hash("supersecretpassword", 10),
        role: "EMPLOYEE",
        branches: { connect: [{ id: sucursalId }] },
      },
    });
    usuarioId = usuario.id;
    token = generateTestToken({
      userId: usuarioId,
      role: "EMPLOYEE",
      branchIds: [sucursalId],
    });

    await prisma.product.createMany({
      data: CATALOGO.map((p, i) => ({
        sku: p.sku,
        barcode: `999${runId}${i}`,
        name: p.name,
        brand: p.brand,
        category: p.category,
        retailPrice: 10_000 + i * 1_000,
        isActive: true,
      })),
    });

    const creados = await prisma.product.findMany({
      where: { sku: { startsWith: MARCA } },
      select: { id: true, sku: true },
    });

    // Stock sólo en la primera sucursal: el POS muestra el de SU caja.
    await prisma.stock.createMany({
      data: creados.map((p) => ({
        productId: p.id,
        branchId: sucursalId,
        quantity: 12,
        minStock: 3,
        criticalStock: 1,
      })),
    });
  });

  afterAll(async () => {
    await prisma.stock.deleteMany({ where: { product: { sku: { startsWith: MARCA } } } });
    await prisma.product.deleteMany({ where: { sku: { startsWith: MARCA } } });
    await prisma.user.deleteMany({ where: { id: usuarioId } });
    await prisma.branch.deleteMany({ where: { id: { in: [sucursalId, otraSucursalId] } } });
    await prisma.$disconnect();
  });

  // ══════════════════════════════════════════════════════════════════════
  // Encontrar lo que existe
  // ══════════════════════════════════════════════════════════════════════

  it("encuentra por SKU exacto", async () => {
    const res = await buscar(`${MARCA}-0002`);

    expect(res.status).toBe(200);
    expect(mios(res.body)).toEqual(["Esmalte Sintético Brillante Negro 1L"]);
  });

  it("el SKU exacto va PRIMERO, aunque otros también coincidan", async () => {
    // Todos los SKU comparten el prefijo, así que buscarlo trae los cuatro.
    const res = await buscar(MARCA);

    expect(res.body.data.length).toBe(4);
    // Y buscando uno completo, ese queda arriba de todo.
    const exacto = await buscar(`${MARCA}-0003`);
    expect(exacto.body.data[0].sku).toBe(`${MARCA}-0003`);
  });

  it("ignora las tildes en los DOS sentidos", async () => {
    // Nadie tipea "Látex" en el mostrador.
    const sinTilde = await buscar("latex interior");
    expect(nombres(sinTilde.body)).toContain("Látex Interior Mate Blanco 20L");

    // Y quien sí las tipea también tiene que encontrarlo.
    const conTilde = await buscar("Látex Interior");
    expect(nombres(conTilde.body)).toContain("Látex Interior Mate Blanco 20L");

    // "sintetico" contra "Sintético".
    const esmalte = await buscar("esmalte sintetico");
    expect(nombres(esmalte.body)).toContain("Esmalte Sintético Brillante Negro 1L");
  });

  it("busca cada palabra por separado, no la frase entera", async () => {
    // Estas dos palabras existen en el nombre pero NO juntas ni en ese orden.
    // Es exactamente lo que el filtro viejo (`contains` de toda la cadena) no
    // podía encontrar.
    const res = await buscar("latex blanco");

    expect(mios(res.body)).toEqual(["Látex Interior Mate Blanco 20L"]);
  });

  it("todas las palabras tienen que estar, no alcanza con una", async () => {
    // "barniz" está; "verde" no está en ningún producto.
    const res = await buscar("barniz verde");

    expect(mios(res.body)).toEqual([]);
  });

  it("encuentra por marca y por categoría", async () => {
    const porMarca = await buscar("petrilac");
    expect(mios(porMarca.body)).toEqual(["Barniz Marino Brillante 1L"]);

    const porCategoria = await buscar("latex exterior");
    expect(mios(porCategoria.body)).toEqual(["Látex Exterior Satinado Beige 4L"]);
  });

  // ══════════════════════════════════════════════════════════════════════
  // El stock es el de ESTA caja
  // ══════════════════════════════════════════════════════════════════════

  it("devuelve el stock de la sucursal pedida", async () => {
    const res = await buscar(`${MARCA}-0001`);

    expect(res.body.data[0].stocks).toEqual([
      { branchId: sucursalId, quantity: 12, minStock: 3, criticalStock: 1 },
    ]);
  });

  it("un producto sin stock en esa sucursal aparece igual, con la lista vacía", async () => {
    // Aparece porque existe y se puede pedir a la otra sucursal; lo que no hace
    // es mentir sobre cuánto hay acá.
    const res = await request(app)
      .get(RUTA)
      .set("Authorization", `Bearer ${token}`)
      .query({ q: `${MARCA}-0001`, branchId: otraSucursalId });

    expect(res.status).toBe(200);
    expect(res.body.data[0].stocks).toEqual([]);
  });

  // ══════════════════════════════════════════════════════════════════════
  // Los bordes
  // ══════════════════════════════════════════════════════════════════════

  it("sin sucursal no responde: el stock siempre es el de una caja concreta", async () => {
    const res = await request(app)
      .get(RUTA)
      .set("Authorization", `Bearer ${token}`)
      .query({ q: "latex" });

    expect(res.status).toBe(400);
  });

  it("una consulta vacía devuelve vacío, NO el catálogo entero", async () => {
    for (const q of ["", "   "]) {
      const res = await buscar(q);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    }
  });

  it("avisa cuando quedaron resultados afuera", async () => {
    const conTope = await buscar(MARCA, { limit: 2 });

    expect(conTope.body.data.length).toBe(2);
    // `truncated` es lo que le permite a la pantalla DECIR que está viendo una
    // parte. Una lista cortada que se ve igual que una completa es de donde
    // salieron casi todos los números equivocados del proyecto.
    expect(conTope.body.metadata.truncated).toBe(true);

    const completo = await buscar(MARCA);
    expect(completo.body.metadata.truncated).toBe(false);
  });

  it("no se puede pedir una página gigante", async () => {
    const res = await buscar(MARCA, { limit: 99_999 });

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(50);
  });

  it("no devuelve productos dados de baja", async () => {
    const baja = await prisma.product.create({
      data: {
        sku: `${MARCA}-BAJA`,
        name: "Látex Discontinuado 20L",
        brand: "Alba",
        category: "Látex Interior",
        retailPrice: 1,
        isActive: false,
      },
    });

    const res = await buscar("discontinuado");
    expect(mios(res.body)).toEqual([]);

    await prisma.product.delete({ where: { id: baja.id } });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Seguridad
  // ══════════════════════════════════════════════════════════════════════

  it("el texto de quien busca nunca llega al SQL", async () => {
    // Si la consulta se concatenara, esto borraría la tabla. Como va
    // parametrizada, es una búsqueda más que no encuentra nada.
    const res = await buscar("'; DROP TABLE \"Product\"; --");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);

    const siguenAhi = await prisma.product.count({ where: { sku: { startsWith: MARCA } } });
    expect(siguenAhi).toBe(CATALOGO.length);
  });

  it("el comodín de LIKE no se puede usar para traer todo", async () => {
    // Un `%` suelto en un `LIKE` traería el catálogo entero si se pasara crudo.
    const res = await buscar("%");

    // El comodín se neutraliza antes de armar el LIKE, así que se busca el
    // carácter `%` literal: no está en ningún nombre.
    expect(mios(res.body)).toEqual([]);
  });

  it("sin sesión no se puede buscar", async () => {
    const res = await request(app).get(RUTA).query({ q: "latex", branchId: sucursalId });

    expect(res.status).toBe(401);
  });
});
