import { v2 as cloudinary } from "cloudinary";

// Configuración de credenciales del servicio en la nube
// Extracción de variables de entorno para la autenticación segura con la API de Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Exportación de la instancia configurada (Patrón Singleton)
// Disponibilización del servicio de almacenamiento para su inyección en los controladores
export default cloudinary;
