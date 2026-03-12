import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

// Configuración de la cadena de conexión
// Obtención segura de la URL de la base de datos desde las variables de entorno
const connectionString = process.env.DATABASE_URL;

// Creación del gestor de conexiones (Pool)
// Utilización de la librería nativa de PostgreSQL para la administración de las conexiones a la base de datos
const pool = new Pool({ connectionString });

// Inicialización del adaptador
// Integración del Pool de PostgreSQL nativo con el ecosistema de Prisma
// Aplicación de Type Casting (as any) para la resolución de discrepancias de tipado entre librerías de terceros
const adapter = new PrismaPg(pool as any);

// Instanciación del cliente de base de datos
// Inyección del adaptador de PostgreSQL para el cumplimiento de la arquitectura obligatoria de Prisma v7
const prisma = new PrismaClient({ adapter });

// Exportación de la instancia única para su reutilización en toda la aplicación (Patrón Singleton)
export default prisma;
