import { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import prisma from "../../config/db";

// ============================================================================
// AUTHENTICATE: Motor de inicio de sesión y emisión de Tokens
// ============================================================================
export const authenticateUser = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ error: "Credenciales incompletas para el ingreso." });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { branches: true },
    });

    if (!user)
      return res.status(401).json({ error: "Credenciales inválidas." });

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid)
      return res.status(401).json({ error: "Credenciales inválidas." });

    if (!process.env.JWT_SECRET)
      throw new Error("Clave de firma JWT_SECRET no configurada.");

    const userBranchIds = user.branches.map((b) => b.id);
    const token = jwt.sign(
      { id: user.id, role: user.role, branchIds: userBranchIds },
      process.env.JWT_SECRET,
      {
        expiresIn: (process.env.JWT_EXPIRES_IN ||
          "24h") as jwt.SignOptions["expiresIn"],
      },
    );

    res.status(200).json({
      message: "Inicio de sesión exitoso.",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        branches: user.branches,
      },
    });
  } catch (error) {
    console.error("Error en autenticación:", error);
    res
      .status(500)
      .json({ error: "Fallo estructural al procesar el inicio de sesión." });
  }
};

// ============================================================================
// RETRIEVE WORKFORCE: Obtener el directorio completo del personal
// ============================================================================
export const retrieveWorkforceDirectory = async (
  req: Request,
  res: Response,
) => {
  try {
    const workforce = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        branches: { select: { id: true, name: true } },
        createdAt: true,
      },
      orderBy: { role: "asc" },
    });

    res.status(200).json(workforce);
  } catch (error) {
    console.error("Error al recuperar el directorio:", error);
    res.status(500).json({ error: "Fallo al obtener la nómina de empleados." });
  }
};

// ============================================================================
// ONBOARD EMPLOYEE: Contratar y dar de alta a un nuevo usuario
// ============================================================================
export const onboardEmployee = async (req: Request, res: Response) => {
  try {
    const { name, email, password, role, branchIds } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res
        .status(400)
        .json({ error: "El correo electrónico ya pertenece a un empleado." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: role || "EMPLOYEE",
        branches:
          branchIds && branchIds.length > 0
            ? { connect: branchIds.map((id: number) => ({ id })) }
            : undefined,
      },
      select: { id: true, name: true, email: true, role: true, branches: true },
    });

    res
      .status(201)
      .json({ message: "Empleado dado de alta con éxito.", employee: newUser });
  } catch (error) {
    console.error("Error al registrar empleado:", error);
    res
      .status(500)
      .json({ error: "Fallo estructural en el módulo de contrataciones." });
  }
};

// ============================================================================
// MODIFY EMPLOYEE PROFILE: Traslados de sucursal o ascensos
// ============================================================================
export const modifyEmployeeProfile = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, email, role, branchIds } = req.body;

    const updatedEmployee = await prisma.user.update({
      where: { id: Number(id) },
      data: {
        name,
        email,
        role,
        // 'set' borra las sucursales viejas y vincula únicamente las nuevas
        branches: {
          set: branchIds.map((branchId: number) => ({ id: branchId })),
        },
      },
      select: { id: true, name: true, email: true, role: true, branches: true },
    });

    res.status(200).json({
      message: "Perfil operativo actualizado correctamente.",
      employee: updatedEmployee,
    });
  } catch (error) {
    console.error("Error al modificar empleado:", error);
    res
      .status(500)
      .json({ error: "Fallo al actualizar el perfil del empleado." });
  }
};

// ============================================================================
// RESET PASSWORD: Blanqueo de clave por parte de Gerencia
// ============================================================================
export const resetEmployeePassword = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: Number(id) },
      data: { password: hashedPassword },
    });

    res.status(200).json({
      message: "La contraseña del empleado ha sido reseteada por Gerencia.",
    });
  } catch (error) {
    console.error("Error al blanquear clave:", error);
    res.status(500).json({
      error: "Fallo de seguridad al intentar resetear la contraseña.",
    });
  }
};

// ============================================================================
// TERMINATE EMPLOYEE: Desvincular usuario del sistema
// ============================================================================
export const terminateEmployee = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Nota Técnica: Si el usuario tiene ventas registradas, Prisma bloqueará el borrado por seguridad fiscal.
    await prisma.user.delete({ where: { id: Number(id) } });

    res
      .status(200)
      .json({ message: "Empleado desvinculado y accesos revocados." });
  } catch (error: any) {
    console.error("Error al desvincular empleado:", error);
    res.status(400).json({
      error:
        "No se puede eliminar un empleado con historial de ventas o cajas (Restricción Fiscal).",
    });
  }
};
