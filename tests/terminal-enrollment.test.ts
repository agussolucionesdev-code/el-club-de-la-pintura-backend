/**
 * Enrolamiento de terminal: la computadora PRUEBA quién es.
 *
 * Sin esto, un `terminalId` en el cuerpo del request es una afirmación sin
 * respaldo: cualquiera con sesión válida puede atribuirle sus ventas a otra
 * caja. Con incentivos por vendedor de por medio, eso es plata.
 */

import request from "supertest";
import bcrypt from "bcrypt";

import app from "../src/app";
import prisma from "../src/config/db";
import { generateTestToken } from "./helpers/auth";
import {
  parseDeviceCookieValue,
  TERMINAL_COOKIE,
  terminalCookieOptions,
} from "../src/utils/terminalDevice.utils";

describe("Enrolamiento de terminal", () => {
  const runId = Date.now();
  const emailAdmin = `robot_enr_admin_${runId}@elclub.com`;
  const emailEmpleado = `robot_enr_emp_${runId}@elclub.com`;

  let adminToken = "";
  let empleadoToken = "";
  let adminId = 0;
  let empleadoId = 0;
  let branchId = 0;
  let otraSucursalId = 0;
  let terminalId = 0;
  let terminalAjenaId = 0;

  beforeAll(async () => {
    const [branch, otra] = await Promise.all([
      prisma.branch.create({ data: { name: `Sucursal Enrol ${runId}`, location: "A" } }),
      prisma.branch.create({ data: { name: `Sucursal Enrol B ${runId}`, location: "B" } }),
    ]);
    branchId = branch.id;
    otraSucursalId = otra.id;

    const password = await bcrypt.hash("supersecretpassword", 10);
    const [admin, empleado] = await Promise.all([
      prisma.user.create({
        data: {
          name: `Admin Enrol ${runId}`,
          email: emailAdmin,
          password,
          role: "ADMIN",
          branches: { connect: [{ id: branchId }] },
        },
      }),
      prisma.user.create({
        data: {
          name: `Empleado Enrol ${runId}`,
          email: emailEmpleado,
          password,
          role: "EMPLOYEE",
          branches: { connect: [{ id: branchId }] },
        },
      }),
    ]);
    adminId = admin.id;
    empleadoId = empleado.id;

    const [t, ajena] = await Promise.all([
      prisma.terminal.create({
        data: { code: `ENR-${runId}`, name: "Caja mostrador", branchId },
      }),
      prisma.terminal.create({
        data: { code: `ENR-AJENA-${runId}`, name: "Caja ajena", branchId: otraSucursalId },
      }),
    ]);
    terminalId = t.id;
    terminalAjenaId = ajena.id;

    adminToken = generateTestToken({ userId: adminId, role: "ADMIN", branchIds: [branchId] });
    empleadoToken = generateTestToken({
      userId: empleadoId,
      role: "EMPLOYEE",
      branchIds: [branchId],
    });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { branchId: { in: [branchId, otraSucursalId] } } });
    await prisma.terminalEnrollment.deleteMany({
      where: { terminalId: { in: [terminalId, terminalAjenaId] } },
    });
    await prisma.cashRegister.deleteMany({
      where: { branchId: { in: [branchId, otraSucursalId] } },
    });
    // Desde la Fase 5, cualquier request de POS resuelve el contexto de
    // operador y puede crear una sesión atada a la terminal. Esa fila tiene FK
    // RESTRICT —a propósito: borrar una terminal no debe borrar el registro de
    // quién operó en ella— así que hay que limpiarla antes.
    await prisma.posOperatorSession.deleteMany({
      where: { terminalId: { in: [terminalId, terminalAjenaId] } },
    });
    await prisma.terminal.deleteMany({ where: { id: { in: [terminalId, terminalAjenaId] } } });
    await prisma.user.deleteMany({ where: { email: { in: [emailAdmin, emailEmpleado] } } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchId, otraSucursalId] } } });
    await prisma.$disconnect();
  });

  const emitirToken = (id = terminalId, token = adminToken) =>
    request(app)
      .post(`/api/terminals/${id}/enrollment`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

  const enrolar = (enrollToken: string, token = adminToken) =>
    request(app)
      .post("/api/terminals/enroll")
      .set("Authorization", `Bearer ${token}`)
      .send({ token: enrollToken });

  /** Extrae el valor de la cookie de terminal de la respuesta. */
  const cookieDe = (res: request.Response): string | null => {
    const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
    if (!raw) return null;
    const found = raw.find((c) => c.startsWith(`${TERMINAL_COOKIE}=`));
    return found ? found.split(";")[0]!.split("=").slice(1).join("=") : null;
  };

  // ── El token ─────────────────────────────────────────────────────────────

  it("el token se devuelve UNA sola vez y en la base queda hasheado", async () => {
    const res = await emitirToken();
    expect(res.status).toBe(201);
    expect(res.body.data.token).toBeTruthy();

    const enBase = await prisma.terminalEnrollment.findFirst({
      where: { terminalId, consumedAt: null },
    });
    // Ni un volcado de la base permite enrolar una máquina ajena.
    expect(enBase?.tokenHash).not.toBe(res.body.data.token);
    expect(enBase?.tokenHash).toHaveLength(64); // sha256 hex
  });

  it("emitir un token nuevo invalida el anterior", async () => {
    const primero = (await emitirToken()).body.data.token;
    const segundo = (await emitirToken()).body.data.token;

    // No pueden quedar invitaciones sueltas dando vueltas.
    expect((await enrolar(primero)).status).toBe(400);
    expect((await enrolar(segundo)).status).toBe(200);
  });

  it("sólo un ADMIN puede emitir tokens", async () => {
    const res = await emitirToken(terminalId, empleadoToken);
    expect(res.status).toBe(403);
  });

  // ── El canje ─────────────────────────────────────────────────────────────

  it("canjear el token deja la cookie de dispositivo con los flags correctos", async () => {
    const token = (await emitirToken()).body.data.token;
    const res = await enrolar(token);

    expect(res.status).toBe(200);

    const setCookie = (res.headers["set-cookie"] as unknown as string[]).find((c) =>
      c.startsWith(`${TERMINAL_COOKIE}=`),
    )!;

    // El secreto NUNCA accesible por JavaScript: un XSS no puede robarlo.
    expect(setCookie).toMatch(/HttpOnly/iu);
    // Acotada a la API.
    expect(setCookie).toMatch(/Path=\/api/iu);

    const valor = cookieDe(res)!;
    const parsed = parseDeviceCookieValue(decodeURIComponent(valor));
    expect(parsed?.terminalId).toBe(terminalId);
    expect(parsed?.version).toBeGreaterThan(0);
  });

  it("el mismo token no se puede usar dos veces", async () => {
    const token = (await emitirToken()).body.data.token;
    expect((await enrolar(token)).status).toBe(200);
    expect((await enrolar(token)).status).toBe(400);
  });

  it("un token inventado se rechaza con el MISMO mensaje que uno usado", async () => {
    const inventado = await enrolar("A".repeat(32));
    const token = (await emitirToken()).body.data.token;
    await enrolar(token);
    const usado = await enrolar(token);

    expect(inventado.status).toBe(400);
    expect(usado.status).toBe(400);
    // Distinguirlos le diría a quien prueba tokens al azar cuál acertó.
    expect(inventado.body.error).toBe(usado.body.error);
  });

  it("un token vencido se rechaza", async () => {
    const token = (await emitirToken()).body.data.token;
    await prisma.terminalEnrollment.updateMany({
      where: { terminalId, consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await enrolar(token)).status).toBe(400);
  });

  it("no se puede enrolar una terminal de otra sucursal", async () => {
    const token = (await emitirToken(terminalAjenaId)).body.data.token;
    // El admin de este test sólo tiene acceso a `branchId`… pero es ADMIN, que
    // ve todo. Se prueba con el empleado, que sí está acotado.
    const res = await enrolar(token, empleadoToken);
    expect(res.status).toBe(403);
  });

  // ── La credencial en uso ─────────────────────────────────────────────────

  it("con la cookie, /terminals/me dice qué terminal es esta computadora", async () => {
    const token = (await emitirToken()).body.data.token;
    const cookie = cookieDe(await enrolar(token))!;

    const res = await request(app)
      .get("/api/terminals/me")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Cookie", `${TERMINAL_COOKIE}=${cookie}`);

    expect(res.body.enrolled).toBe(true);
    expect(res.body.data.id).toBe(terminalId);
  });

  it("sin cookie, la computadora no es ninguna terminal", async () => {
    const res = await request(app)
      .get("/api/terminals/me")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.body.enrolled).toBe(false);
    expect(res.body.data).toBeNull();
  });

  it("una cookie ADULTERADA no vale: el secreto se compara contra su hash", async () => {
    const token = (await emitirToken()).body.data.token;
    const cookie = decodeURIComponent(cookieDe(await enrolar(token))!);
    const parsed = parseDeviceCookieValue(cookie)!;

    // Mismo id y versión, secreto inventado.
    const falsa = `${parsed.terminalId}.${parsed.version}.secreto-inventado`;
    const res = await request(app)
      .get("/api/terminals/me")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Cookie", `${TERMINAL_COOKIE}=${falsa}`);

    expect(res.body.enrolled).toBe(false);
  });

  it("revocar corta el acceso SIN depender de que el navegador borre nada", async () => {
    const token = (await emitirToken()).body.data.token;
    const cookie = cookieDe(await enrolar(token))!;

    // La credencial funciona…
    const antes = await request(app)
      .get("/api/terminals/me")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Cookie", `${TERMINAL_COOKIE}=${cookie}`);
    expect(antes.body.enrolled).toBe(true);

    await request(app)
      .post(`/api/terminals/${terminalId}/revoke`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});

    // …y deja de funcionar con la MISMA cookie: es lo que hace falta cuando
    // una máquina se pierde o se roba.
    const despues = await request(app)
      .get("/api/terminals/me")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Cookie", `${TERMINAL_COOKIE}=${cookie}`);
    expect(despues.body.enrolled).toBe(false);
  });

  it("re-enrolar invalida la credencial vieja", async () => {
    const cookieVieja = cookieDe(await enrolar((await emitirToken()).body.data.token))!;
    const cookieNueva = cookieDe(await enrolar((await emitirToken()).body.data.token))!;

    expect(cookieVieja).not.toBe(cookieNueva);

    const conVieja = await request(app)
      .get("/api/terminals/me")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Cookie", `${TERMINAL_COOKIE}=${cookieVieja}`);
    expect(conVieja.body.enrolled).toBe(false);
  });

  it("una terminal DESACTIVADA invalida su credencial aunque sea correcta", async () => {
    const cookie = cookieDe(await enrolar((await emitirToken()).body.data.token))!;

    await prisma.terminal.update({ where: { id: terminalId }, data: { status: "INACTIVE" } });

    const res = await request(app)
      .get("/api/terminals/me")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Cookie", `${TERMINAL_COOKIE}=${cookie}`);
    expect(res.body.enrolled).toBe(false);

    await prisma.terminal.update({ where: { id: terminalId }, data: { status: "ACTIVE" } });
  });

  // ── La credencial manda sobre el cuerpo ──────────────────────────────────

  it("la cookie GANA: un terminalId distinto en el cuerpo se rechaza", async () => {
    const cookie = cookieDe(await enrolar((await emitirToken()).body.data.token))!;

    const res = await request(app)
      .post("/api/cash-registers/open")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Cookie", `${TERMINAL_COOKIE}=${cookie}`)
      // Se declara OTRA terminal: es exactamente el ataque que esto frena.
      .send({ branchId, initialBalance: 1000, terminalId: terminalAjenaId });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/terminal distinta|otra sucursal/iu);
  });

  it("con la cookie no hace falta declarar la terminal: el turno la toma de ahí", async () => {
    await prisma.cashRegister.deleteMany({ where: { branchId } });
    const cookie = cookieDe(await enrolar((await emitirToken()).body.data.token))!;

    const res = await request(app)
      .post("/api/cash-registers/open")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Cookie", `${TERMINAL_COOKIE}=${cookie}`)
      .send({ branchId, initialBalance: 1000 });

    expect(res.status).toBe(201);
    const turno = await prisma.cashRegister.findUniqueOrThrow({
      where: { id: res.body.data.id },
    });
    expect(turno.terminalId).toBe(terminalId);
  });

  // ── Dual-write en la venta ───────────────────────────────────────────────

  describe("la venta guarda su terminal", () => {
    let productId = 0;
    let cashRegisterId = 0;

    beforeAll(async () => {
      const producto = await prisma.product.create({
        data: {
          sku: `ENR-PROD-${runId}`,
          name: `Producto Enrol ${runId}`,
          brand: "Robot",
          category: "Pruebas",
          costPrice: 200,
          retailPrice: 500,
        },
      });
      productId = producto.id;
      await prisma.stock.create({
        data: { productId, branchId, quantity: 500, minStock: 0 },
      });
    });

    afterAll(async () => {
      // Las ventas dejan `Movement` y `SaleItem` colgando del producto: hay que
      // borrarlos ANTES que el producto, o la FK lo impide.
      const ventas = await prisma.sale.findMany({
        where: { branchId },
        select: { id: true },
      });
      const ventaIds = ventas.map((v) => v.id);

      await prisma.internalReceipt.deleteMany({ where: { branchId } });
      await prisma.payment.deleteMany({ where: { saleId: { in: ventaIds } } });
      await prisma.saleItem.deleteMany({ where: { saleId: { in: ventaIds } } });
      await prisma.sale.deleteMany({ where: { id: { in: ventaIds } } });
      await prisma.movement.deleteMany({ where: { productId } });
      await prisma.stock.deleteMany({ where: { productId } });
      await prisma.product.deleteMany({ where: { id: productId } });
    });

    const abrirCaja = async (cookie?: string) => {
      await prisma.cashRegister.deleteMany({ where: { branchId } });
      const req = request(app)
        .post("/api/cash-registers/open")
        .set("Authorization", `Bearer ${adminToken}`);
      if (cookie) req.set("Cookie", `${TERMINAL_COOKIE}=${cookie}`);
      const res = await req.send({
        branchId,
        initialBalance: 5000,
        ...(cookie ? {} : { terminalId }),
      });
      cashRegisterId = res.body.data.id;
      return res;
    };

    const vender = (cookie?: string, extra: object = {}) => {
      const req = request(app)
        .post("/api/sales")
        .set("Authorization", `Bearer ${adminToken}`);
      if (cookie) req.set("Cookie", `${TERMINAL_COOKIE}=${cookie}`);
      return req.send({
        branchId,
        cashRegisterId,
        paymentMethod: "CASH",
        totalAmount: 500,
        items: [{ productId, quantity: 1 }],
        ...extra,
      });
    };

    it("con la credencial, la venta queda atribuida a esa terminal", async () => {
      const cookie = cookieDe(await enrolar((await emitirToken()).body.data.token))!;
      await abrirCaja(cookie);

      const res = await vender(cookie);
      expect(res.status).toBe(201);

      const venta = await prisma.sale.findUniqueOrThrow({ where: { id: res.body.data.id } });
      expect(venta.terminalId).toBe(terminalId);
    });

    it("declarar OTRA terminal con la credencial puesta se rechaza", async () => {
      const cookie = cookieDe(await enrolar((await emitirToken()).body.data.token))!;
      await abrirCaja(cookie);

      const res = await vender(cookie, { terminalId: terminalAjenaId });

      // Atribuir una venta a la caja equivocada es justo lo que esto impide.
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("TERMINAL_MISMATCH");
    });

    it("una sucursal SIN terminales vende igual, con terminalId en null", async () => {
      // Semántica de la fase de dual-write: la columna es nullable a propósito.
      // En un mostrador no se puede dejar de vender porque falte una fila de
      // configuración; lo que no se tolera es la incoherencia, no la ausencia.
      const sucursalSinTerminal = await prisma.branch.create({
        data: { name: `Sin Terminal ${runId}`, location: "x" },
      });
      const tokenSuc = generateTestToken({
        userId: adminId,
        role: "ADMIN",
        branchIds: [sucursalSinTerminal.id],
      });

      await prisma.stock.create({
        data: { productId, branchId: sucursalSinTerminal.id, quantity: 100, minStock: 0 },
      });
      const caja = await request(app)
        .post("/api/cash-registers/open")
        .set("Authorization", `Bearer ${tokenSuc}`)
        .send({ branchId: sucursalSinTerminal.id, initialBalance: 1000 });
      // La caja SÍ exige terminal: abrir un turno es una decisión deliberada.
      expect(caja.status).toBe(400);

      await prisma.stock.deleteMany({ where: { branchId: sucursalSinTerminal.id } });
      await prisma.branch.delete({ where: { id: sucursalSinTerminal.id } });
    });
  });

  // ── Configuración de la cookie, consciente del despliegue ────────────────

  describe("opciones de la cookie", () => {
    /**
     * `process.env` convierte TODO a string: asignarle `undefined` deja el
     * string literal `"undefined"`, no una variable ausente. Para simular que
     * la variable no está hay que BORRAR la clave.
     */
    const conEntorno = (env: Record<string, string | undefined>, fn: () => void) => {
      const previo = { ...process.env };
      for (const [clave, valor] of Object.entries(env)) {
        if (valor === undefined) delete process.env[clave];
        else process.env[clave] = valor;
      }
      try {
        fn();
      } finally {
        process.env = previo;
      }
    };

    it("en producción usa SameSite=None + Secure — la topología es cross-origin", () => {
      conEntorno({ NODE_ENV: "production", COOKIE_SAME_SITE: undefined }, () => {
        const opts = terminalCookieOptions();
        // Con Lax la cookie NO viaja de Vercel a Render: el enrolamiento andaría
        // en local y fallaría en el mostrador.
        expect(opts.sameSite).toBe("none");
        expect(opts.secure).toBe(true);
        expect(opts.httpOnly).toBe(true);
      });
    });

    it("SameSite=None fuerza Secure aunque no sea producción", () => {
      conEntorno({ NODE_ENV: "development", COOKIE_SAME_SITE: "none" }, () => {
        const opts = terminalCookieOptions();
        // El navegador rechaza la cookie sin esto.
        expect(opts.secure).toBe(true);
      });
    });

    it("en desarrollo usa Lax, que alcanza porque todo es same-site", () => {
      conEntorno({ NODE_ENV: "development", COOKIE_SAME_SITE: undefined }, () => {
        expect(terminalCookieOptions().sameSite).toBe("lax");
      });
    });
  });
});
