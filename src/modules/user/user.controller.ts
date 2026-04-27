import { Response, Request } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";

const VALID_ROLES = ["ADMIN", "ENCARGADO", "EMPLOYEE"] as const;
type ManagedRole = (typeof VALID_ROLES)[number];

const roleDescriptions: Record<ManagedRole, string> = {
  ADMIN:
    "Control total del ERP/POS, usuarios, sucursales, reportes consolidados y configuracion.",
  ENCARGADO:
    "Gestion operativa de caja, stock, gastos, clientes, compras y ventas en sucursales asignadas.",
  EMPLOYEE:
    "Venta, consulta de stock y operaciones basicas dentro de sus sucursales asignadas.",
};

const isManagedRole = (role: string): role is ManagedRole =>
  VALID_ROLES.includes(role as ManagedRole);

const normalizeRole = (role: unknown): ManagedRole | null => {
  const value = String(role || "").trim().toUpperCase();
  return isManagedRole(value) ? value : null;
};

const validateAdminSecret = (adminSecret: unknown) => {
  const requiredSecret = process.env.ADMIN_ONBOARD_SECRET?.trim();
  if (!requiredSecret) {
    return {
      ok: false,
      error:
        "ADMIN_ONBOARD_SECRET no esta configurado. No se pueden crear ni promover administradores de forma segura.",
    };
  }

  if (String(adminSecret || "") !== requiredSecret) {
    return {
      ok: false,
      error: "La llave maestra para administradores no es valida.",
    };
  }

  return { ok: true, error: null };
};

const countAdmins = () =>
  prisma.user.count({
    where: { role: "ADMIN" },
  });

const toJsonPayload = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const auditUserAdminAction = async (
  actorUserId: number | undefined,
  action: string,
  entityId: string,
  metadata: Record<string, unknown>,
) => {
  if (!actorUserId) return;

  await prisma.auditLog.create({
    data: {
      actorUserId,
      action,
      entityType: "User",
      entityId,
      metadata: toJsonPayload(metadata),
    },
  });
};

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

export const retrieveRoleCatalog = async (_req: AuthRequest, res: Response) => {
  try {
    const groupedUsers = await prisma.user.groupBy({
      by: ["role"],
      _count: { role: true },
    });
    const counts = groupedUsers.reduce<Record<string, number>>((acc, item) => {
      acc[item.role] = item._count.role;
      return acc;
    }, {});

    res.status(200).json({
      roles: VALID_ROLES.map((role) => ({
        key: role,
        label:
          role === "ADMIN"
            ? "Administrador"
            : role === "ENCARGADO"
              ? "Encargado"
              : "Empleado",
        description: roleDescriptions[role],
        immutable: role === "ADMIN",
        usersCount: counts[role] || 0,
        canDeleteUsers: role !== "ADMIN",
      })),
    });
  } catch (error) {
    console.error("Error al recuperar catalogo de roles:", error);
    res.status(500).json({ error: "Fallo al obtener los roles del sistema." });
  }
};

