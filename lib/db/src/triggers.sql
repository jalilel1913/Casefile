-- ============================================================================
-- Protocol SIFT — Evidence Integrity Triggers
-- ----------------------------------------------------------------------------
-- These triggers enforce the architectural invariant that evidence artifacts,
-- once stored, are immutable. The integrity-bearing columns of case_artifacts
-- can never be UPDATEd, and rows can only be DELETEd via cascade from cases.
--
-- This file is idempotent: it can be re-applied at any time. Applied via
-- `lib/db/src/setup-triggers.ts` (run on server boot).
-- ============================================================================

-- Reject UPDATE of integrity-critical columns on case_artifacts.
-- The `filename` column is intentionally left mutable so users can fix labels.
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

-- Reject direct DELETE on case_artifacts. The only legitimate way to remove
-- a row is via ON DELETE CASCADE from cases (e.g. when a case is deleted),
-- which Postgres performs in a separate session_user context. To allow
-- cascades while blocking direct deletes, we check current_setting() of a
-- session-local variable set by application code that performs the cascade.
--
-- Simpler and just as safe for this prototype: block ALL deletes from the
-- application connection. Cases themselves can still be deleted, and the
-- artifacts cascade fires the trigger but we exempt the cascade by checking
-- pg_trigger_depth() — when > 0, we're being invoked by another trigger
-- (the FK cascade), and we allow it.
CREATE OR REPLACE FUNCTION sift_reject_artifact_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    -- Cascading from another trigger (e.g. cases ON DELETE CASCADE). Allow.
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
