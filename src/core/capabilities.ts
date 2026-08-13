/**
 * Capacidades: qué puede hacer cada quien, dicho una sola vez.
 *
 * ── Por qué no alcanza con el rol ───────────────────────────────────────────
 *
 * Hasta ahora la autorización eran strings de rol sueltos en cada ruta
 * (`authorizeRoles("ADMIN", "ENCARGADO")`). Funciona, pero no responde la
 * pregunta que importa en un mostrador compartido: **¿quién está operando
 * AHORA?** La cookie de sesión dice quién abrió el navegador — que puede ser el
 * dueño mientras atiende un empleado. Autorizar por el token le regala al
 * empleado los permisos del dueño. Eso es escalada de privilegios, y no es
 * hipotética: es la situación normal de una caja compartida.
 *
 * Este módulo separa dos cosas que estaban pegadas:
 *
 *   · Qué puede hacer un ROL             → `capabilitiesForRole`
 *   · Qué puede hacer una SESIÓN DE POS  → `posCapabilitiesForRole`
 *
 * La segunda es un subconjunto estricto de la primera. Un PIN de cuatro
 * segundos en el mostrador prueba "soy Fulano y estoy vendiendo", no "soy
 * Fulano y quiero borrar usuarios". Para eso Fulano inicia sesión con su
 * cuenta y su contraseña.
 */

export type Capability =
  // ── Las 13 que ya existían en la tabla del frontend ──
  // Se conservan con el MISMO nombre a propósito: así el frontend puede pasar a
  // consumir la lista que resuelve el servidor sin renombrar nada, y la tabla
  // deja de estar duplicada en dos lugares que se desincronizan.
  | "dashboard:view"
  | "pos:sell"
  | "cash:manage"
  | "stock:view"
  | "stock:adjust"
  | "customers:view"
  | "customers:create"
  | "customers:manage"
  | "suppliers:manage"
  | "products:manage"
  | "expenses:manage"
  | "users:manage"
  | "sync:manage"
  // ── Nuevas, introducidas por las Fases 1 a 4 ──
  | "sale:cancel"
  | "sale:return"
  | "price:override"
  | "discount:apply"
  | "costs:view"
  | "stock:view_all_branches"
  | "stock:transfer_request"
  | "terminals:manage"
  | "pin:reset_other";

const ADMIN_CAPABILITIES: Capability[] = [
  "dashboard:view",
  "pos:sell",
  "cash:manage",
  "stock:view",
  "stock:adjust",
  "customers:view",
  "customers:create",
  "customers:manage",
  "suppliers:manage",
  "products:manage",
  "expenses:manage",
  "users:manage",
  "sync:manage",
  "sale:cancel",
  "sale:return",
  "price:override",
  "discount:apply",
  "costs:view",
  "stock:view_all_branches",
  "stock:transfer_request",
  "terminals:manage",
  "pin:reset_other",
];

const ENCARGADO_CAPABILITIES: Capability[] = [
  "dashboard:view",
  "pos:sell",
  "cash:manage",
  "stock:view",
  "stock:adjust",
  "customers:view",
  "customers:create",
  "customers:manage",
  "suppliers:manage",
  "products:manage",
  "expenses:manage",
  "sync:manage",
  "sale:cancel",
  "sale:return",
  "price:override",
  "discount:apply",
  "costs:view",
  "stock:view_all_branches",
  "stock:transfer_request",
  "pin:reset_other",
];

const EMPLOYEE_CAPABILITIES: Capability[] = [
  "pos:sell",
  "stock:view",
  "customers:view",
  "customers:create",
  "sale:return",
  "discount:apply",
  // Ver el stock de la otra sucursal es INFORMACIÓN: sirve para decirle al
  // cliente "en la otra está". Pedir la transferencia MUEVE MERCADERÍA, y por
  // eso es una capacidad separada que el empleado no tiene.
  "stock:view_all_branches",
];

const BY_ROLE: Record<string, Capability[]> = {
  ADMIN: ADMIN_CAPABILITIES,
  ENCARGADO: ENCARGADO_CAPABILITIES,
  EMPLOYEE: EMPLOYEE_CAPABILITIES,
};

/**
 * Lo que una sesión de POS puede otorgar, como máximo.
 *
 * ── La regla que esto hace cumplir ──────────────────────────────────────────
 *
 * Un PIN identifica a quien está parado en la caja. Es rápido a propósito:
 * seis dígitos, cuatro segundos, sin sacar la mano del teclado. Esa velocidad
 * se paga con alcance — un secreto corto que se tipea a la vista de quien esté
 * al lado no puede ser la llave de la administración del negocio.
 *
 * Así que una sesión de PIN habilita vender, cobrar, devolver, consultar stock
 * y atender clientes. **No** habilita tocar usuarios, precios masivos,
 * proveedores, gastos, terminales ni resetear el PIN de nadie. Para eso hay que
 * iniciar sesión con la cuenta y la contraseña, que es el secreto largo.
 *
 * `stock:adjust` queda afuera aunque el rol lo tenga: ajustar inventario es
 * administración de depósito, no atención de mostrador.
 */
const POS_GRANTABLE = new Set<Capability>([
  "pos:sell",
  "cash:manage",
  "stock:view",
  "stock:view_all_branches",
  "stock:transfer_request",
  "customers:view",
  "customers:create",
  "sale:cancel",
  "sale:return",
  "price:override",
  "discount:apply",
  "costs:view",
]);

/** Todo lo que el rol puede hacer con su cuenta completa. */
export const capabilitiesForRole = (role: string): Set<Capability> =>
  new Set(BY_ROLE[role] ?? []);

/**
 * Lo que el rol puede hacer **operando el POS**, que es un subconjunto.
 *
 * Acá vive la defensa contra la escalada: aunque el dueño haya dejado abierta
 * su sesión de navegador, un empleado que entra con su PIN recibe las
 * capacidades de EMPLEADO intersecadas con esto. Nunca las del dueño.
 */
export const posCapabilitiesForRole = (role: string): Set<Capability> => {
  const efectivas = new Set<Capability>();
  for (const cap of capabilitiesForRole(role)) {
    if (POS_GRANTABLE.has(cap)) efectivas.add(cap);
  }
  return efectivas;
};

/** ¿Esta capacidad se puede otorgar por una sesión de POS? */
export const isPosGrantable = (capability: Capability): boolean =>
  POS_GRANTABLE.has(capability);

export const hasCapability = (
  capabilities: Set<Capability>,
  capability: Capability,
): boolean => capabilities.has(capability);

/** Para serializar al frontend, que consume esta lista en vez de tener la suya. */
export const toCapabilityList = (capabilities: Set<Capability>): Capability[] =>
  [...capabilities].sort();
