// 1. Carga automática de variables de entorno ANTES de cualquier otra ejecución
import "dotenv/config";

import express, { Application, Request, Response } from "express";
import branchRoutes from "./routes/branch.routes";

// Inicialización de la aplicación Express
const app: Application = express();

// Configuración del puerto del servidor
// Se establece el puerto desde las variables de entorno o se asigna el 3000 como valor por defecto
const PORT = process.env.PORT || 3000;

// Middlewares globales
// Se habilita el procesamiento de cuerpos de solicitud en formato JSON
app.use(express.json());

// Enrutamiento principal de la API
// Se asignan las rutas de gestión de sucursales al endpoint correspondiente
app.use("/api/branches", branchRoutes);

// Endpoint de verificación de estado (Health Check)
// Se utiliza para comprobar la disponibilidad y el entorno de ejecución del servidor
app.get("/api/health", (req: Request, res: Response) => {
  res.status(200).json({
    status: "success",
    message: `El servidor de El Club de la Pintura está funcionando correctamente en modo: ${process.env.NODE_ENV}`,
  });
});

// Puesta en marcha del servidor
app.listen(PORT, () => {
  console.log(`Server is running smoothly on http://localhost:${PORT}`);
});
