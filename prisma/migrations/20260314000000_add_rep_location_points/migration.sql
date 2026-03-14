-- CreateTable
CREATE TABLE "rep_location_points" (
    "id" SERIAL NOT NULL,
    "scientificRepId" INTEGER NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "trackedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workDate" TEXT NOT NULL,

    CONSTRAINT "rep_location_points_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rep_location_points_scientificRepId_workDate_idx" ON "rep_location_points"("scientificRepId", "workDate");

-- AddForeignKey
ALTER TABLE "rep_location_points" ADD CONSTRAINT "rep_location_points_scientificRepId_fkey" FOREIGN KEY ("scientificRepId") REFERENCES "scientific_representatives"("id") ON DELETE CASCADE ON UPDATE CASCADE;
