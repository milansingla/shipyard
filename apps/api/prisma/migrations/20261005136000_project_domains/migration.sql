-- CreateTable
CREATE TABLE "project_domains" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_domains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_domains_hostname_key" ON "project_domains"("hostname");

-- CreateIndex
CREATE INDEX "project_domains_projectId_idx" ON "project_domains"("projectId");

-- AddForeignKey
ALTER TABLE "project_domains" ADD CONSTRAINT "project_domains_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
