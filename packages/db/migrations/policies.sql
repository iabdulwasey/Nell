-- Generated from src/rls.ts by `pnpm --filter @nell/db emit-policies`.
-- Committed so the rules that make the schema safe are reviewable as SQL,
-- and re-applied by the migrate script on every run. Idempotent by design.


ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_members_workspace_isolation ON workspace_members;
CREATE POLICY workspace_members_workspace_isolation ON workspace_members
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE vault_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vault_items_workspace_isolation ON vault_items;
CREATE POLICY vault_items_workspace_isolation ON vault_items
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE vault_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_secrets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vault_secrets_workspace_isolation ON vault_secrets;
CREATE POLICY vault_secrets_workspace_isolation ON vault_secrets
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tasks_workspace_isolation ON tasks;
CREATE POLICY tasks_workspace_isolation ON tasks
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approvals_workspace_isolation ON approvals;
CREATE POLICY approvals_workspace_isolation ON approvals
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE monitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS monitors_workspace_isolation ON monitors;
CREATE POLICY monitors_workspace_isolation ON monitors
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE monitor_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitor_reports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS monitor_reports_workspace_isolation ON monitor_reports;
CREATE POLICY monitor_reports_workspace_isolation ON monitor_reports
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_outbox_workspace_isolation ON notification_outbox;
CREATE POLICY notification_outbox_workspace_isolation ON notification_outbox
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS preferences_workspace_isolation ON preferences;
CREATE POLICY preferences_workspace_isolation ON preferences
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE task_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS task_ledger_workspace_isolation ON task_ledger;
CREATE POLICY task_ledger_workspace_isolation ON task_ledger
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE directives ENABLE ROW LEVEL SECURITY;
ALTER TABLE directives FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS directives_workspace_isolation ON directives;
CREATE POLICY directives_workspace_isolation ON directives
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messages_workspace_isolation ON messages;
CREATE POLICY messages_workspace_isolation ON messages
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_log_workspace_isolation ON audit_log;
CREATE POLICY audit_log_workspace_isolation ON audit_log
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));


DROP POLICY IF EXISTS audit_log_no_update ON audit_log;
CREATE POLICY audit_log_no_update ON audit_log AS RESTRICTIVE FOR UPDATE USING (false);
DROP POLICY IF EXISTS audit_log_no_delete ON audit_log;
CREATE POLICY audit_log_no_delete ON audit_log AS RESTRICTIVE FOR DELETE USING (false);

-- The policies above make an UPDATE match nothing. This makes it fail.
CREATE OR REPLACE FUNCTION nell_audit_is_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION nell_audit_is_append_only();
