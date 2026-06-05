import { Response } from "express";
import { logger } from "../../config/logger";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import { afipService, AfipNotImplementedError } from "./afip.service";
import { CBTE_TIPO, InvoiceType, WSFERequest } from "./afip.types";

const parseInvoiceType = (value: unknown): InvoiceType | null => {
  if (value === "A" || value === "B" || value === "C") return value;
  return null;
};

/**
 * POST /afip/authorize
 *
 * Authorizes an invoice through AFIP WSFEv1 and returns a CAE code.
 * Returns 501 until the SOAP integration layer is implemented.
 */
export const authorizeInvoice = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "No autenticado." });

    const invoiceType = parseInvoiceType(req.body.invoiceType);
    if (!invoiceType) {
      return res.status(400).json({
        error: "Tipo de factura inválido. Use 'A', 'B', o 'C'.",
      });
    }

    const {
      pointOfSale,
      invoiceNumber,
      issueDate,
      currencyCode = "PES",
      buyerCuit,
      items = [],
      netAmount,
      vatAmount,
      totalAmount,
    } = req.body as Partial<WSFERequest>;

    if (
      !pointOfSale ||
      !invoiceNumber ||
      !issueDate ||
      netAmount === undefined ||
      vatAmount === undefined ||
      totalAmount === undefined
    ) {
      return res.status(400).json({
        error:
          "Faltan campos obligatorios: pointOfSale, invoiceNumber, issueDate, netAmount, vatAmount, totalAmount.",
      });
    }

    const invoiceRequest: WSFERequest = {
      invoiceType,
      pointOfSale: Number(pointOfSale),
      invoiceNumber: Number(invoiceNumber),
      issueDate: new Date(issueDate as unknown as string),
      currencyCode,
      buyerCuit: String(buyerCuit ?? ""),
      items: Array.isArray(items) ? items : [],
      netAmount: Number(netAmount),
      vatAmount: Number(vatAmount),
      totalAmount: Number(totalAmount),
    };

    const result = await afipService.authorizeInvoice(invoiceRequest);
    res.status(200).json({ data: result });
  } catch (error) {
    if (error instanceof AfipNotImplementedError) {
      return res.status(501).json({
        error: "Integración AFIP no implementada aún.",
        code: error.code,
        detail: error.message,
        cbteTipo: CBTE_TIPO,
      });
    }
    logger.error("AFIP authorize error:", error);
    res.status(500).json({ error: "Error al comunicarse con AFIP." });
  }
};

/**
 * GET /afip/last-number/:type/:pos
 *
 * Returns the last authorized sequential invoice number for a given type and POS.
 * Returns 501 until the SOAP integration layer is implemented.
 */
export const getLastAuthorizedNumber = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "No autenticado." });

    const invoiceType = parseInvoiceType(String(req.params.type ?? "").toUpperCase());
    const pointOfSale = Number(req.params.pos);

    if (!invoiceType) {
      return res.status(400).json({ error: "Tipo de factura inválido. Use A, B, o C." });
    }
    if (!Number.isInteger(pointOfSale) || pointOfSale <= 0) {
      return res.status(400).json({ error: "Número de punto de venta inválido." });
    }

    const lastNumber = await afipService.getLastAuthorizedNumber(invoiceType, pointOfSale);
    res.status(200).json({ data: { invoiceType, pointOfSale, lastNumber } });
  } catch (error) {
    if (error instanceof AfipNotImplementedError) {
      return res.status(501).json({
        error: "Integración AFIP no implementada aún.",
        code: error.code,
      });
    }
    logger.error("AFIP getLastNumber error:", error);
    res.status(500).json({ error: "Error al consultar AFIP." });
  }
};

/**
 * GET /afip/status
 *
 * Pings AFIP servers and returns their availability status.
 */
export const getAfipStatus = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "No autenticado." });

    const status = await afipService.ping();
    res.status(200).json({ data: status, configured: !!process.env.AFIP_CUIT });
  } catch (error) {
    logger.error("AFIP ping error:", error);
    res.status(500).json({ error: "Error al verificar estado de AFIP." });
  }
};