export const onboardEmployee = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const { name, email, password, role, branchIds, adminSecret } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res
        .status(400)
        .json({ error: "El correo electronico ya pertenece a un empleado." });
    }

    const normalizedRole = normalizeRole(role || "EMPLOYEE");
    if (!normalizedRole) {
      return res.status(400).json({ error: "El rol indicado no es valido." });
    }

    if (normalizedRole === "ADMIN") {
      const adminSecretValidation = validateAdminSecret(adminSecret);
      if (!adminSecretValidation.ok) {
        return res.status(403).json({
          error: adminSecretValidation.error,
        });
      }
    }

    if (normalizedRole !== "ADMIN" && adminSecret) {
      return res.status(403).json({
        error: "La llave maestra solo se utiliza para altas de administradores.",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: normalizedRole,
        branches:
          branchIds && branchIds.length > 0
            ? { connect: branchIds.map((id: number) => ({ id })) }
            : undefined,
      },
      select: { id: true, name: true, email: true, role: true, branches: true },
    });

    await auditUserAdminAction(authUser?.id, "user.created", String(newUser.id), {
      email: newUser.email,
      role: newUser.role,
      branchIds: newUser.branches.map((branch) => branch.id),
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
    const { name, email, role, branchIds, adminSecret } = req.body;
    const authUser = getAuthUser(req);
    const targetUserId = Number(id);
    const normalizedRole = normalizeRole(role);

    if (!normalizedRole) {
      return res.status(400).json({ error: "El rol indicado no es valido." });
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, role: true },
    });

    if (!targetUser) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }

    if (targetUser.role !== "ADMIN" && normalizedRole === "ADMIN") {
      const adminSecretValidation = validateAdminSecret(adminSecret);
      if (!adminSecretValidation.ok) {
        return res.status(403).json({
          error: adminSecretValidation.error,
        });
      }
    }

    if (targetUser.role === "ADMIN" && normalizedRole !== "ADMIN") {
      const adminCount = await countAdmins();
      const authUser = getAuthUser(req);

      if (adminCount <= 1 || authUser?.id === targetUserId) {
        return res.status(409).json({
          error:
            "No se puede quitar el rol ADMIN a este usuario porque protege el acceso maestro del sistema.",
        });
      }
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        email,
        id: { not: targetUserId },
      },
    });

    if (existingUser) {
      return res.status(400).json({
        error: "El correo electronico ingresado ya pertenece a otro empleado.",
      });
    }

    const updatedEmployee = await prisma.user.update({
      where: { id: targetUserId },
      data: {
        name,
        email,
        role: normalizedRole,
        branches: {
          set: (branchIds || []).map((branchId: number) => ({ id: branchId })),
        },
      },
      select: { id: true, name: true, email: true, role: true, branches: true },
    });

    await auditUserAdminAction(authUser?.id, "user.updated", String(updatedEmployee.id), {
      email: updatedEmployee.email,
      previousRole: targetUser.role,
      newRole: updatedEmployee.role,
      branchIds: updatedEmployee.branches.map((branch) => branch.id),
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
    const authUser = getAuthUser(req);

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: Number(id) },
      data: { password: hashedPassword },
    });

    await auditUserAdminAction(authUser?.id, "user.password_reset", String(id), {
      targetUserId: Number(id),
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

    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, role: true },
    });

    if (!targetUser) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }

    if (targetUser.role === "ADMIN") {
      return res.status(409).json({
        error:
          "El rol ADMIN es inmutable: no se puede eliminar un usuario administrador desde esta accion.",
      });
    }

    await prisma.user.delete({ where: { id: targetUserId } });

    await auditUserAdminAction(authUser?.id, "user.deleted", String(targetUserId), {
      previousRole: targetUser.role,
    });

    res.status(200).json({ message: "Empleado desvinculado y accesos revocados." });
  } catch (error) {
    console.error("Error al desvincular empleado:", error);
    res.status(400).json({
      error:
        "No se puede eliminar un empleado con historial de ventas o cajas (restriccion fiscal).",
    });
  }
};

export const deleteUsersByRole = async (req: AuthRequest, res: Response) => {
  try {
    const role = normalizeRole(req.params.role);
    const { confirmationPhrase } = req.body || {};

    if (!role) {
      return res.status(400).json({ error: "El rol indicado no es valido." });
    }

    if (role === "ADMIN") {
      return res.status(409).json({
        error: "El rol ADMIN no puede ser eliminado ni limpiado masivamente.",
      });
    }

    const requiredPhrase = `ELIMINAR ROL ${role}`;
    if (confirmationPhrase !== requiredPhrase) {
      return res.status(400).json({
        error: `Confirmacion requerida: envie la frase exacta ${requiredPhrase}.`,
      });
    }

    const result = await prisma.user.deleteMany({
      where: { role },
    });

    const authUser = getAuthUser(req);
    await auditUserAdminAction(authUser?.id, "role.users_deleted", role, {
      role,
      deletedCount: result.count,
    });

    res.status(200).json({
      message: `Usuarios con rol ${role} eliminados correctamente.`,
      deletedCount: result.count,
    });
  } catch (error) {
    console.error("Error al limpiar usuarios por rol:", error);
    res.status(409).json({
      error:
        "No se pueden eliminar usuarios con historial operativo. Revise ventas, cajas, pagos, gastos o movimientos asociados.",
    });
  }
};

export const deleteAllOperationalRoleUsers = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const { confirmationPhrase } = req.body || {};
    const requiredPhrase = "ELIMINAR ROLES OPERATIVOS";

    if (confirmationPhrase !== requiredPhrase) {
      return res.status(400).json({
        error: `Confirmacion requerida: envie la frase exacta ${requiredPhrase}.`,
      });
    }

    const result = await prisma.user.deleteMany({
      where: { role: { in: ["ENCARGADO", "EMPLOYEE"] } },
    });

    const authUser = getAuthUser(req);
    await auditUserAdminAction(authUser?.id, "role.operational_users_deleted", "OPERATIONAL", {
      roles: ["ENCARGADO", "EMPLOYEE"],
      deletedCount: result.count,
    });

    res.status(200).json({
      message:
        "Usuarios operativos eliminados correctamente. El rol ADMIN permanece intacto.",
      deletedCount: result.count,
    });
  } catch (error) {
    console.error("Error al limpiar roles operativos:", error);
    res.status(409).json({
      error:
        "No se pueden eliminar masivamente usuarios con historial operativo. Elimine solo perfiles sin trazabilidad o conserve el historial.",
    });
  }
};
