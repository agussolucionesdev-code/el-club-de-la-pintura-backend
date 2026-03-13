import { Request, Response, NextFunction } from "express";
import { ZodError, ZodSchema } from "zod"; // Cambiamos a ZodSchema (El tipo universal)

// Interceptor de Validación Desacoplada
// Evalúa el payload entrante contra un esquema estricto antes de delegar el control al enrutador
export const validateSchema =
  (schema: ZodSchema) => (req: Request, res: Response, next: NextFunction) => {
    try {
      // Ejecución de la validación estructural y de tipos
      schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      });

      // Aprobación y pase a la siguiente capa arquitectónica (Controlador)
      next();
    } catch (error) {
      // Intercepción y formateo de fallos estructurales
      if (error instanceof ZodError) {
        return res.status(400).json({
          error:
            "Aduana rechazada: Fallo en la validación de datos estructurales.",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
      }
      return res
        .status(500)
        .json({ error: "Error interno en el motor de validación estricta." });
    }
  };
