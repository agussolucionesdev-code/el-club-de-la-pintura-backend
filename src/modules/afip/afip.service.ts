/**
 * AFIP Service — structural adapter for WSFEv1 (Factura Electrónica).
 *
 * This class defines the full interface the rest of the application will use
 * when AFIP integration is implemented. All methods currently throw
 * AfipNotImplementedError so the architecture compiles and routes are testable
 * before the SOAP XML cryptography layer is built.
 *
 * Implementation roadmap:
 *   1. WSAA (authentication): obtain token+sign from AFIP's SOAP auth service.
 *   2. WSFEv1: use token+sign to call FECAESolicitar and FECompUltimoAutorizado.
 *   3. Token caching: tokens are valid for 12 hours — cache in Redis or memory.
 *
 * Reference: https://www.afip.gob.ar/fe/documentos/manual_desarrollador_COMPG_v2_10.pdf
 */
import type {
  AFIPCredentials,
  AFIPServiceStatus,
  InvoiceType,
  WSFERequest,
  WSFEResponse,
} from "./afip.types";

export class AfipNotImplementedError extends Error {
  readonly code = "AFIP_NOT_IMPLEMENTED";
  constructor(method: string) {
    super(
      `AFIP integration not yet implemented: ${method}. ` +
      "The SOAP/XML cryptography layer for WSFEv1 is pending. " +
      "This is an architectural placeholder.",
    );
  }
}

/**
 * Contract that any concrete AFIP adapter must satisfy.
 * Swap implementations without touching controllers.
 */
export interface IAfipService {
  /** Authorize a new invoice and obtain a CAE code */
  authorizeInvoice(invoice: WSFERequest): Promise<WSFEResponse>;

  /** Returns the last authorized sequential invoice number for a given type + POS */
  getLastAuthorizedNumber(invoiceType: InvoiceType, pointOfSale: number): Promise<number>;

  /** Ping AFIP servers to check availability */
  ping(): Promise<AFIPServiceStatus>;
}

/**
 * Placeholder implementation. Returns typed stubs and throws on real operations
 * so the architecture is wired up and TypeScript is happy before SOAP is built.
 */
export class AfipService implements IAfipService {
  constructor(private readonly credentials: AFIPCredentials) {}

  async authorizeInvoice(_invoice: WSFERequest): Promise<WSFEResponse> {
    throw new AfipNotImplementedError("authorizeInvoice");
  }

  async getLastAuthorizedNumber(
    _invoiceType: InvoiceType,
    _pointOfSale: number,
  ): Promise<number> {
    throw new AfipNotImplementedError("getLastAuthorizedNumber");
  }

  async ping(): Promise<AFIPServiceStatus> {
    // Ping is safe to stub — returns a readable "not configured" status
    return {
      appServer: "DOWN",
      dbServer: "DOWN",
      authServer: "DOWN",
    };
  }
}

// Singleton backed by env vars — replace with proper DI when fully implemented
export const afipService = new AfipService({
  cuit: process.env.AFIP_CUIT ?? "",
  cert: process.env.AFIP_CERT ?? "",
  privateKey: process.env.AFIP_PRIVATE_KEY ?? "",
  environment:
    process.env.AFIP_ENV === "production" ? "production" : "testing",
});
