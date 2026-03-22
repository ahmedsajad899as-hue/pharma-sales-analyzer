-- Step 1: Create plan_areas table
CREATE TABLE "plan_areas" (
    "id" SERIAL NOT NULL,
    "planId" INTEGER NOT NULL,
    "areaId" INTEGER NOT NULL,

    CONSTRAINT "plan_areas_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "plan_areas_planId_fkey" FOREIGN KEY ("planId") REFERENCES "monthly_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "plan_areas_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "plan_areas_planId_areaId_key" ON "plan_areas"("planId", "areaId");
CREATE INDEX "plan_areas_planId_idx" ON "plan_areas"("planId");

-- Step 2: Make scientificRepId optional
ALTER TABLE "monthly_plans" ALTER COLUMN "scientificRepId" DROP NOT NULL;
