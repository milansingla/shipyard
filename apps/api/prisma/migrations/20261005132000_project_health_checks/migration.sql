-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "healthCheckPath" TEXT NOT NULL DEFAULT '/',
ADD COLUMN     "healthCheckPort" INTEGER,
ADD COLUMN     "healthCheckTimeoutSeconds" INTEGER;
