CREATE TYPE "CustomerSegment" AS ENUM ('EASY_TO_CONVERT', 'CAN_BE_CONVERTED', 'MAYBE_CONVERTIBLE', 'TOO_LOW');

-- AlterTable
ALTER TABLE "NegotiationSession" ADD COLUMN     "segment" "CustomerSegment";

