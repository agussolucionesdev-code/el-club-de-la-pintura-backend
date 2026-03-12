import multer from "multer";

// Configuración del almacenamiento en memoria
// Utilización de la memoria RAM del servidor para el procesamiento temporal de archivos sin escritura en disco local
const storage = multer.memoryStorage();

// Definición del filtro de validación de extensiones
// Restricción estricta de formatos permitidos para la prevención de inyección de código y archivos maliciosos
const fileFilter = (
  req: Express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) => {
  // Declaración de los tipos MIME autorizados (Estándares web de imágenes)
  const allowedMimeTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/jpg",
  ];

  // Verificación de compatibilidad del archivo entrante
  if (allowedMimeTypes.includes(file.mimetype)) {
    // Aprobación del archivo
    cb(null, true);
  } else {
    // Rechazo del archivo con emisión de error de validación
    cb(
      new Error(
        "Formato de archivo no soportado. Se requieren imágenes JPG, PNG o WEBP.",
      ),
    );
  }
};

// Instanciación y exportación del middleware de intercepción
// Configuración de límites de tamaño (5MB) para la optimización del ancho de banda y protección del servidor
export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // Límite de 5 Megabytes por archivo
});
