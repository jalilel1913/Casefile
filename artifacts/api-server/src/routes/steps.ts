import { analysisStepsTable, casesTable, db, executionLogsTable } from "@workspace/db";
import { asc, eq, isNull, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { NotFoundError } from "../lib/errors";

const router: IRouter = Router();

router.get("/steps/:stepId/logs", async (req, res) => {
  const { stepId } = req.params;
  const userId = req.user!.id;

  const [row] = await db
    .select({ caseOwnerId: casesTable.ownerUserId })
    .from(analysisStepsTable)
    .innerJoin(casesTable, eq(casesTable.id, analysisStepsTable.caseId))
    .where(eq(analysisStepsTable.id, stepId));

  if (!row) {
    throw new NotFoundError("step_not_found", `Analysis step ${stepId} not found`);
  }

  if (row.caseOwnerId !== null && row.caseOwnerId !== userId) {
    throw new NotFoundError("step_not_found", `Analysis step ${stepId} not found`);
  }

  const rows = await db
    .select()
    .from(executionLogsTable)
    .where(eq(executionLogsTable.analysisStepId, stepId))
    .orderBy(asc(executionLogsTable.startedAt));

  res.json(rows);
});

export default router;
