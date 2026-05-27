import multer from "multer";

// In-memory storage: files are held in RAM during processing, never written to local disk
const storage = multer.memoryStorage();

// File type validation filter
// Strictly allowlisted MIME types to prevent code injection via uploaded files
const fileFilter = (
  req: Express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) => {
  // Authorized MIME types: web image formats + Excel/CSV spreadsheet formats
  const allowedMimeTypes = [
    // Image formats
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/jpg",
    // Spreadsheet formats
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
    "application/vnd.ms-excel", // .xls
    "text/csv", // .csv
  ];

  // Accept or reject based on MIME type
  if (allowedMimeTypes.includes(file.mimetype)) {
    // File approved
    cb(null, true);
  } else {
    // File rejected — emit validation error
    cb(
      new Error(
        "Formato de archivo no soportado. Se requieren imágenes (JPG, PNG, WEBP) o documentos Excel/CSV.",
      ),
    );
  }
};

// Multer instance with 10 MB size cap to protect server bandwidth and memory
export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file — accommodates large product catalogs
});
