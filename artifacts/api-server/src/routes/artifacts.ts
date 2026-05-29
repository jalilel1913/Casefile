import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  loadVerifiedArtifact,
} from "@workspace/db";
import { db, caseArtifactsTable, casesTable } from "@workspace/db";
import { and, eq, isNull, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { HttpError, NotFoundError } from "../lib/errors";

const router: IRouter = Router();

router.get("/artifacts/:artifactId", async (req, res) => {
  const { artifactId } = req.params;
  const userId = req.user!.id;

  const [row] = await db
    .select({ caseOwnerId: casesTable.ownerUserId })
    .from(caseArtifactsTable)
    .innerJoin(casesTable, eq(casesTable.id, caseArtifactsTable.caseId))
    .where(eq(caseArtifactsTable.id, artifactId));

  if (!row) {
    throw new NotFoundError("artifact_not_found", `Artifact ${artifactId} not found`);
  }

  if (row.caseOwnerId !== null && row.caseOwnerId !== userId) {
    throw new NotFoundError("artifact_not_found", `Artifact ${artifactId} not found`);
  }

  try {
    const verified = await loadVerifiedArtifact(artifactId);
    res.json({
      ...verified.artifact,
      verifiedAt: verified.verifiedAt.toISOString(),
      verifiedHash: verified.verifiedHash,
    });
  } catch (err) {
    if (err instanceof ArtifactNotFoundError) {
      throw new NotFoundError(err.code, err.message);
    }
    if (err instanceof ArtifactIntegrityError) {
      throw new HttpError(422, err.code, err.message, {
        artifactId: err.artifactId,
        storedHash: err.storedHash,
        computedHash: err.computedHash,
      });
    }
    throw err;
  }
});

export default router;
