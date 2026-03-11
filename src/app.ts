import express, { Application, Request, Response } from "express";
import dotenv from "dotenv";

// 1. Cargamos las variables de entorno ANTES de inicializar cualquier otra cosa
dotenv.config();

const app: Application = express();

// 2. Ahora el puerto lo lee del archivo .env.
// Si por algún motivo no lo encuentra, usa el 3000 como plan B (escalabilidad pura).
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/api/health", (req: Request, res: Response) => {
  res.status(200).json({
    status: "success",
    // 3. Modificamos el mensaje para ver si está leyendo nuestra variable NODE_ENV
    message: `El servidor del Club de la Pintura está funcionando correctamente en modo: ${process.env.NODE_ENV}`,
  });
});

app.listen(PORT, () => {
  console.log(`Server is running smoothly on http://localhost:${PORT}`);
});
