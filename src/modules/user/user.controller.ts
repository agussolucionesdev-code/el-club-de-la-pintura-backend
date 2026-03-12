import { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
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

// Autenticación de usuario e inicio de sesión
// Validación de credenciales cruzadas y emisión de token de acceso JWT
export const loginUser = async (req: Request, res: Response) => {
  try {
    // Extracción de credenciales de acceso
    const { email, password } = req.body;

    // Validación de presencia de datos
    if (!email || !password) {
      return res.status(400).json({
        error: "Los campos email y password son obligatorios para el ingreso.",
      });
    }

    // Localización del usuario en el sistema
    const user = await prisma.user.findUnique({
      where: { email },
    });

    // Verificación de existencia (Prevención de enumeración de usuarios)
    if (!user) {
      return res.status(401).json({
        error: "Credenciales inválidas. Verifique su correo o contraseña.",
      });
    }

    // Comparación criptográfica de la contraseña ingresada con el hash almacenado
    const isPasswordValid = await bcrypt.compare(password, user.password);

    // Verificación de coincidencia
    if (!isPasswordValid) {
      return res.status(401).json({
        error: "Credenciales inválidas. Verifique su correo o contraseña.",
      });
    }

    // Verificación de disponibilidad de la llave maestra del servidor
    if (!process.env.JWT_SECRET) {
      throw new Error(
        "Clave de firma JWT_SECRET no configurada en el entorno.",
      );
    }

    // Generación del token de acceso (Payload con datos de autorización)
    // Resolución de tipo estricto para satisfacer las validaciones del compilador TS
    const token = jwt.sign(
      {
        id: user.id,
        role: user.role,
        branchId: user.branchId,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: (process.env.JWT_EXPIRES_IN ||
          "24h") as jwt.SignOptions["expiresIn"],
      },
    );

    // Emisión de respuesta exitosa con token y datos de perfil seguros
    res.status(200).json({
      message: "Inicio de sesión exitoso.",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        branchId: user.branchId,
      },
    });
  } catch (error) {
    console.error("Error en el proceso de autenticación:", error);
    res.status(500).json({
      error: "Hubo un problema al procesar el inicio de sesión.",
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
