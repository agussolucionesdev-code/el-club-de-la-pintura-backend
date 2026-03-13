// Carga automática de variables de entorno (Prioridad absoluta de ejecución)
import "dotenv/config";

// Importación de módulos principales y tipos de Express
import express, { Application, Request, Response } from "express";

// Importación de enrutadores modulares (Arquitectura Feature-First)
import branchRoutes from "./modules/branch/branch.routes";
import productRoutes from "./modules/product/product.routes";
import userRoutes from "./modules/user/user.routes";
import stockRoutes from "./modules/stock/stock.routes"; // <-- Integración del Módulo de Inventario

// Inicialización de la aplicación Express
const app: Application = express();

// Configuración del puerto del servidor
// Asignación del puerto mediante variable de entorno o fallback de seguridad al puerto 3000
const PORT = process.env.PORT || 3000;

// Integración de Middlewares globales
// Habilitación de la lectura de cuerpos de solicitud en formato JSON (Body Parser)
app.use(express.json());

// Registro de rutas principales de la API (Endpoints)
// Conexión del módulo de gestión de sucursales
app.use("/api/branches", branchRoutes);
// Conexión del módulo de catálogo de productos
app.use("/api/products", productRoutes);
// Conexión del módulo de seguridad e identidad (Usuarios)
app.use("/api/users", userRoutes);
// Conexión del módulo de control de inventario (Stock físico)
app.use("/api/stock", stockRoutes); // <-- Endpoint central de mercadería/inventario

// Definición de Endpoint de diagnóstico (Health Check)
// Verificación de disponibilidad y entorno de ejecución del servidor
app.get("/api/health", (req: Request, res: Response) => {
  res.status(200).json({
    status: "success",
    message: `El servidor de El Club de la Pintura está funcionando correctamente en modo: ${process.env.NODE_ENV}`,
  });
});

// Puesta en marcha del servidor HTTP
app.listen(PORT, () => {
  console.log(`Server is running smoothly on http://localhost:${PORT}`);
});
