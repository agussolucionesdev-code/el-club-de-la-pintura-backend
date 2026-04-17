import { Prisma } from "@prisma/client";

type InternalReceiptType =
  | "SALE"
  | "SALE_CANCEL"
  | "PAYMENT"
  | "EXPENSE"
  | "CASH_CLOSE";

interface CreateInternalReceiptInput {
  receiptType: InternalReceiptType;
  branchId: number;
  cashRegisterId?: number | null;
  saleId?: number | null;
  paymentId?: number | null;
  sourceId: number | string;
  payload: Record<string, unknown>;
  createdBy: number;
}

const receiptTypePrefix: Record<InternalReceiptType, string> = {
  SALE: "VTA",
  SALE_CANCEL: "ANU",
  PAYMENT: "PAG",
  EXPENSE: "EGR",
  CASH_CLOSE: "CJA",
};

const toReceiptJson = (payload: Record<string, unknown>) =>
  JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue;

export const buildInternalReceiptNumber = ({
  receiptType,
  branchId,
  cashRegisterId,
  sourceId,
}: Pick<
  CreateInternalReceiptInput,
  "receiptType" | "branchId" | "cashRegisterId" | "sourceId"
>) => {
  const branchPart = `S${String(branchId).padStart(3, "0")}`;
  const cashPart = cashRegisterId
    ? `C${String(cashRegisterId).padStart(4, "0")}`
    : "C0000";
  const sourcePart = String(sourceId).padStart(8, "0");

  return `CP-${branchPart}-${cashPart}-${receiptTypePrefix[receiptType]}-${sourcePart}`;
};

export const createInternalReceipt = async (
  tx: Prisma.TransactionClient,
  input: CreateInternalReceiptInput,
) => {
  const receiptNumber = buildInternalReceiptNumber(input);

  return tx.internalReceipt.create({
    data: {
      receiptNumber,
      receiptType: input.receiptType,
      branchId: input.branchId,
      cashRegisterId: input.cashRegisterId,
      saleId: input.saleId,
      paymentId: input.paymentId,
      payload: toReceiptJson(input.payload),
      createdBy: input.createdBy,
    },
  });
};
