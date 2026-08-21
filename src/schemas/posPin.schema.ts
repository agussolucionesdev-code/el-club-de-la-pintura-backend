import { z } from "zod";

/**
 * Seis dígitos exactos.
 *
 * No es alfanumérico a propósito: se tipea en el mostrador, con una mano, sin
 * mirar el teclado y sin sacar la otra del mouse. Cualquier cosa más larga o
 * más compleja termina anotada en un papel pegado al monitor — que es
 * exactamente el agujero que este mecanismo viene a cerrar.
 *
 * La contracara de que sea corto es que su ALCANCE también lo es: un PIN
 * habilita vender y cobrar, nunca administrar (ver `capabilities.ts`).
 */
const pin = z
  .string()
  .trim()
  .regex(/^\d{6}$/u, "El PIN tiene que ser de exactamente 6 dígitos.");

/**
 * La contraseña de la cuenta, para reautenticar.
 *
 * Sin mínimo ni máximo de forma: acá no se está creando una contraseña, se está
 * verificando una que ya existe. Validar su forma sólo le diría a quien prueba
 * a ciegas cuáles descartar.
 */
const currentPassword = z.string().min(1, "Ingresá tu contraseña para continuar.");

/**
 * PIN demasiado obvio.
 *
 * Se rechazan las secuencias y los repetidos porque son el primer puñado que
 * prueba cualquiera que mire de reojo. No es una política de complejidad
 * completa —sobre 10⁶ combinaciones no aportaría mucho más— pero saca de la
 * mesa los que se adivinan al segundo intento.
 */
const PIN_OBVIOS = new Set([
  "000000", "111111", "222222", "333333", "444444",
  "555555", "666666", "777777", "888888", "999999",
  "123456", "654321", "012345", "543210", "123123",
  "121212", "112233", "abcdef",
]);

const pinSeguro = pin.refine((valor) => !PIN_OBVIOS.has(valor), {
  message:
    "Ese PIN es de los primeros que probaría cualquiera. Elegí otro que no sea " +
    "una secuencia ni el mismo dígito repetido.",
});

/** Los dos campos tienen que coincidir: un PIN mal tipeado deja a alguien afuera. */
const COINCIDEN = {
  message: "Los dos PIN no coinciden.",
  path: ["pinConfirm"],
};

export const setPosPinSchema = z.object({
  body: z
    .object({ currentPassword, pin: pinSeguro, pinConfirm: z.string() })
    .refine((datos) => datos.pin === datos.pinConfirm, COINCIDEN),
});

export const revealPosPinSchema = z.object({
  body: z.object({ currentPassword }),
});

export const activatePosPinSchema = z.object({
  body: z
    .object({
      // La credencial de activación se genera con `randomBytes(18)` en
      // base64url → 24 caracteres. NO tiene forma de PIN a propósito: quien la
      // recibe no puede confundirla ni usarla para entrar directamente.
      activationCredential: z
        .string()
        .trim()
        .min(16, "La credencial de activación es demasiado corta.")
        .max(128, "La credencial de activación es demasiado larga.")
        .regex(/^[A-Za-z0-9_-]+$/u, "La credencial tiene caracteres inválidos."),
      pin: pinSeguro,
      pinConfirm: z.string(),
    })
    .refine((datos) => datos.pin === datos.pinConfirm, COINCIDEN),
});

export const resetOtherPosPinSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive("ID de usuario inválido."),
  }),
  body: z.object({
    reason: z
      .string()
      .trim()
      .min(3, "Escribí el motivo del restablecimiento.")
      .max(200, "El motivo no puede superar los 200 caracteres."),
  }),
});

export const openOperatorSessionSchema = z.object({
  body: z.object({
    // Se elige el PERFIL primero y después se valida SU PIN. Si el PIN fuera el
    // identificador, dos personas con el mismo PIN colisionarían y probar
    // 000000 loguearía como cualquiera que lo tenga.
    userId: z.coerce.number().int().positive("Elegí de quién es el PIN."),
    pin,
  }),
});

/**
 * Entrar al sistema con el código de la terminal.
 *
 * Usa `pin` y NO `pinSeguro`: acá no se está eligiendo un código, se está
 * verificando uno que ya existe. Rechazar "123456" en la validación de forma
 * le confirmaría a quien prueba a ciegas que ese no puede ser el de nadie —
 * información gratis para el atacante y ninguna para el mostrador.
 *
 * La terminal no viaja en el cuerpo: se prueba con la credencial de dispositivo
 * (ver `terminal.middleware.ts`). Un `terminalId` declarado por el navegador es
 * una afirmación sin respaldo.
 */
export const terminalPinLoginSchema = z.object({
  body: z.object({
    userId: z.coerce
      .number()
      .int()
      .positive("Elegí de la lista quién va a entrar."),
    pin,
  }),
});
