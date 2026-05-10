import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  loadVerifiedArtifact,
} from "@workspace/db";
import { Router, type IRouter } from "express";
import { HttpError, NotFoundError } from "../lib/errors";

const router: IRouter = Router();

router.get("/artifacts/:artifactId", async (req, res) => {
  const { artifactId } = req.params;
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
