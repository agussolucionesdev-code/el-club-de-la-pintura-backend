import { Router } from "express";
import { getUsers, createUser, deleteUser } from "./user.controller";

const router = Router();

// Definición de la ruta GET para la obtención de la nómina de usuarios
router.get("/", getUsers);

// Definición de la ruta POST para el registro de altas de usuarios
router.post("/", createUser);

// Definición de la ruta DELETE para la baja de usuarios por ID
router.delete("/:id", deleteUser);

export default router;
