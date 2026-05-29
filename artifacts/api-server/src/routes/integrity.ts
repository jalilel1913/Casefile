import {
  caseArtifactsTable,
  casesTable,
  db,
  executionLogsTable,
} from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { requireCaseAccessId } from "../lib/case-auth";

const router: IRouter = Router();

router.get("/cases/:caseId/chain-of-custody", async (req, res) => {
  const { caseId } = req.params;
  await requireCaseAccessId(caseId, req.user!.id);

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
