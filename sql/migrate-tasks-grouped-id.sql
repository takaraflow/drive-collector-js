-- Add grouped_id to tasks: media-group (album) batch cancel groups by it.
--
-- Go collector writes it at album flush time; JS never did (that's why the
-- legacy cancel_batch_ buttons answered "task not found"). Nullable: single
-- files and pre-migration rows have no group.

ALTER TABLE tasks ADD COLUMN grouped_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_tasks_grouped_id ON tasks(grouped_id);
