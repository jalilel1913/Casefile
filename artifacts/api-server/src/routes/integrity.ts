import {
  caseArtifactsTable,
  casesTable,
  db,
  executionLogsTable,
} from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { NotFoundError } from "../lib/errors";

const router: IRouter = Router();

router.get("/cases/:caseId/chain-of-custody", async (req, res) => {
  const { caseId } = req.params;
  const [caseRow] = await db
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(eq(casesTable.id, caseId));
  if (!caseRow) {
    throw new NotFoundError("case_not_found", `Case ${caseId} not found`);
  }

  const rows = await db
    .select({
      executionLogId: executionLogsTable.id,
      artifactId: executionLogsTable.artifactId,
      analysisStepId: executionLogsTable.analysisStepId,
      toolName: executionLogsTable.toolName,
      readAt: executionLogsTable.startedAt,
      input: executionLogsTable.input,
      error: executionLogsTable.error,
      artifactSha256: caseArtifactsTable.sha256Hash,
      artifactKind: caseArtifactsTable.kind,
      artifactFilename: caseArtifactsTable.filename,
    })
    .from(executionLogsTable)
    .innerJoin(
      caseArtifactsTable,
      eq(caseArtifactsTable.id, executionLogsTable.artifactId),
    )
    .where(eq(executionLogsTable.caseId, caseId))
    .orderBy(asc(executionLogsTable.startedAt));

  const seenArtifacts = new Set<string>();
  const entries = rows.map((r) => {
    seenArtifacts.add(r.artifactId!);
    const input = (r.input ?? {}) as { sha256?: string | null };
    // Only the hash that was actually recomputed-and-verified at read time
    // is reported. We intentionally do NOT fall back to the stored hash,
    // because the stored value cannot be claimed as "verified at read time".
    const verifiedHash =
      typeof input.sha256 === "string" && input.sha256.length === 64
        ? input.sha256
        : null;
    return {
      executionLogId: r.executionLogId,
      artifactId: r.artifactId!,
      artifactSha256: verifiedHash,
      artifactKind: r.artifactKind,
      artifactFilename: r.artifactFilename,
      toolName: r.toolName,
      analysisStepId: r.analysisStepId,
      readAt: r.readAt.toISOString(),
      ok: r.error === null,
      error: r.error,
    };
  });

  res.json({
    caseId,
    artifactCount: seenArtifacts.size,
    readCount: entries.length,
    entries,
  });
});

export default router;
