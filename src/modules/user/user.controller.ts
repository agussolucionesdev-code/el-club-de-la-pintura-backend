import { Request, Response } from "express";
import bcrypt from "bcrypt";
import prisma from "../../config/db";

// Obtención del listado de usuarios del sistema
// Ejecución de consulta a la base de datos con exclusión selectiva de campos sensibles (contraseñas)
export const getUsers = async (req: Request, res: Response) => {
  try {
    // Solicitud de registros omitiendo la columna 'password' para garantizar la seguridad del payload
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        branchId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Emisión de respuesta con código HTTP 200 (Éxito)
    res.status(200).json(users);
  } catch (error) {
    console.error("Error al buscar los usuarios:", error);
    res
      .status(500)
      .json({ error: "Hubo un problema al obtener los usuarios." });
  }
};

// Registro de un nuevo usuario en la plataforma
// Validación de datos, encriptación de contraseña (Hashing) y persistencia en base de datos
export const createUser = async (req: Request, res: Response) => {
  try {
    // Extracción de credenciales y datos de perfil desde el cuerpo de la solicitud
    const { name, email, password, role, branchId } = req.body;

    // Validación de campos obligatorios
    if (!name || !email || !password || !branchId) {
      return res.status(400).json({
        error: "Los campos name, email, password y branchId son obligatorios.",
      });
    }

    // Verificación de disponibilidad del correo electrónico
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return res.status(400).json({
        error:
          "El correo electrónico ingresado ya pertenece a un usuario registrado.",
      });
    }

    // Generación de salt y encriptación de la contraseña original mediante algoritmo Bcrypt
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Ejecución de la inserción del usuario con la contraseña encriptada
    const newUser = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: role || "EMPLOYEE", // Asignación de rol por defecto en caso de ausencia
        branchId: Number(branchId),
      },
      // Exclusión de la contraseña en el objeto de retorno mediante selección explícita
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        branchId: true,
        createdAt: true,
      },
    });

    // Emisión de respuesta exitosa con código HTTP 201 (Creado)
    res.status(201).json(newUser);
  } catch (error) {
    console.error("Error al crear el usuario:", error);
    res.status(500).json({
      error: "Hubo un problema al registrar el usuario en el sistema.",
    });
  }
};

// Eliminación de cuenta de usuario
// Remoción física del registro mediante identificación por ID
export const deleteUser = async (req: Request, res: Response) => {
  try {
    // Extracción del parámetro ID de la URL
    const { id } = req.params;

    // Ejecución de eliminación en Prisma
    await prisma.user.delete({
      where: { id: Number(id) },
    });

    // Emisión de estado de confirmación
    res
      .status(200)
      .json({ message: "Usuario eliminado correctamente del sistema." });
  } catch (error) {
    console.error("Error al eliminar el usuario:", error);
    res.status(500).json({
      error: "No se pudo eliminar el usuario. Verifique el ID proporcionado.",
    });
  }
};
