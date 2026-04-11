import { Response, Request } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";

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

    if (!user) {
      return res.status(401).json({ error: "Credenciales invalidas." });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: "Credenciales invalidas." });
    }

    if (!process.env.JWT_SECRET) {
      throw new Error("Clave de firma JWT_SECRET no configurada.");
    }

    const userBranchIds = user.branches.map((branch) => branch.id);
    const token = jwt.sign(
      { id: user.id, role: user.role, branchIds: userBranchIds },
      process.env.JWT_SECRET,
      {
        expiresIn: (process.env.JWT_EXPIRES_IN ||
          "24h") as jwt.SignOptions["expiresIn"],
      },
    );

    res.status(200).json({
      message: "Inicio de sesion exitoso.",
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
    console.error("Error en autenticacion:", error);
    res
      .status(500)
      .json({ error: "Fallo estructural al procesar el inicio de sesion." });
  }
};

export const getCurrentUserProfile = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        branches: { select: { id: true, name: true, location: true } },
      },
    });

    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }

    res.status(200).json({ data: user });
  } catch (error) {
    console.error("Error al recuperar el perfil actual:", error);
    res.status(500).json({ error: "Fallo al recuperar la sesion actual." });
  }
};

export const retrieveWorkforceDirectory = async (
  req: AuthRequest,
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
    res.status(500).json({ error: "Fallo al obtener la nomina de empleados." });
  }
};

export const onboardEmployee = async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, password, role, branchIds, adminSecret } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res
        .status(400)
        .json({ error: "El correo electronico ya pertenece a un empleado." });
    }

    if (
      role === "ADMIN" &&
      process.env.ADMIN_ONBOARD_SECRET &&
      adminSecret !== process.env.ADMIN_ONBOARD_SECRET
    ) {
      return res.status(403).json({
        error: "La llave maestra para crear administradores no es valida.",
      });
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
      .json({ message: "Empleado dado de alta con exito.", employee: newUser });
  } catch (error) {
    console.error("Error al registrar empleado:", error);
    res
      .status(500)
      .json({ error: "Fallo estructural en el modulo de contrataciones." });
  }
};

export const modifyEmployeeProfile = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const { id } = req.params;
    const { name, email, role, branchIds } = req.body;

    const existingUser = await prisma.user.findFirst({
      where: {
        email,
        id: { not: Number(id) },
      },
    });

    if (existingUser) {
      return res.status(400).json({
        error: "El correo electronico ingresado ya pertenece a otro empleado.",
      });
    }

    const updatedEmployee = await prisma.user.update({
      where: { id: Number(id) },
      data: {
        name,
        email,
        role,
        branches: {
          set: (branchIds || []).map((branchId: number) => ({ id: branchId })),
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

export const resetEmployeePassword = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: Number(id) },
      data: { password: hashedPassword },
    });

    res.status(200).json({
      message: "La contrasena del empleado ha sido reseteada por gerencia.",
    });
  } catch (error) {
    console.error("Error al blanquear clave:", error);
    res.status(500).json({
      error: "Fallo de seguridad al intentar resetear la contrasena.",
    });
  }
};

export const terminateEmployee = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const { id } = req.params;
    const targetUserId = Number(id);

    if (authUser?.id === targetUserId) {
      return res.status(400).json({
        error: "No puedes eliminar tu propio usuario administrador en sesion.",
      });
    }

    await prisma.user.delete({ where: { id: targetUserId } });

    res.status(200).json({ message: "Empleado desvinculado y accesos revocados." });
  } catch (error) {
    console.error("Error al desvincular empleado:", error);
    res.status(400).json({
      error:
        "No se puede eliminar un empleado con historial de ventas o cajas (restriccion fiscal).",
    });
  }
};
