-- One budget per (user, category): lets set_budget upsert cleanly and prevents
-- duplicate budgets for the same category. Existing rows (if any) that violate
-- this would block the index; the table is unused so far, so it is empty.

-- CreateIndex
CREATE UNIQUE INDEX "Budget_userId_category_key" ON "Budget"("userId", "category");
