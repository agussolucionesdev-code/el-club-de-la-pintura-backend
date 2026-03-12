import { Request, Response } from "express";
import prisma from "../../config/db";

// Obtención del listado de sucursales
// Consulta a la base de datos y retorno de registros en formato JSON
export const getBranches = async (req: Request, res: Response) => {
  try {
    // Solicitud de todos los registros de la tabla Branch
    const branches = await prisma.branch.findMany();

    // Emisión de respuesta con código HTTP 200 (Éxito)
    res.status(200).json(branches);
  } catch (error) {
    console.error("Error al buscar las sucursales:", error);
    res
      .status(500)
      .json({ error: "Hubo un problema al obtener las sucursales." });
  }
};

// Creación de una nueva sucursal
// Recepción, validación y persistencia de datos en la base de datos
export const createBranch = async (req: Request, res: Response) => {
  try {
    // Extracción de campos desde el cuerpo de la solicitud
    const { name, location } = req.body;

    // Validación de campos obligatorios
    if (!name) {
      return res.status(400).json({ error: "El campo 'name' es requerido." });
    }

    // Ejecución de la inserción mediante Prisma
    const newBranch = await prisma.branch.create({
      data: {
        name,
        location,
      },
    });

    // Emisión de respuesta exitosa con código HTTP 201 (Creado)
    res.status(201).json(newBranch);
  } catch (error) {
    console.error("Error al crear la sucursal:", error);
    res.status(500).json({ error: "Hubo un problema al crear la sucursal." });
  }
};

// Actualización de una sucursal existente
// Identificación del registro por ID y modificación de campos específicos
export const updateBranch = async (req: Request, res: Response) => {
  try {
    // Extracción del parámetro ID y de los datos del cuerpo
    const { id } = req.params;
    const { name, location } = req.body;

    // Ejecución de la actualización en la base de datos
    const updatedBranch = await prisma.branch.update({
      where: { id: Number(id) },
      data: { name, location },
    });

    // Emisión de respuesta con los datos actualizados
    res.status(200).json(updatedBranch);
  } catch (error) {
    console.error("Error al actualizar la sucursal:", error);
    res
      .status(500)
      .json({ error: "No se pudo actualizar la sucursal. Verifique el ID." });
  }
};

// Eliminación de una sucursal
// Remoción física del registro de la base de datos mediante su identificador
export const deleteBranch = async (req: Request, res: Response) => {
  try {
    // Extracción del parámetro ID de la solicitud
    const { id } = req.params;

    // Ejecución de la eliminación en la base de datos
    await prisma.branch.delete({
      where: { id: Number(id) },
    });

    // Emisión de confirmación de eliminación exitosa
    res.status(200).json({ message: "Sucursal eliminada correctamente." });
  } catch (error) {
    console.error("Error al eliminar la sucursal:", error);
    res
      .status(500)
      .json({ error: "No se pudo eliminar la sucursal. Verifique el ID." });
  }
};
