import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

// Read database connection string from environment
const connectionString = process.env.DATABASE_URL;

// Native pg connection pool for Prisma v7's driver-adapter architecture
const pool = new Pool({ connectionString });

// Prisma driver adapter — bridges the native pg Pool with Prisma's query engine
// `as any` cast resolves minor type-definition mismatches between the two libraries
const adapter = new PrismaPg(pool as any);

// Prisma client singleton — injected with the pg adapter as required by Prisma v7
const prisma = new PrismaClient({ adapter });

// Single export for reuse across the entire application (Singleton pattern)
export default prisma;
