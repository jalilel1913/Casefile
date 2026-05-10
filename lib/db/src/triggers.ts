// Auto-applied on server boot via applyIntegrityTriggers().
// Source of truth is also mirrored in triggers.sql for human review.
export const INTEGRITY_TRIGGERS_SQL = `
CREATE OR REPLACE FUNCTION sift_reject_artifact_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.case_id IS DISTINCT FROM OLD.case_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.sha256_hash IS DISTINCT FROM OLD.sha256_hash
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Evidence artifact is immutable: cannot modify integrity-critical columns of case_artifacts (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sift_artifact_immutable ON case_artifacts;
CREATE TRIGGER sift_artifact_immutable
  BEFORE UPDATE ON case_artifacts
  FOR EACH ROW
  EXECUTE FUNCTION sift_reject_artifact_mutation();

CREATE OR REPLACE FUNCTION sift_reject_artifact_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Evidence artifact is immutable: direct DELETE on case_artifacts is forbidden (id=%). Delete the parent case to cascade-remove.', OLD.id
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sift_artifact_no_direct_delete ON case_artifacts;
CREATE TRIGGER sift_artifact_no_direct_delete
  BEFORE DELETE ON case_artifacts
  FOR EACH ROW
  EXECUTE FUNCTION sift_reject_artifact_delete();
`;
