// Carga automática de variables de entorno (Prioridad absoluta de ejecución)
import "dotenv/config";

// Importación de módulos principales y utilidades
import express, { Application, Request, Response } from "express";
import cors from "cors";
import morgan from "morgan";

// Importación de Escudos de Seguridad (Middlewares globales)
import {
  globalErrorHandler,
  notFoundHandler,
} from "./middlewares/error.middleware";

// Importación de Enrutadores Modulares (Arquitectura Feature-First)
import branchRoutes from "./modules/branch/branch.routes";
import productRoutes from "./modules/product/product.routes";
import userRoutes from "./modules/user/user.routes";
import stockRoutes from "./modules/stock/stock.routes";
import saleRoutes from "./modules/sale/sale.routes";
import financeRoutes from "./modules/finance/finance.routes";
import customerRoutes from "./modules/customer/customer.routes";
import paymentRoutes from "./modules/payment/payment.routes";
import supplierRoutes from "./modules/supplier/supplier.routes";
import cashRegisterRoutes from "./modules/cash-register/cash-register.routes";
import expenseRoutes from "./modules/expense/expense.routes";
import dashboardRoutes from "./modules/dashboard/dashboard.routes";

// Inicialización de la aplicación Express
const app: Application = express();
const PORT = process.env.PORT || 4000;

// ============================================================================
// 1. MIDDLEWARES DE PROCESAMIENTO Y AUDITORÍA
// ============================================================================
app.use(cors()); // Habilitar peticiones cruzadas (Frontend <-> Backend)
app.use(express.json()); // Parsear cuerpos de solicitud en formato JSON
app.use(morgan("dev")); // Caja Negra: Registrar cada petición HTTP en consola para mantenimiento

// ============================================================================
// 2. ENDPOINTS DE DIAGNÓSTICO
// ============================================================================
// Verificación de disponibilidad y entorno de ejecución del servidor
app.get("/api/health", (req: Request, res: Response) => {
  res.status(200).json({
    status: "success",
    message: `El servidor de El Club Pinturerías está funcionando correctamente en modo: ${process.env.NODE_ENV || "development"}`,
  });
});

// ============================================================================
// 3. RUTAS DE NEGOCIO (API REST)
// ============================================================================
app.use("/api/branches", branchRoutes);
app.use("/api/products", productRoutes);
app.use("/api/users", userRoutes);
app.use("/api/stock", stockRoutes);
app.use("/api/sales", saleRoutes);
app.use("/api/finance", financeRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/suppliers", supplierRoutes);
app.use("/api/cash-registers", cashRegisterRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/dashboard", dashboardRoutes);

// ============================================================================
// 4. ESCUDOS DE SEGURIDAD (INTERCEPTORES DE ERRORES)
// CRÍTICO: Deben ser declarados estrictamente AL FINAL de todas las rutas.
// ============================================================================
app.use(notFoundHandler); // Captura solicitudes a rutas inexistentes (404)
app.use(globalErrorHandler); // Captura excepciones y evita el colapso del servidor (500)

// ============================================================================
// 5. INICIALIZACIÓN DEL SERVIDOR
// ============================================================================
// Jest configura automáticamente NODE_ENV = "test" cuando corre.
// Así evitamos que el puerto se quede colgado.
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(
      `🚀 Motor backend encendido, blindado y operando en http://localhost:${PORT}`,
    );
  });
}

export default app; // Importante exportarlo por si a futuro agregamos tests automáticos
