-- Partial index on due_date for efficient date-based action queries
CREATE INDEX IF NOT EXISTS idx_actions_due_date ON actions(due_date)
    WHERE due_date IS NOT NULL;
