import request from "supertest";
import app from "../src/app";
import prisma from "../src/config/db";
import bcrypt from "bcrypt";
import { generateTestToken } from "./helpers/auth";

describe("Módulo de Seguridad y Autenticación (Auth API)", () => {
  // Credenciales del Admin de Prueba
  const adminCreds = {
    email: "robot_admin@elclub.com",
    password: "supersecretpassword",
  };

  let adminToken = "";
  let adminUserId = 0;

  // ANTES DE EMPEZAR: Inyectamos un ADMIN directamente a la base de datos por la puerta trasera
  beforeAll(async () => {
    // Limpiamos por si quedó basura de una prueba anterior
    await prisma.user.deleteMany({ where: { email: adminCreds.email } });

    // Creamos al usuario esquivando la ruta /register
    const hashedPassword = await bcrypt.hash(adminCreds.password, 10);
    const admin = await prisma.user.create({
      data: {
        name: "Robot Admin",
        email: adminCreds.email,
        password: hashedPassword,
        role: "ADMIN",
      },
    });
    adminUserId = admin.id;

    // Pre-generate the token for tests that need an authenticated session
    adminToken = generateTestToken({ userId: adminUserId, role: "ADMIN", branchIds: [] });
  });

  // DESPUÉS DE TERMINAR: Limpiamos la base de datos y cerramos la conexión
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: adminCreds.email } });
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------
  // PRUEBA 1: Login Exitoso
  // ---------------------------------------------------------
  it("Debería iniciar sesión y establecer cookie de sesión (Status 200)", async () => {
    const response = await request(app)
      .post("/api/users/login")
      .send(adminCreds);

    expect(response.status).toBe(200);
    // Auth now uses HttpOnly cookies — no token in body
    expect(response.headers["set-cookie"]).toBeDefined();
    expect(response.body).toHaveProperty("user");
  });

  // ---------------------------------------------------------
  // PRUEBA 2: Defensa contra intrusos
  // ---------------------------------------------------------
  it("Debería rechazar el inicio de sesión con contraseña incorrecta (Status 401)", async () => {
    const response = await request(app).post("/api/users/login").send({
      email: adminCreds.email,
      password: "clave_equivocada",
    });

    expect(response.status).toBe(401);
  });

  // ---------------------------------------------------------
  // PRUEBA 3: Acceso a la Bóveda con la Llave (Token)
  // ---------------------------------------------------------
  it("Debería permitir el acceso al Dashboard usando el Token válido (Status 200)", async () => {
    const response = await request(app)
      .get("/api/dashboard/finance")
      .set("Authorization", `Bearer ${adminToken}`); // El robot envía la llave en el header

    expect(response.status).toBe(200);
  });

  // ---------------------------------------------------------
  // PRUEBA 4: Defensa del Dashboard
  // ---------------------------------------------------------
  it("Debería bloquear el acceso al Dashboard si no se envía un Token (Status 401/403)", async () => {
    const response = await request(app).get("/api/dashboard/finance");
    expect([401, 403]).toContain(response.status);
  });
});
