/*
  Warnings:

  - You are about to drop the `InterviewQuestion` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "InterviewQuestion" DROP CONSTRAINT "InterviewQuestion_sessionId_fkey";

-- DropTable
DROP TABLE "InterviewQuestion";
