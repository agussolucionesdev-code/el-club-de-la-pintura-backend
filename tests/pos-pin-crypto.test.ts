/**
 * Criptografía del PIN del POS.
 *
 * Un PIN de 6 dígitos son 10⁶ combinaciones: con un volcado de la base, bcrypt
 * las recorre en minutos. Estos tests fijan las dos defensas que lo evitan
 * —Argon2id memory-hard y un pepper que vive fuera de la base— y el
 * comportamiento del autorrevelado, que es la parte con riesgo asumido.
 */

import {
  currentKeyVersion,
  decryptPin,
  delayForAttempt,
  encryptPin,
  encryptionKey,
  generateActivationCode,
  generatePin,
  hashPin,
  isLockedOut,
  isRevealAvailable,
  LOCKOUT_MS,
  MAX_PIN_ATTEMPTS,
  PIN_PATTERN,
  PinConfigError,
  verifyPin,
} from "../src/utils/posPin.utils";

/**
 * `process.env` convierte TODO a string: asignarle `undefined` deja el literal
 * `"undefined"`, no una variable ausente. Para simular que falta hay que BORRAR
 * la clave. (Lección de la Fase 3, cuando un test pasó por el motivo equivocado.)
 */
const conEntorno = async (
  env: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
) => {
  const previo = { ...process.env };
  for (const [clave, valor] of Object.entries(env)) {
    if (valor === undefined) delete process.env[clave];
    else process.env[clave] = valor;
  }
  try {
    await fn();
  } finally {
    process.env = previo;
  }
};

/** Copia el buffer con el primer byte invertido: simula una fila manipulada. */
const conPrimerByteAlterado = (buf: Buffer): Buffer => {
  const copia = Buffer.from(buf);
  copia.writeUInt8(copia.readUInt8(0) ^ 0xff, 0);
  return copia;
};

const PEPPER = "pepper-de-prueba-suficientemente-largo";
const CLAVE = Buffer.alloc(32, 7).toString("hex"); // 32 bytes → AES-256

