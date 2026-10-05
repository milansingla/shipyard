-- CreateEnum
CREATE TYPE "EnvironmentVariableTarget" AS ENUM ('RUNTIME', 'BUILD', 'BOTH');

-- CreateTable
CREATE TABLE "environment_variables" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "secret" BOOLEAN NOT NULL DEFAULT false,
    "target" "EnvironmentVariableTarget" NOT NULL DEFAULT 'RUNTIME',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "environment_variables_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "environment_variables_projectId_key_key" ON "environment_variables"("projectId", "key");

-- AddForeignKey
ALTER TABLE "environment_variables" ADD CONSTRAINT "environment_variables_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
