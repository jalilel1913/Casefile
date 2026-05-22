import { runInvestigation } from "@workspace/sift-agent";
import { db, casesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { Router, type IRouter } from "express";

const router: IRouter = Router();

type CaseStatus = "pending" | "analyzing" | "complete" | "failed";

async function setCaseStatus(caseId: string, status: CaseStatus) {
  await db
    .update(casesTable)
    .set({ status, updatedAt: new Date() })
    .where(eq(casesTable.id, caseId));
}

router.post("/cases/:caseId/investigate", async (req, res) => {
  const { caseId } = req.params;

  // Preflight: the OpenAPI spec advertises 404 for unknown cases, so the
  // existence check must happen BEFORE we flip the response into SSE mode.
  // Once we've sent SSE headers we can no longer return a JSON 404.
  const [caseRow] = await db
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(eq(casesTable.id, caseId));
  if (!caseRow) {
    res.status(404).json({
      error: "not_found",
      message: `Case ${caseId} not found`,
    });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let cancelled = false;
  req.on("close", () => {
    cancelled = true;
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Lifecycle: mark analyzing at start, then resolve to complete / failed
  // based on the terminal event (finalized → complete, error/spoliation →
  // failed, otherwise keep analyzing). The DB row defaults to `pending`
  // until the user actually kicks off an investigation.
  await setCaseStatus(caseId, "analyzing");
  let finalStatus: CaseStatus = "failed";

  try {
    for await (const ev of runInvestigation({
      caseId,
      isCancelled: () => cancelled,
    })) {
      send(ev.type, ev);
      if (ev.type === "finalized") {
        finalStatus = "complete";
      } else if (ev.type === "error" && ev.fatal) {
        finalStatus = "failed";
      } else if (ev.type === "done") {
        if (ev.reason === "finalized") finalStatus = "complete";
        else if (ev.reason === "error") finalStatus = "failed";
        else finalStatus = "complete";
      }
      if (cancelled) break;
    }
    if (cancelled) finalStatus = "failed";
  } catch (err) {
    req.log.error({ err, caseId }, "investigation stream crashed");
    send("error", {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      fatal: true,
    });
    send("done", { type: "done", reason: "error" });
    finalStatus = "failed";
  } finally {
    try {
      await setCaseStatus(caseId, finalStatus);
    } catch (err) {
      req.log.error({ err, caseId, finalStatus }, "failed to update final case status");
    }
    res.end();
  }
});

export default router;
