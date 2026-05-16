-- Reference SQL for the default-drive SSOT migration.
--
-- The executable migration SSOT is src/database/schema.js and should be run via
-- `npm run db:migrate`, which records schema_migrations and handles existing
-- schemas safely. Do not use this file as an ad hoc production patch.
--
-- D1 owns drive bindings and default drive selection. Cache settings named
-- default_drive_* are legacy data and should not be used as the runtime source
-- after this migration.

ALTER TABLE drives ADD COLUMN is_default INTEGER DEFAULT 0 CHECK (is_default IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_drives_user_default ON drives(user_id, is_default);
CREATE UNIQUE INDEX IF NOT EXISTS idx_drives_one_default_per_user ON drives(user_id) WHERE is_default = 1 AND status = 'active';
