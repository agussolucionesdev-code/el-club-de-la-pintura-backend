/**
 * AFIP WSFEv1 Type Definitions
 *
 * Structural adapters for Argentina's AFIP electronic invoicing web service.
 * These types map to the SOAP XML structures defined in the WSFEv1 WSDL.
 * No SOAP/XML logic is implemented here — this file defines the contract only.
 */

export type InvoiceType = "A" | "B" | "C";

/** Maps invoice type to AFIP's Tipo de Comprobante codes (CbteTipo) */
export const CBTE_TIPO: Record<InvoiceType, number> = {
  A: 1,  // Factura A
  B: 6,  // Factura B
  C: 11, // Factura C
};

export interface AFIPCredentials {
  cuit: string;
  /** Base64-encoded digital certificate (.pem) */
  cert: string;
  /** Base64-encoded private key (.pem) */
  privateKey: string;
  /** "testing" or "production" */
  environment: "testing" | "production";
}

/** AFIP authorization token set obtained from WSAA */
export interface AFIPAuthToken {
  token: string;
  sign: string;
  expiresAt: Date;
}

/** A single invoice line item */
export interface AFIPLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  vatRate: number; // e.g., 21, 10.5, 0
}

/** Full invoice request to be sent to WSFEv1 */
export interface WSFERequest {
  invoiceType: InvoiceType;
  /** Punto de venta (POS number registered with AFIP) */
  pointOfSale: number;
  /** Sequential invoice number — use getLastAuthorizedCAE to derive */
  invoiceNumber: number;
  issueDate: Date;
  currencyCode: string; // "PES" for ARS
  /** CUIT of the buyer (for Factura A) or 0 for final consumer (B/C) */
  buyerCuit?: string;
  items: AFIPLineItem[];
  netAmount: number;
  vatAmount: number;
  totalAmount: number;
}

/** Response returned by WSFEv1 after authorizing an invoice */
export interface WSFEResponse {
  /** Código de Autorización Electrónica — fiscal CAE code printed on the invoice */
  cae: string;
  /** CAE expiry date (usually D+10 from authorization date) */
  caeExpiryDate: Date;
  invoiceNumber: number;
  invoiceType: InvoiceType;
  pointOfSale: number;
  result: "A" | "R"; // Aprobado / Rechazado
  observations?: string[];
  errors?: string[];
}

/** Status of the AFIP service */
export interface AFIPServiceStatus {
  appServer: "OK" | "DOWN";
  dbServer: "OK" | "DOWN";
  authServer: "OK" | "DOWN";
}
