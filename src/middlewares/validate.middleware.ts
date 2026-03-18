import { Request, Response, NextFunction } from "express";
import { ZodError, ZodSchema } from "zod";

// INTERCEPTOR: Validación de datos de entrada
export const validate =
  (schema: ZodSchema) => (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          error: "Fallo en la validación de datos.",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
      }
      return res
        .status(500)
        .json({ error: "Error interno en el motor de validación." });
    }
  };
