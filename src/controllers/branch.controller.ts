import { Request, Response } from "express";
import prisma from "../config/db";

// Función principal para obtener el listado de sucursales
// Se realiza una consulta a la base de datos y se retorna la información en formato JSON
export const getBranches = async (req: Request, res: Response) => {
  try {
    // Se solicitan todos los registros de la tabla Branch
    const branches = await prisma.branch.findMany();

    // Se responde con un código HTTP 200 (Éxito) y los datos obtenidos
    res.status(200).json(branches);
  } catch (error) {
    console.error("Error al buscar las sucursales:", error);
    res
      .status(500)
      .json({ error: "Hubo un problema al obtener las sucursales." });
  }
};
