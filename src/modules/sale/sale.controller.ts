import { Request, Response } from "express";
import prisma from "../../config/db";

// ============================================================================
// EJECUTAR TRANSACCIÓN: Procesar Punto de Venta (POS), Inventario y Caja
// ============================================================================
export const executeCommercialTransaction = async (
  req: Request,
  res: Response,
) => {
  try {
    const {
      branchId,
      paymentMethod,
      items,
      customerId,
      pickedUpBy,
      amountPaid,
    } = req.body;
    const authUser = (req as any).user;

    // BARRERA DE SEGURIDAD MULTI-SUCURSAL
    if (authUser.role !== "ADMIN" && !authUser.branchIds.includes(branchId)) {
      return res.status(403).json({
        error:
          "Brecha de seguridad: Tu perfil operativo no tiene autorización para facturar en esta sucursal.",
      });
    }

    const transactionResult = await prisma.$transaction(async (tx) => {
      // 1. INYECCIÓN DE CAJA: Verificación de Turno Abierto
      const activeShift = await tx.cashRegister.findFirst({
        where: { userId: authUser.id, branchId: branchId, status: "OPEN" },
      });

      if (!activeShift) {
        throw new Error(
          "Operación denegada: Debes abrir tu turno de caja antes de facturar.",
        );
      }

      let totalAmount = 0;
      const enrichedItems = [];

      // 2. PROCESAR ÍTEMS: Calcular totales, congelar costos y descontar stock físico
      for (const item of items) {
        const subtotal = item.quantity * item.unitPrice;
        totalAmount += subtotal;

        const productData = await tx.product.findUnique({
          where: { id: item.productId },
          select: { costPrice: true },
        });

        const currentStock = await tx.stock.findUnique({
          where: {
            productId_branchId: {
              productId: item.productId,
              branchId: branchId,
            },
          },
        });

        if (!currentStock || currentStock.quantity < item.quantity) {
          throw new Error(
            `Inventario insuficiente para el producto ID: ${item.productId}. Venta abortada.`,
          );
        }

        await tx.stock.update({
          where: { id: currentStock.id },
          data: { quantity: { decrement: item.quantity } },
        });

        await tx.movement.create({
          data: {
            type: "OUT",
            quantity: item.quantity,
            reason: `Venta Comercial - Medio: ${paymentMethod}`,
            productId: item.productId,
            branchId: branchId,
            userId: authUser.id,
          },
        });

        enrichedItems.push({
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          unitCost: productData?.costPrice || 0,
          subtotal: item.quantity * item.unitPrice,
        });
      }

      // 3. CÁLCULO FINANCIERO: Evaluación de Deuda y Estado Crediticio
      const actualAmountPaid =
        amountPaid !== undefined ? Number(amountPaid) : totalAmount;
      const balance = totalAmount - actualAmountPaid;

      let status = "PAID";
      if (actualAmountPaid === 0) status = "PENDING";
      else if (balance > 0) status = "PARTIAL";

      // 4. GENERAR TICKET MAESTRO: Vinculado a Cuenta Corriente y Caja Activa
      const saleRecord = await tx.sale.create({
        data: {
          totalAmount,
          paymentMethod,
          branchId,
          userId: authUser.id,
          customerId: customerId ? Number(customerId) : null,
          pickedUpBy: pickedUpBy || null,
          status,
          balance,
          cashRegisterId: activeShift.id, // VINCULACIÓN DE CAJA
          items: {
            create: enrichedItems,
          },
        },
        include: { items: true },
      });

      // 5. REGISTRAR FLUJO DE EFECTIVO FÍSICO Y VINCULAR A CAJA
      if (actualAmountPaid > 0) {
        await tx.payment.create({
          data: {
            amount: actualAmountPaid,
            paymentMethod: paymentMethod,
            saleId: saleRecord.id,
            userId: authUser.id,
            branchId: branchId,
            cashRegisterId: activeShift.id, // VINCULACIÓN DE CAJA
          },
        });
      }

      return saleRecord;
    });

    res.status(201).json({
      message: "Transacción comercial y flujo de caja procesados con éxito.",
      ticket: transactionResult,
    });
  } catch (error: any) {
    console.error("Error crítico en el motor transaccional de ventas:", error);
    if (error instanceof Error) {
      return res.status(400).json({ error: error.message });
    }
    // Si no lo ataja el if, lo mandamos al Escudo Global que armamos antes llamando a 'next' o devolviendo 500
    res
      .status(500)
      .json({ error: "Fallo estructural al procesar el carrito de compras." });
  }
};

// ============================================================================
// RECUPERAR HISTORIAL: Auditoría de tickets con Paginación Inteligente
// ============================================================================
export const retrieveSalesHistory = async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;

    // 1. LECTURA DE PARÁMETROS DE PAGINACIÓN (Enviados por el celular/Frontend)
    // Si no mandan nada, por defecto traemos la página 1, con 50 registros máximo.
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = (page - 1) * limit;

    // 2. CONSTRUCCIÓN DEL FILTRO DE SEGURIDAD ESPACIAL
    const whereClause =
      authUser.role === "ADMIN" ? {} : { branchId: { in: authUser.branchIds } };

    // 3. EJECUCIÓN PARALELA (Performance Enterprise)
    // Buscamos los tickets de la página solicitada y, AL MISMO TIEMPO, contamos cuántos hay en total.
    const [salesHistory, totalRecords] = await Promise.all([
      prisma.sale.findMany({
        where: whereClause,
        skip, // Saltamos los registros de las páginas anteriores
        take: limit, // Tomamos solo la cantidad solicitada (Ahorro de memoria)
        include: {
          user: { select: { name: true, role: true } },
          customer: { select: { name: true, document: true, type: true } },
          items: {
            include: { product: { select: { name: true, sku: true } } },
          },
          payments: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.sale.count({ where: whereClause }), // Contamos el universo total de ventas
    ]);

    // 4. CÁLCULO DE METADATA PARA EL FRONTEND
    const totalPages = Math.ceil(totalRecords / limit);

    // 5. RESPUESTA ESTRUCTURADA
    res.status(200).json({
      message: "Historial de ventas recuperado exitosamente.",
      metadata: {
        totalRecords, // Ej: 15420 ventas históricas
        totalPages, // Ej: 309 páginas
        currentPage: page, // Ej: Página 1
        recordsPerPage: limit, // Ej: 50 ventas
      },
      data: salesHistory, // La lista de 50 ventas exactas para renderizar
    });
  } catch (error) {
    console.error("Error al obtener el registro de facturación:", error);
    res
      .status(500)
      .json({ error: "Hubo un problema al consultar los tickets de venta." });
  }
};
