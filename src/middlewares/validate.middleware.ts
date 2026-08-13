import { Request, Response, NextFunction } from "express";
import { ZodError, ZodSchema } from "zod";

/**
 * Opciones de validación.
 */
type ValidateOptions = {
  /**
   * Reemplaza `req.body` por el resultado que devolvió Zod.
   *
   * ── Por qué es opt-in y no el comportamiento por defecto ────────────────
   *
   * Hasta ahora este middleware llamaba a `schema.parse(...)` y **descartaba el
   * resultado**. O sea: validaba, pero no aplicaba nada. Consecuencias que
   * estuvieron años en producción sin que nadie las viera:
   *
   *   · Las claves NO declaradas sobrevivían intactas. Por eso el controlador
   *     de ventas podía leer `item.unitCost`, un campo que su schema ni
   *     menciona, y persistir un costo que mandaba el navegador.
   *   · Ningún `.default()` se aplicaba nunca.
   *   · Ninguna coerción (`z.coerce.number()`) se aplicaba nunca: los
   *     controladores reciben el string crudo y lo convierten a mano.
   *
   * Activarlo de golpe en los 26 schemas cambiaría el comportamiento de 15
   * módulos a la vez, y **11 de ellos usan `.default()` o `z.coerce`**. Un
   * controlador que hoy compensa a mano una coerción que no ocurre empezaría a
   * recibir un tipo distinto sin aviso.
   *
   * Por eso se habilita módulo por módulo, después de verificar que su
   * controlador no dependa de ningún campo fuera del schema.
   *
   * Sólo se asigna `body`: en Express 5 `req.query` es un getter de sólo
   * lectura, y además el agujero de seguridad vive en el cuerpo.
   */
  assignParsed?: boolean;
};

// INTERCEPTOR: Request body / query / params validation via Zod schema
export const validate =
  (schema: ZodSchema, options: ValidateOptions = {}) =>
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      }) as { body?: unknown };

      if (options.assignParsed && parsed.body !== undefined) {
        req.body = parsed.body;
      }

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
