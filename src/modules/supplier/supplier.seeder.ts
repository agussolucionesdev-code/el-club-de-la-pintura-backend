import { Request, Response } from "express";
import { logger } from '../../config/logger';
import prisma from "../../config/db";

// Master seed list of 62 paint industry suppliers
const suppliersSeed = [
  {
    companyName: "Alba",
    contactName: "Ventas Alba",
    email: "ventas@alba.com.ar",
    phone: "11-0000-0000",
  },
  {
    companyName: "Sinteplast",
    contactName: "Ventas Sinteplast",
    email: "info@sinteplast.com.ar",
    phone: "11-0000-0000",
  },
  {
    companyName: "Sherwin Williams",
    contactName: "Ventas Sherwin",
    email: "info@sherwin.com.ar",
    phone: "11-0000-0000",
  },
  {
    companyName: "Rust Oleum",
    contactName: "Distribución",
    email: "ventas@rustoleum.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Plavicon",
    contactName: "Ventas Plavicon",
    email: "info@plavicon.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Colorin",
    contactName: "Ventas Colorin",
    email: "ventas@colorin.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Brikol",
    contactName: "Maderas Brikol",
    email: "info@brikol.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Cetol",
    contactName: "Maderas Cetol",
    email: "info@cetol.com.ar",
    phone: "11-0000-0000",
  },
  {
    companyName: "Casablanca",
    contactName: "Ventas Casablanca",
    email: "ventas@casablanca.com.ar",
    phone: "11-0000-0000",
  },
  {
    companyName: "Polacrin",
    contactName: "Ventas Polacrin",
    email: "info@polacrin.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Netcolor",
    contactName: "Ventas Netcolor",
    email: "info@netcolor.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Trimas",
    contactName: "Ventas Trimas",
    email: "ventas@trimas.com.ar",
    phone: "11-0000-0000",
  },
  {
    companyName: "WEG",
    contactName: "Industrial WEG",
    email: "industrial@weg.com.ar",
    phone: "11-0000-0000",
  },
  {
    companyName: "Kroma",
    contactName: "Ventas Kroma",
    email: "info@kroma.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Riopint",
    contactName: "Distribución Riopint",
    email: "ventas@riopint.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Cintoplom",
    contactName: "Ventas Cintoplom",
    email: "info@cintoplom.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Castelbianco",
    contactName: "Ventas Castelbianco",
    email: "info@castelbianco.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Zinsser",
    contactName: "Ventas Zinsser",
    email: "ventas@zinsser.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Vitecso",
    contactName: "Ventas Vitecso",
    email: "info@vitecso.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Zeocar",
    contactName: "Ventas Zeocar",
    email: "ventas@zeocar.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Sagi",
    contactName: "Distribuidora Sagi",
    email: "ventas@sagi.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Tais",
    contactName: "Ventas Tais",
    email: "info@tais.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Tede",
    contactName: "Ventas Tede",
    email: "info@tede.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Sanaferr",
    contactName: "Ventas Sanaferr",
    email: "ventas@sanaferr.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Silver",
    contactName: "Ventas Silver",
    email: "info@silver.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Obra Color",
    contactName: "Ventas Obra Color",
    email: "ventas@obracolor.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Piletas",
    contactName: "Categoría Piletas",
    email: "info@piletas.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Petrilac",
    contactName: "Ventas Petrilac",
    email: "info@petrilac.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Plasticar",
    contactName: "Ventas Plasticar",
    email: "info@plasticar.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Molduras",
    contactName: "Categoría Molduras",
    email: "info@molduras.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Murallon",
    contactName: "Ventas Murallon",
    email: "info@murallon.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Megaflex",
    contactName: "Ventas Megaflex",
    email: "ventas@megaflex.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Emap",
    contactName: "Ventas Emap",
    email: "info@emap.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Jewel",
    contactName: "Ventas Jewel",
    email: "ventas@jewel.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Juash",
    contactName: "Ventas Juash",
    email: "info@juash.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Indasa",
    contactName: "Ventas Indasa",
    email: "ventas@indasa.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Lamiplas",
    contactName: "Ventas Lamiplas",
    email: "info@lamiplas.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Galgo",
    contactName: "Herramientas Galgo",
    email: "ventas@galgo.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Norton",
    contactName: "Lijas Norton",
    email: "info@norton.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Fana Quimica",
    contactName: "Ventas Fana",
    email: "ventas@fana.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Diproel",
    contactName: "Ventas Diproel",
    email: "info@diproel.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Duracril",
    contactName: "Ventas Duracril",
    email: "ventas@duracril.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Dixilina",
    contactName: "Ventas Dixilina",
    email: "info@dixilina.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Accesorios",
    contactName: "Categoría Accesorios",
    email: "ventas@accesorios.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Escaleras",
    contactName: "Categoría Escaleras",
    email: "info@escaleras.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Espatulas",
    contactName: "Categoría Espatulas",
    email: "ventas@espatulas.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Rodillos",
    contactName: "Categoría Rodillos",
    email: "info@rodillos.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Pinceles",
    contactName: "Categoría Pinceles",
    email: "ventas@pinceles.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Cintas",
    contactName: "Categoría Cintas",
    email: "info@cintas.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Accesorios Pintureria",
    contactName: "Categoría Accesorios",
    email: "ventas@accesorios.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Escaleras Pintor",
    contactName: "Categoría Escaleras",
    email: "ventas@escaleras.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Ancar",
    contactName: "Distribución Ancar",
    email: "ventas@ancar.com.ar",
    phone: "11-0000-0000",
  },
  {
    companyName: "Aerosoles",
    contactName: "Categoría Aerosoles",
    email: "info@aerosoles.com.ar",
    phone: "11-0000-0000",
  },
  {
    companyName: "Aquiles",
    contactName: "Ventas Aquiles",
    email: "ventas@aquiles.com.ar",
    phone: "11-0000-0000",
  },
  {
    companyName: "Eq",
    contactName: "Distribución Eq",
    email: "info@eq.com.ar",
    phone: "11-0000-0000",
  },
  {
    companyName: "Doble A",
    contactName: "Ventas Doble A",
    email: "ventas@doblea.com.ar",
    phone: "11-0000-0000",
  },
  {
    companyName: "Paint Roller",
    contactName: "Herramientas Paint Roller",
    email: "info@paintroller.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Pinas",
    contactName: "Distribución Pinas",
    email: "ventas@pinas.com.ar",
    phone: "11-0000-0000",
  },
  {
    companyName: "Sika",
    contactName: "Ventas Sika",
    email: "info@sika.com.ar",
    phone: "11-0000-0000",
  },
  {
    companyName: "Uxell",
    contactName: "Ventas Uxell",
    email: "ventas@uxell.com.ar",
    phone: "11-0000-0000",
  },
  {
    companyName: "Venier",
    contactName: "Ventas Venier",
    email: "info@venier.com.ar",
    phone: "11-0000-0000",
  },
  {
    companyName: "Sagitario Distribuidora",
    contactName: "Distribución Sagitario",
    email: "ventas@sagitario.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Sherwin Williams Serrentino",
    contactName: "Distribución Serrentino",
    email: "ventas@serrentino.com",
    phone: "11-0000-0000",
  },
  {
    companyName: "Detailing Ramiro",
    contactName: "Ventas Detailing",
    email: "ventas@detailing.com.ar",
    phone: "11-0000-0000",
  },
];

