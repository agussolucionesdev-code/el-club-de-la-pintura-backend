/**
 * PIN, sesión de operador y ESCALADA DE PRIVILEGIOS.
 *
 * ── El escenario que estos tests defienden ──────────────────────────────────
 *
 * El dueño abre el navegador de la caja a la mañana y se va a hacer compras.
 * Un empleado atiende toda la tarde en esa misma computadora. Si el sistema
 * autorizara por la cookie de sesión, ese empleado tendría permisos de dueño
 * todo el día — y las ventas se le atribuirían a quien no las hizo.
 *
 * No es un escenario rebuscado: es exactamente cómo funciona un mostrador
 * compartido. Estos tests fijan que no pase.
 */

import bcrypt from "bcrypt";
import request from "supertest";

import app from "../src/app";
import prisma from "../src/config/db";
import { generateTestToken } from "./helpers/auth";
import {
  buildDeviceCookieValue,
  generateDeviceSecret,
  sha256,
  TERMINAL_COOKIE,
} from "../src/utils/terminalDevice.utils";

const PASSWORD = "supersecretpassword";

describe("Sesión de operador del POS", () => {
  const runId = Date.now();
  const emailDueno = `robot_pos_owner_${runId}@elclub.com`;
  const emailEmpleado = `robot_pos_emp_${runId}@elclub.com`;
  const emailAjeno = `robot_pos_out_${runId}@elclub.com`;

  let branchId = 0;
  let otraSucursalId = 0;
  let terminalId = 0;
  let duenoId = 0;
  let empleadoId = 0;
  let ajenoId = 0;
  let duenoToken = "";
  let empleadoToken = "";
  let terminalCookie = "";

  /** Request con la credencial de dispositivo puesta: "estoy en esa caja". */
  const enLaTerminal = (
    metodo: "get" | "post" | "put" | "delete",
    ruta: string,
    token: string,
  ) =>
    request(app)
      [metodo](ruta)
      .set("Authorization", `Bearer ${token}`)
      .set("Cookie", `${TERMINAL_COOKIE}=${terminalCookie}`);

  const definirPin = (token: string, pin: string) =>
    request(app)
      .put("/api/me/pos-pin")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: PASSWORD, pin, pinConfirm: pin });

  const abrirSesion = (token: string, userId: number, pin: string) =>
    enLaTerminal("post", "/api/pos/operator-sessions", token).send({ userId, pin });

  beforeAll(async () => {
    // Sin estas dos variables no se puede ni crear un PIN. Se ponen acá para
    // que la suite no dependa de cómo esté configurada la máquina de nadie.
    process.env.POS_PIN_PEPPER = `pepper-de-tests-${runId}-suficientemente-largo`;
    process.env.POS_PIN_ENC_KEY = Buffer.alloc(32, 11).toString("hex");
    delete process.env.POS_PIN_ENC_KEY_VERSION;

    const [branch, otra] = await Promise.all([
      prisma.branch.create({ data: { name: `Suc POS ${runId}`, location: "A" } }),
      prisma.branch.create({ data: { name: `Suc POS B ${runId}`, location: "B" } }),
    ]);
    branchId = branch.id;
    otraSucursalId = otra.id;

    const password = await bcrypt.hash(PASSWORD, 10);
    const [dueno, empleado, ajeno] = await Promise.all([
      prisma.user.create({
        data: {
          name: `Dueño POS ${runId}`,
          email: emailDueno,
          password,
          role: "ADMIN",
          branches: { connect: [{ id: branchId }] },
        },
      }),
      prisma.user.create({
        data: {
          name: `Empleado POS ${runId}`,
          email: emailEmpleado,
          password,
          role: "EMPLOYEE",
          branches: { connect: [{ id: branchId }] },
        },
      }),
      prisma.user.create({
        data: {
          name: `Ajeno POS ${runId}`,
          email: emailAjeno,
          password,
          role: "EMPLOYEE",
          branches: { connect: [{ id: otraSucursalId }] },
        },
      }),
    ]);
    duenoId = dueno.id;
    empleadoId = empleado.id;
    ajenoId = ajeno.id;

    duenoToken = generateTestToken({ userId: duenoId, role: "ADMIN", branchIds: [branchId] });
    empleadoToken = generateTestToken({
      userId: empleadoId,
      role: "EMPLOYEE",
      branchIds: [branchId],
    });

    // Terminal ya enrolada: se arma la credencial a mano en vez de pasar por el
    // flujo completo, que tiene su propio archivo de tests.
    const secret = generateDeviceSecret();
    const terminal = await prisma.terminal.create({
      data: {
        code: `POSAUTH-${runId}`,
        name: "Caja mostrador",
        branchId,
        deviceSecretHash: sha256(secret),
        deviceSecretVersion: 1,
      },
    });
    terminalId = terminal.id;
    terminalCookie = buildDeviceCookieValue(terminal.id, 1, secret);
  });

  afterAll(async () => {
    const userIds = [duenoId, empleadoId, ajenoId];
    await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.posOperatorSession.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.posPinActivation.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.posPinCredential.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.terminal.deleteMany({ where: { id: terminalId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchId, otraSucursalId] } } });
    await prisma.$disconnect();
  });

  // ══════════════════════════════════════════════════════════════════════
  // MONTAJE DEL ROUTER — regresión
  // ══════════════════════════════════════════════════════════════════════

  describe("🔒 el router de pos-auth no rompe el resto de /api", () => {
    /**
     * Este router se monta en `/api` (no en un prefijo propio) porque su
     * contrato incluye rutas de la raíz. La primera versión usaba
     * `router.use(authenticateToken)`, que corre para TODO lo que entra por
     * `/api` — incluidas las rutas que siguen de largo hacia otros routers.
     *
     * Resultado: el login moría con 401 antes de llegar a su controlador y
     * NADIE podía entrar al sistema. Lo agarraron los tests de los otros
     * módulos; este test lo fija para que no vuelva.
     */
    it("el login sigue funcionando SIN sesión previa", async () => {
      const res = await request(app)
        .post("/api/users/login")
        .send({ email: emailEmpleado, password: PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("user");
    });

    it("una ruta protegida de otro módulo sigue pidiendo sesión", async () => {
      // Y el router nuevo tampoco debilitó nada: sin token sigue siendo 401.
      const res = await request(app).get("/api/products");
      expect(res.status).toBe(401);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // PIN PROPIO
  // ══════════════════════════════════════════════════════════════════════

  describe("configurar el PIN propio", () => {
    it("exige la contraseña de la cuenta", async () => {
      // Sin esto, cualquiera que encuentre una sesión abierta se pone un PIN y
      // opera como el dueño de esa sesión desde ese momento en adelante.
      const res = await request(app)
        .put("/api/me/pos-pin")
        .set("Authorization", `Bearer ${empleadoToken}`)
        .send({ currentPassword: "la-que-no-es", pin: "482913", pinConfirm: "482913" });

      expect(res.status).toBe(401);
      const guardado = await prisma.posPinCredential.findUnique({
        where: { userId: empleadoId },
      });
      expect(guardado).toBeNull();
    });

    it("rechaza un PIN que no sean 6 dígitos y uno obvio", async () => {
      const corto = await definirPin(empleadoToken, "12345");
      expect(corto.status).toBe(400);

      const obvio = await definirPin(empleadoToken, "123456");
      expect(obvio.status).toBe(400);
      expect(JSON.stringify(obvio.body)).toMatch(/probaría cualquiera/u);
    });

    it("rechaza cuando la confirmación no coincide", async () => {
      const res = await request(app)
        .put("/api/me/pos-pin")
        .set("Authorization", `Bearer ${empleadoToken}`)
        .send({ currentPassword: PASSWORD, pin: "482913", pinConfirm: "482914" });

      expect(res.status).toBe(400);
    });

    it("lo guarda hasheado con Argon2id, no en claro", async () => {
      const res = await definirPin(empleadoToken, "482913");
      expect(res.status).toBe(200);

      const guardado = await prisma.posPinCredential.findUnique({
        where: { userId: empleadoId },
      });
      expect(guardado?.pinHash.startsWith("$argon2id$")).toBe(true);
      // Y el cifrado del autorrevelado no contiene el PIN a la vista.
      expect(Buffer.from(guardado!.pinCipher!).toString("hex")).not.toContain("482913");
    });

    it("el estado nunca devuelve el PIN, ni cifrado", async () => {
      const res = await request(app)
        .get("/api/me/pos-pin")
        .set("Authorization", `Bearer ${empleadoToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.configured).toBe(true);
      const cuerpo = JSON.stringify(res.body);
      expect(cuerpo).not.toContain("482913");
      expect(cuerpo).not.toContain("pinHash");
      expect(cuerpo).not.toContain("pinCipher");
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // AUTORREVELADO
  // ══════════════════════════════════════════════════════════════════════

  describe("ver el PIN", () => {
    it("🔒 devuelve SÓLO el propio, y con la contraseña", async () => {
      const res = await request(app)
        .post("/api/me/pos-pin/reveal")
        .set("Authorization", `Bearer ${empleadoToken}`)
        .send({ currentPassword: PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.data.pin).toBe("482913");
    });

    it("la respuesta no se puede cachear en ningún lado", async () => {
      const res = await request(app)
        .post("/api/me/pos-pin/reveal")
        .set("Authorization", `Bearer ${empleadoToken}`)
        .send({ currentPassword: PASSWORD });

      expect(res.headers["cache-control"]).toMatch(/no-store/u);
      expect(res.headers["pragma"]).toBe("no-cache");
    });

    it("con la contraseña incorrecta no revela nada", async () => {
      const res = await request(app)
        .post("/api/me/pos-pin/reveal")
        .set("Authorization", `Bearer ${empleadoToken}`)
        .send({ currentPassword: "la-que-no-es" });

      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain("482913");
    });

    it("🔒 NO EXISTE forma de ver el PIN ajeno — tampoco para el dueño", async () => {
      // Se prueban todas las formas plausibles de pedirlo. Ninguna puede
      // devolver un PIN que no sea el de quien pregunta.
      const intentos = await Promise.all([
        request(app)
          .get(`/api/users/${empleadoId}/pos-pin`)
          .set("Authorization", `Bearer ${duenoToken}`),
        request(app)
          .post(`/api/users/${empleadoId}/pos-pin/reveal`)
          .set("Authorization", `Bearer ${duenoToken}`)
          .send({ currentPassword: PASSWORD }),
        request(app)
          .get(`/api/me/pos-pin?userId=${empleadoId}`)
          .set("Authorization", `Bearer ${duenoToken}`),
      ]);

      for (const res of intentos) {
        expect(res.body?.data?.pin).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toContain("482913");
      }
    });

    it("la auditoría registra el HECHO, nunca el valor", async () => {
      const registros = await prisma.auditLog.findMany({
        where: { actorUserId: empleadoId, action: "POS_PIN_REVEALED" },
      });

      expect(registros.length).toBeGreaterThan(0);
      expect(JSON.stringify(registros)).not.toContain("482913");
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // RESTABLECER EL DE OTRO
  // ══════════════════════════════════════════════════════════════════════

  describe("restablecer el PIN de otra persona", () => {
    let credencial = "";

    it("🔒 el encargado recibe una CREDENCIAL, no un PIN", async () => {
      const res = await request(app)
        .post(`/api/users/${empleadoId}/pos-pin/reset`)
        .set("Authorization", `Bearer ${duenoToken}`)
        .send({ reason: "Se lo olvidó" });

      expect(res.status).toBe(201);
      credencial = res.body.data.activationCredential;

      // No es un PIN: no tiene 6 dígitos y no sirve para entrar a ninguna caja.
      expect(credencial).not.toMatch(/^\d{6}$/u);
      expect(credencial.length).toBeGreaterThan(20);
      expect(JSON.stringify(res.body)).not.toContain("482913");
    });

    it("el PIN viejo deja de servir en el acto", async () => {
      const res = await abrirSesion(duenoToken, empleadoId, "482913");
      expect(res.status).toBe(401);
    });

    it("en la base queda hasheada, no en claro", async () => {
      const enBase = await prisma.posPinActivation.findFirst({
        where: { userId: empleadoId, consumedAt: null },
      });
      expect(enBase?.codeHash).not.toBe(credencial);
      expect(enBase?.codeHash).toHaveLength(64);
    });

    it("se canjea por un PIN elegido por su dueño", async () => {
      const res = await request(app)
        .post("/api/pos-pin/activate")
        .send({ activationCredential: credencial, pin: "739502", pinConfirm: "739502" });

      expect(res.status).toBe(200);
    });

    it("no se puede usar dos veces", async () => {
      const res = await request(app)
        .post("/api/pos-pin/activate")
        .send({ activationCredential: credencial, pin: "111333", pinConfirm: "111333" });

      expect(res.status).toBe(400);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // CAMBIO DE OPERADOR (F10)
  // ══════════════════════════════════════════════════════════════════════

  describe("abrir sesión de operador", () => {
    it("sin terminal enrolada no se puede operar", async () => {
      const res = await request(app)
        .post("/api/pos/operator-sessions")
        .set("Authorization", `Bearer ${empleadoToken}`)
        .send({ userId: empleadoId, pin: "739502" });

      expect(res.status).toBe(428);
      expect(res.body.code).toBe("TERMINAL_NOT_ENROLLED");
    });

    it("con el PIN correcto abre la sesión y dice quién opera", async () => {
      const res = await abrirSesion(empleadoToken, empleadoId, "739502");

      expect(res.status).toBe(201);
      expect(res.body.data.operator.id).toBe(empleadoId);
      expect(res.body.data.session.origin).toBe("PIN");
      expect(res.body.data.terminal.id).toBe(terminalId);
    });

    it("un usuario de OTRA sucursal no puede operar esta caja", async () => {
      const res = await abrirSesion(duenoToken, ajenoId, "739502");
      expect(res.status).toBe(401);
    });

    it("la base impide DOS sesiones activas en la misma terminal", async () => {
      await abrirSesion(duenoToken, empleadoId, "739502");

      const activas = await prisma.posOperatorSession.count({
        where: { terminalId, status: "ACTIVE" },
      });
      // El índice único parcial es lo que lo garantiza, no el código.
      expect(activas).toBe(1);
    });

    it("un PIN equivocado no abre nada y suma un fallo", async () => {
      const antes = await prisma.posPinCredential.findUnique({
        where: { userId: empleadoId },
      });

      const res = await abrirSesion(duenoToken, empleadoId, "000001");
      expect(res.status).toBe(401);

      const despues = await prisma.posPinCredential.findUnique({
        where: { userId: empleadoId },
      });
      expect(despues!.failedAttempts).toBe((antes?.failedAttempts ?? 0) + 1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // ESCALADA DE PRIVILEGIOS — el corazón del asunto
  // ══════════════════════════════════════════════════════════════════════

  describe("🔒 escalada de privilegios", () => {
    beforeAll(async () => {
      // Se limpia el castigo de los tests anteriores para poder abrir sesión.
      await prisma.posPinCredential.update({
        where: { userId: empleadoId },
        data: { failedAttempts: 0, lockedUntil: null },
      });
    });

    it("un empleado en la terminal del DUEÑO no hereda capacidades de dueño", async () => {
      // El token es el del DUEÑO (ADMIN): es su navegador el que está abierto.
      // Pero quien se identifica con el PIN es el EMPLEADO.
      const abierta = await abrirSesion(duenoToken, empleadoId, "739502");
      expect(abierta.status).toBe(201);

      const caps: string[] = abierta.body.data.capabilities;

      // Las de empleado, sí.
      expect(caps).toContain("pos:sell");
      // Las de dueño, NUNCA — aunque el token del request sea de un ADMIN.
      expect(caps).not.toContain("users:manage");
      expect(caps).not.toContain("products:manage");
      expect(caps).not.toContain("sale:cancel");
      expect(caps).not.toContain("price:override");
    });

    it("deja registrado que el operador NO es el dueño del token", async () => {
      const res = await enLaTerminal("get", "/api/pos/operator-sessions/current", duenoToken);

      expect(res.body.data.operator.id).toBe(empleadoId);
      // Nadie se esconde detrás del PIN de otro: se ve que la sesión de cuenta
      // es de otra persona.
      expect(res.body.data.authenticatedActor?.id).toBe(duenoId);

      const sesion = await prisma.posOperatorSession.findFirst({
        where: { terminalId, status: "ACTIVE" },
      });
      expect(sesion?.userId).toBe(empleadoId);
      expect(sesion?.authenticatedActorId).toBe(duenoId);
    });

    it("una sesión de PIN NO habilita acciones administrativas", async () => {
      // El empleado está identificado en la caja y el navegador es del dueño.
      // Aun así, crear usuarios exige cuenta completa: se autoriza por el rol
      // del token, y el empleado no puede usar el suyo para esto.
      const res = await request(app)
        .post("/api/users")
        .set("Authorization", `Bearer ${empleadoToken}`)
        .set("Cookie", `${TERMINAL_COOKIE}=${terminalCookie}`)
        .send({
          name: "Colado",
          email: `colado_${runId}@elclub.com`,
          password: "otracontrasenalarga",
          role: "ADMIN",
          branchIds: [branchId],
        });

      expect(res.status).toBe(403);
      const colado = await prisma.user.findUnique({
        where: { email: `colado_${runId}@elclub.com` },
      });
      expect(colado).toBeNull();
    });

    it("un empleado no puede restablecer el PIN de nadie", async () => {
      const res = await request(app)
        .post(`/api/users/${duenoId}/pos-pin/reset`)
        .set("Authorization", `Bearer ${empleadoToken}`)
        .set("Cookie", `${TERMINAL_COOKIE}=${terminalCookie}`)
        .send({ reason: "porque sí" });

      expect(res.status).toBe(403);
    });

    it("ni siquiera el DUEÑO recibe capacidades de administración por el PIN", async () => {
      await prisma.posPinCredential
        .delete({ where: { userId: duenoId } })
        .catch(() => undefined);
      await definirPin(duenoToken, "846201");

      const res = await abrirSesion(duenoToken, duenoId, "846201");
      expect(res.status).toBe(201);

      const caps: string[] = res.body.data.capabilities;
      // El dueño SÍ puede anular ventas y forzar precios desde la caja.
      expect(caps).toContain("sale:cancel");
      expect(caps).toContain("price:override");
      // Pero administrar usuarios exige su contraseña, no seis dígitos que
      // tipea a la vista de quien esté al lado.
      expect(caps).not.toContain("users:manage");
      expect(caps).not.toContain("terminals:manage");
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // DEJAR LA CAJA
  // ══════════════════════════════════════════════════════════════════════

  describe("cerrar la sesión de operador", () => {
    it("la caja queda sin operador y pide identificarse de nuevo", async () => {
      const cerrada = await enLaTerminal(
        "post",
        "/api/pos/operator-sessions/current/close",
        duenoToken,
      ).send({});
      expect(cerrada.status).toBe(200);

      const activas = await prisma.posOperatorSession.count({
        where: { terminalId, status: "ACTIVE" },
      });
      expect(activas).toBe(0);
    });

    it("deshabilitar el PIN propio cierra las cajas donde uno estaba", async () => {
      await abrirSesion(empleadoToken, empleadoId, "739502");

      const res = await request(app)
        .delete("/api/me/pos-pin")
        .set("Authorization", `Bearer ${empleadoToken}`)
        .send({ currentPassword: PASSWORD });

      expect(res.status).toBe(200);

      const activas = await prisma.posOperatorSession.count({
        where: { userId: empleadoId, status: "ACTIVE" },
      });
      // Si no se cerraran, la caja seguiría operando con una credencial que su
      // dueño acaba de dar de baja.
      expect(activas).toBe(0);
    });
  });
});
