-- CreateEnum
CREATE TYPE "CountryMode" AS ENUM ('ONLY', 'EXCEPT');

-- Renamed, not dropped and re-added, so a list already saved is kept. It
-- keeps meaning the same thing: existing shops get countryMode ONLY.
ALTER TABLE "Shop" RENAME COLUMN "allowedCountryCodes" TO "countryCodes";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "countryMode" "CountryMode" NOT NULL DEFAULT 'ONLY';
