import { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import prisma from "../../config/db";

export const getUsers = async (req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        // Traemos la lista de sucursales conectadas
        branches: {
          select: { id: true, name: true },
        },
        createdAt: true,
        updatedAt: true,
      },
    });

    res.status(200).json(users);
  } catch (error) {
    console.error("Error al buscar los usuarios:", error);
    res
      .status(500)
      .json({ error: "Hubo un problema al obtener los usuarios." });
  }
};

export const registerUser = async (req: Request, res: Response) => {
  try {
    const { name, email, password, role, branchIds, adminSecret } = req.body;

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return res.status(400).json({
        error:
          "El correo electrónico ingresado ya pertenece a un usuario registrado.",
      });
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const newUser = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: role || "EMPLOYEE",
        // Vinculación relacional M:N a través de Prisma
        branches:
          branchIds && branchIds.length > 0
            ? { connect: branchIds.map((id: number) => ({ id })) }
            : undefined,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        branches: { select: { id: true, name: true } },
        createdAt: true,
      },
    });

    res.status(201).json(newUser);
  } catch (error) {
    console.error("Error al registrar el usuario:", error);
    res.status(500).json({
      error: "Hubo un problema al registrar el usuario en el sistema.",
    });
  }
};

export const loginUser = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "Los campos email y password son obligatorios para el ingreso.",
      });
    }

    // Buscamos al usuario incluyendo sus sucursales asignadas
    const user = await prisma.user.findUnique({
      where: { email },
      include: { branches: true },
    });

    if (!user) {
      return res.status(401).json({ error: "Credenciales inválidas." });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({ error: "Credenciales inválidas." });
    }

    if (!process.env.JWT_SECRET) {
      throw new Error("Clave de firma JWT_SECRET no configurada.");
    }

    // Mapeamos los IDs de las sucursales para inyectarlos en el Token
    const userBranchIds = user.branches.map((b) => b.id);

    const token = jwt.sign(
      {
        id: user.id,
        role: user.role,
        branchIds: userBranchIds, // Ahora es un arreglo de IDs
      },
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
      .json({ error: "Hubo un problema al procesar el inicio de sesión." });
  }
};

export const deleteUser = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.user.delete({ where: { id: Number(id) } });
    res
      .status(200)
      .json({ message: "Usuario eliminado correctamente del sistema." });
  } catch (error) {
    console.error("Error al eliminar el usuario:", error);
    res.status(500).json({ error: "No se pudo eliminar el usuario." });
  }
};