describe("PIN del POS: criptografía", () => {
  beforeEach(() => {
    process.env.POS_PIN_PEPPER = PEPPER;
    process.env.POS_PIN_ENC_KEY = CLAVE;
    delete process.env.POS_PIN_ENC_KEY_VERSION;
  });

  // ── Verificación ─────────────────────────────────────────────────────────

  describe("hash y verificación", () => {
    it("usa Argon2id, no bcrypt", async () => {
      const hash = await hashPin("123456");
      expect(hash.startsWith("$argon2id$")).toBe(true);
    });

    it("verifica el PIN correcto y rechaza el incorrecto", async () => {
      const hash = await hashPin("123456");
      expect(await verifyPin(hash, "123456")).toBe(true);
      expect(await verifyPin(hash, "654321")).toBe(false);
    });

    it("dos PIN iguales dan hashes DISTINTOS — hay salt por hash", async () => {
      const [a, b] = await Promise.all([hashPin("123456"), hashPin("123456")]);
      // Sin salt, dos personas con el mismo PIN tendrían el mismo hash y una
      // tabla precomputada los rompería a los dos de una.
      expect(a).not.toBe(b);
      expect(await verifyPin(a, "123456")).toBe(true);
      expect(await verifyPin(b, "123456")).toBe(true);
    });

    it("🔒 SIN el pepper correcto, el hash NO valida — la base sola no alcanza", async () => {
      const hash = await hashPin("123456");

      await conEntorno({ POS_PIN_PEPPER: "otro-pepper-completamente-distinto" }, async () => {
        // Esto es lo que protege un volcado de la base: sin la variable de
        // entorno del servidor, la fila no sirve para nada.
        expect(await verifyPin(hash, "123456")).toBe(false);
      });

      // Con el pepper de vuelta, valida.
      expect(await verifyPin(hash, "123456")).toBe(true);
    });

    it("sin pepper configurado no se puede validar nada", async () => {
      const hash = await hashPin("123456");
      await conEntorno({ POS_PIN_PEPPER: undefined }, async () => {
        expect(await verifyPin(hash, "123456")).toBe(false);
        await expect(hashPin("123456")).rejects.toThrow(PinConfigError);
      });
    });

    it("un pepper demasiado corto se rechaza", async () => {
      await conEntorno({ POS_PIN_PEPPER: "corto" }, async () => {
        await expect(hashPin("123456")).rejects.toThrow(/16 caracteres/u);
      });
    });

    it("un PIN que no sean 6 dígitos se rechaza", async () => {
      await expect(hashPin("12345")).rejects.toThrow(/6 dígitos/u);
      await expect(hashPin("1234567")).rejects.toThrow();
      await expect(hashPin("abcdef")).rejects.toThrow();
    });

    it("verificar nunca lanza: un error no se distingue de un PIN incorrecto", async () => {
      expect(await verifyPin("no-es-un-hash", "123456")).toBe(false);
      expect(await verifyPin("", "123456")).toBe(false);
    });
  });

  // ── Autorrevelado ────────────────────────────────────────────────────────

  describe("cifrado para el autorrevelado", () => {
    it("cifra y descifra el PIN propio", () => {
      const guardado = encryptPin("482913");
      expect(decryptPin(guardado)).toBe("482913");
    });

    it("cada cifrado usa un NONCE distinto", () => {
      const a = encryptPin("482913");
      const b = encryptPin("482913");
      // Reusar un nonce con la misma clave rompe AES-GCM por completo y filtra
      // el texto plano. Tiene que ser aleatorio por operación.
      expect(a.nonce.equals(b.nonce)).toBe(false);
      expect(a.cipher.equals(b.cipher)).toBe(false);
    });

    it("el texto cifrado no contiene el PIN", () => {
      const guardado = encryptPin("482913");
      expect(guardado.cipher.toString("utf8")).not.toContain("482913");
      expect(guardado.cipher.toString("hex")).not.toContain("482913");
    });

    it("🔒 manipular el texto cifrado hace fallar el descifrado", () => {
      const guardado = encryptPin("482913");
      const alterado = { ...guardado, cipher: conPrimerByteAlterado(guardado.cipher) };

      // El tag de GCM detecta la manipulación: falla en vez de devolver basura
      // que podría parecer un PIN válido.
      expect(() => decryptPin(alterado)).toThrow();
    });

    it("🔒 manipular el tag de autenticación también falla", () => {
      const guardado = encryptPin("482913");
      const alterado = { ...guardado, tag: conPrimerByteAlterado(guardado.tag) };
      expect(() => decryptPin(alterado)).toThrow();
    });

    it("🔒 con OTRA clave no se puede descifrar", async () => {
      const guardado = encryptPin("482913");
      await conEntorno({ POS_PIN_ENC_KEY: Buffer.alloc(32, 9).toString("hex") }, () => {
        expect(() => decryptPin(guardado)).toThrow();
      });
    });

    it("un PIN cifrado con una versión de clave vieja pide restablecer", async () => {
      const guardado = encryptPin("482913");
      await conEntorno({ POS_PIN_ENC_KEY_VERSION: "2" }, () => {
        // Rotar la clave no debe devolver basura: avisa que hay que rehacer el PIN.
        expect(() => decryptPin(guardado)).toThrow(/Restablecé tu PIN/u);
      });
    });
  });

  // ── Secretos separados y modo degradado ──────────────────────────────────

  describe("los secretos están separados", () => {
    it("el pepper y la clave de cifrado son variables distintas", async () => {
      // Compartirlas anularía el beneficio: una sola filtración daría
      // verificación Y revelado a la vez.
      const hash = await hashPin("123456");
      const guardado = encryptPin("123456");

      await conEntorno({ POS_PIN_ENC_KEY: undefined }, async () => {
        // Sin clave de cifrado: se sigue pudiendo VALIDAR.
        expect(await verifyPin(hash, "123456")).toBe(true);
        // Pero no revelar.
        expect(() => decryptPin(guardado)).toThrow(PinConfigError);
      });
    });

    it("MODO DEGRADADO: sin clave se valida pero no se revela ni se crea", async () => {
      const hash = await hashPin("123456");

      await conEntorno({ POS_PIN_ENC_KEY: undefined }, async () => {
        expect(isRevealAvailable()).toBe(false);
        // Fallar cerrado también en la validación dejaría el mostrador sin
        // vender por una variable de entorno mal cargada.
        expect(await verifyPin(hash, "123456")).toBe(true);
        expect(() => encryptPin("123456")).toThrow(PinConfigError);
      });
    });

    it("una clave de largo incorrecto se trata como ausente", async () => {
      await conEntorno({ POS_PIN_ENC_KEY: "clave-corta" }, () => {
        expect(encryptionKey()).toBeNull();
        expect(isRevealAvailable()).toBe(false);
      });
    });

    it("acepta la clave en hex y en base64", async () => {
      await conEntorno({ POS_PIN_ENC_KEY: Buffer.alloc(32, 3).toString("base64") }, () => {
        expect(encryptionKey()?.length).toBe(32);
      });
      expect(encryptionKey()?.length).toBe(32); // el hex del beforeEach
    });

    it("la versión de clave por defecto es 1", () => {
      expect(currentKeyVersion()).toBe(1);
    });
  });

  // ── Generación ───────────────────────────────────────────────────────────

  describe("generación", () => {
    it("genera PIN de exactamente 6 dígitos, incluidos los que empiezan en 0", () => {
      for (let i = 0; i < 300; i++) {
        const pin = generatePin();
        expect(PIN_PATTERN.test(pin)).toBe(true);
      }
    });

    it("los PIN generados no se repiten sistemáticamente", () => {
      const generados = new Set(Array.from({ length: 200 }, () => generatePin()));
      // Con CSPRNG sobre 10⁶ valores, 200 tiradas casi no deberían colisionar.
      expect(generados.size).toBeGreaterThan(190);
    });

    it("la credencial de activación NO tiene forma de PIN", () => {
      const code = generateActivationCode();
      // Es deliberado: quien la recibe no puede confundirla con un PIN ni
      // usarla para entrar directamente.
      expect(PIN_PATTERN.test(code)).toBe(false);
      expect(code.length).toBeGreaterThan(20);
    });
  });

  // ── Rate limit ───────────────────────────────────────────────────────────

  describe("demora progresiva y bloqueo", () => {
    it("la demora crece con cada fallo y tiene tope", () => {
      expect(delayForAttempt(0)).toBe(0);
      expect(delayForAttempt(1)).toBe(1000);
      expect(delayForAttempt(2)).toBe(2000);
      expect(delayForAttempt(3)).toBe(4000);
      expect(delayForAttempt(4)).toBe(8000);
      // El tope evita que un error honesto deje a alguien esperando un minuto.
      expect(delayForAttempt(10)).toBe(8000);
    });

    it("reconoce un bloqueo vigente y uno vencido", () => {
      expect(isLockedOut(null)).toBe(false);
      expect(isLockedOut(new Date(Date.now() + 60_000))).toBe(true);
      expect(isLockedOut(new Date(Date.now() - 1000))).toBe(false);
    });

    it("los umbrales son los acordados: 5 intentos, 15 minutos", () => {
      expect(MAX_PIN_ATTEMPTS).toBe(5);
      expect(LOCKOUT_MS).toBe(15 * 60 * 1000);
    });
  });
});
