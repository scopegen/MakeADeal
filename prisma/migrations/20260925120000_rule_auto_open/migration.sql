-- AlterTable
ALTER TABLE "NegotiationRule" ADD COLUMN     "autoOpenDelaySeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "autoOpenEnabled" BOOLEAN NOT NULL DEFAULT false;
