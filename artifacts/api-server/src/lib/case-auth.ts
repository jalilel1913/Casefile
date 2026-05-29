import { db, casesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { NotFoundError } from "./errors";

/**
 * Load a case and enforce strict ownership.
 *
 * A case is accessible only when ownerUserId matches the requesting user.
 * Cases with ownerUserId = NULL (created before auth was added) are not
 * accessible; they must be re-created by an authenticated user.
 *
 * Returns 404 (not 403) on any mismatch to avoid leaking whether the
 * case exists to unauthorised callers.
 */
export async function requireCaseAccess(caseId: string, userId: string) {
  const [caseRow] = await db
    .select()
    .from(casesTable)
    .where(
      and(
        eq(casesTable.id, caseId),
        eq(casesTable.ownerUserId, userId),
      ),
    );

  if (!caseRow) {
    throw new NotFoundError("case_not_found", `Case ${caseId} not found`);
  }

  return caseRow;
}

/**
 * Same as requireCaseAccess but only returns the { id } field —
 * cheap preflight for routes that just need to verify ownership.
 */
export async function requireCaseAccessId(caseId: string, userId: string) {
  const [row] = await db
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(
      and(
        eq(casesTable.id, caseId),
        eq(casesTable.ownerUserId, userId),
      ),
    );

  if (!row) {
    throw new NotFoundError("case_not_found", `Case ${caseId} not found`);
  }

  return row;
}