export const seedSuppliers = async (req: Request, res: Response) => {
  logger.info("🌱 Iniciando siembra de Proveedores vía Endpoint...");

  let creados = 0;
  let existentes = 0;

  try {
    for (const [i, supplier] of suppliersSeed.entries()) {
      const exists = await prisma.supplier.findFirst({
        where: { companyName: supplier.companyName },
      });

      if (!exists) {
        // Generate a dynamic CUIT starting at index 10 to avoid collisions
        const uniqueNum = i + 10;
        const fakeCuit = `30-000000${uniqueNum < 100 ? uniqueNum : uniqueNum}-9`;

        await prisma.supplier.create({
          data: {
            companyName: supplier.companyName,
            contactName: supplier.contactName,
            email: supplier.email,
            phone: supplier.phone,
            address: "Dirección no especificada",
            cuit: fakeCuit,
          },
        });
        creados++;
        logger.info(`✅ Creado: ${supplier.companyName}`);
      } else {
        existentes++;
      }
    }

    const totalFinal = await prisma.supplier.count();

    res.status(200).json({
      message: "Siembra completada con éxito.",
      resumenScript: {
        nuevosCreados: creados,
        yaExistianInalterados: existentes,
        totalEnBaseDeDatos: totalFinal,
      },
    });
  } catch (error: unknown) {
    logger.error("❌ Error durante la siembra:", error);
    const msg = error instanceof Error ? error.message : "Error desconocido.";

    res.status(500).json({
      error: "Fallo en la siembra de proveedores.",
      motivoPrisma: msg,
    });
  }
};
