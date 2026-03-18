-- AlterTable: add isExtraVisit flag to plan_entries
ALTER TABLE "plan_entries" ADD COLUMN "isExtraVisit" BOOLEAN NOT NULL DEFAULT false;
