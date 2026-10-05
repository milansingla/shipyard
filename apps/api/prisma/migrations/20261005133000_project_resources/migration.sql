-- CreateEnum
CREATE TYPE "RestartPolicy" AS ENUM ('NO', 'ON_FAILURE', 'UNLESS_STOPPED');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "cpuLimit" DOUBLE PRECISION,
ADD COLUMN     "memoryLimitMb" INTEGER,
ADD COLUMN     "restartPolicy" "RestartPolicy" NOT NULL DEFAULT 'UNLESS_STOPPED';
