import { Router } from "express";
import { validateSchema } from "../../middlewares/validate.middleware";
import { registerUserSchema } from "../../schemas/user.schema";
import {
  getUsers,
  registerUser,
  deleteUser,
  loginUser,
} from "./user.controller";

const router = Router();

// Definición de la ruta POST para el registro de altas de usuarios
// INYECCIÓN DE ZOD: Intercepta y valida estrictamente el JSON antes de crear
router.post("/register", validateSchema(registerUserSchema), registerUser);

// Definición de la ruta POST para la autenticación de usuarios (Inicio de sesión)
router.post("/login", loginUser);

// Definición de la ruta GET para la obtención de la nómina de usuarios
router.get("/", getUsers);

// Definición de la ruta DELETE para la baja de usuarios por ID
router.delete("/:id", deleteUser);

export default router;
