-- Services declared by shipyard.yaml, and which settings the dashboard overrides.
-- CreateEnum
CREATE TYPE "ServiceSource" AS ENUM ('DASHBOARD', 'CONFIG_FILE');
-- AlterTable
ALTER TABLE "services" ADD COLUMN     "managedBy" "ServiceSource" NOT NULL DEFAULT 'DASHBOARD',
ADD COLUMN     "overrides" TEXT[] DEFAULT ARRAY[]::TEXT[];
