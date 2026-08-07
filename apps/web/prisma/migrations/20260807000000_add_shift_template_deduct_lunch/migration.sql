-- Add deductLunch column to ShiftTemplate for per-template lunch deduction control
-- Default true = existing behavior (all templates deduct lunch) — zero payroll diff

ALTER TABLE "ShiftTemplate" ADD COLUMN "deductLunch" BOOLEAN NOT NULL DEFAULT true;
