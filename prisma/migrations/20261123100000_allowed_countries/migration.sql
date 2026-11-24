-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "allowedCountryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];
