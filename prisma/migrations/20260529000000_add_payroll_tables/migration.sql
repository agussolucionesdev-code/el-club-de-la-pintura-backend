-- CreateTable: Employee
CREATE TABLE IF NOT EXISTS "Employee" (
    "id"         SERIAL          NOT NULL,
    "userId"     INTEGER         NOT NULL,
    "position"   TEXT            NOT NULL,
    "salaryType" TEXT            NOT NULL DEFAULT 'FIXED',
    "baseSalary" DECIMAL(12,2)   NOT NULL,
    "branchId"   INTEGER         NOT NULL,
    "isActive"   BOOLEAN         NOT NULL DEFAULT true,
    "createdAt"  TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3)    NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable: PayrollRecord
CREATE TABLE IF NOT EXISTS "PayrollRecord" (
    "id"           SERIAL          NOT NULL,
    "employeeId"   INTEGER         NOT NULL,
    "period"       TEXT            NOT NULL,
    "baseSalary"   DECIMAL(12,2)   NOT NULL,
    "advances"     DECIMAL(12,2)   NOT NULL DEFAULT 0,
    "bonuses"      DECIMAL(12,2)   NOT NULL DEFAULT 0,
    "deductions"   DECIMAL(12,2)   NOT NULL DEFAULT 0,
    "netPay"       DECIMAL(12,2)   NOT NULL,
    "status"       TEXT            NOT NULL DEFAULT 'PENDING',
    "paidAt"       TIMESTAMP(3),
    "observations" TEXT,
    "createdAt"    TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3)    NOT NULL,

    CONSTRAINT "PayrollRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Employee_userId_key"     ON "Employee"("userId");
CREATE INDEX IF NOT EXISTS "Employee_branchId_idx"          ON "Employee"("branchId");
CREATE INDEX IF NOT EXISTS "Employee_userId_idx"            ON "Employee"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "PayrollRecord_employeeId_period_key" ON "PayrollRecord"("employeeId", "period");
CREATE INDEX IF NOT EXISTS "PayrollRecord_period_idx"       ON "PayrollRecord"("period");
CREATE INDEX IF NOT EXISTS "PayrollRecord_status_idx"       ON "PayrollRecord"("status");

-- AddForeignKey
ALTER TABLE "PayrollRecord"
    ADD CONSTRAINT "PayrollRecord_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
