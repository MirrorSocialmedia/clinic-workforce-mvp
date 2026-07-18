-- Add resignedAt column to Employee
ALTER TABLE "Employee" ADD COLUMN "resignedAt" TIMESTAMP(3);

-- Add CANCELLED to LeaveStatus enum
ALTER TYPE "LeaveStatus" ADD VALUE 'CANCELLED';
