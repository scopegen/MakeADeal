-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "suggestionsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "NegotiationSession" ADD COLUMN     "suggestionsShown" BOOLEAN NOT NULL DEFAULT false;
