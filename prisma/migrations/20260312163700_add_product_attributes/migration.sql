-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "baseType" TEXT,
ADD COLUMN     "color" TEXT,
ADD COLUMN     "finish" TEXT,
ADD COLUMN     "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "indoorOutdoor" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "volume" DOUBLE PRECISION,
ADD COLUMN     "volumeUnit" TEXT;
