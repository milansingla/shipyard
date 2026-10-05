-- A service can be a PostgreSQL server running a prebuilt image.

-- AlterEnum
ALTER TYPE "ServiceType" ADD VALUE 'POSTGRES';

-- AlterTable
ALTER TABLE "services" ADD COLUMN     "image" TEXT;
