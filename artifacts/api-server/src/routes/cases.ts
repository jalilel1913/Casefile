import {
  analysisStepsTable,
  caseArtifactsTable,
  casesTable,
  db,
  executionLogsTable,
  incidentReportsTable,
} from "@workspace/db";
import { asc, desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreateArtifactBody,
  CreateCaseBody,
} from "@workspace/api-zod";
import { BadRequestError, NotFoundError, PayloadTooLargeError } from "../lib/errors";
import { sha256Hex, sha256HexBytes, utf8ByteLength } from "../lib/hash";
import { requireCaseAccess, requireCaseAccessId } from "../lib/case-auth";

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024; // 10 MB (text)
const MAX_BINARY_BYTES = 64 * 1024 * 1024; // 64 MB (decoded base64)
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const router: IRouter = Router();

router.post("/cases", async (req, res) => {
  const body = CreateCaseBody.parse(req.body);
  const [created] = await db
    .insert(casesTable)
    .values({ ...body, ownerUserId: req.user!.id })
    .returning();
  res.status(201).json(created);
});

router.get("/cases", async (req, res) => {
  const userId = req.user!.id;
  const rows = await db
    .select()
    .from(casesTable)
    .where(eq(casesTable.ownerUserId, userId))
    .orderBy(desc(casesTable.createdAt))
    .limit(200);
  res.json(rows);
});

router.get("/cases/:caseId", async (req, res) => {
  const { caseId } = req.params;
  const caseRow = await requireCaseAccess(caseId, req.user!.id);

  const [artifacts, steps, logs, [report]] = await Promise.all([
    db
      .select({
        id: caseArtifactsTable.id,
        caseId: caseArtifactsTable.caseId,
        kind: caseArtifactsTable.kind,
        filename: caseArtifactsTable.filename,
        sha256Hash: caseArtifactsTable.sha256Hash,
        sizeBytes: caseArtifactsTable.sizeBytes,
        createdAt: caseArtifactsTable.createdAt,
      })
      .from(caseArtifactsTable)
      .where(eq(caseArtifactsTable.caseId, caseId))
      .orderBy(asc(caseArtifactsTable.createdAt)),
    db
      .select()
      .from(analysisStepsTable)
      .where(eq(analysisStepsTable.caseId, caseId))
      .orderBy(asc(analysisStepsTable.stepNumber)),
    db
      .select()
      .from(executionLogsTable)
      .where(eq(executionLogsTable.caseId, caseId))
      .orderBy(asc(executionLogsTable.startedAt)),
    db
      .select()
      .from(incidentReportsTable)
      .where(eq(incidentReportsTable.caseId, caseId))
      .limit(1),
  ]);

  res.json({
    case: caseRow,
    artifacts,
    steps,
    logs,
    report: report ?? null,
  });
});

router.delete("/cases/:caseId", async (req, res) => {
  const { caseId } = req.params;
  await requireCaseAccessId(caseId, req.user!.id);
  await db.delete(casesTable).where(eq(casesTable.id, caseId));
  res.status(204).send();
});

router.post("/cases/:caseId/artifacts", async (req, res) => {
  const { caseId } = req.params;
  const body = CreateArtifactBody.parse(req.body);
  const encoding = body.contentEncoding ?? "text";

  if (encoding === "base64" && !BASE64_RE.test(body.content)) {
    throw new BadRequestError(
      "invalid_base64",
      "content is not valid base64",
    );
  }

  let storedHash: string;
  let sizeBytes: number;
  if (encoding === "base64") {
    const decoded = Buffer.from(body.content, "base64");
    sizeBytes = decoded.length;
    if (sizeBytes > MAX_BINARY_BYTES) {
      throw new PayloadTooLargeError(
        "artifact_too_large",
        `Decoded binary content (${sizeBytes} bytes) exceeds the 64 MB limit`,
        { sizeBytes, maxBytes: MAX_BINARY_BYTES },
      );
    }
    storedHash = sha256HexBytes(decoded);
  } else {
    sizeBytes = utf8ByteLength(body.content);
    if (sizeBytes > MAX_ARTIFACT_BYTES) {
      throw new PayloadTooLargeError(
        "artifact_too_large",
        `Artifact content (${sizeBytes} bytes) exceeds the 10 MB limit`,
        { sizeBytes, maxBytes: MAX_ARTIFACT_BYTES },
      );
    }
    storedHash = sha256Hex(body.content);
  }

  if (body.kind === "disk_image" && encoding !== "base64") {
    throw new BadRequestError(
      "invalid_disk_image_encoding",
      "disk_image artifacts must be uploaded with contentEncoding=base64",
    );
  }
  if (body.kind === "mcp_endpoint") {
    if (encoding !== "text") {
      throw new BadRequestError(
        "invalid_mcp_endpoint",
        "mcp_endpoint content must be text, not base64",
      );
    }
    try {
      new URL(body.content);
    } catch {
      throw new BadRequestError(
        "invalid_mcp_endpoint",
        "MCP endpoint content must be a valid URL",
      );
    }
  }

  await requireCaseAccessId(caseId, req.user!.id);

  const [created] = await db
    .insert(caseArtifactsTable)
    .values({
      caseId,
      kind: body.kind,
      filename: body.filename ?? null,
      content: body.content,
      contentEncoding: encoding,
      sha256Hash: storedHash,
      sizeBytes,
    })
    .returning({
      id: caseArtifactsTable.id,
      caseId: caseArtifactsTable.caseId,
      kind: caseArtifactsTable.kind,
      filename: caseArtifactsTable.filename,
      sha256Hash: caseArtifactsTable.sha256Hash,
      sizeBytes: caseArtifactsTable.sizeBytes,
      createdAt: caseArtifactsTable.createdAt,
    });

  res.status(201).json(created);
});

router.get("/cases/:caseId/artifacts", async (req, res) => {
  const { caseId } = req.params;
  await requireCaseAccessId(caseId, req.user!.id);

  const rows = await db
    .select({
      id: caseArtifactsTable.id,
      caseId: caseArtifactsTable.caseId,
      kind: caseArtifactsTable.kind,
      filename: caseArtifactsTable.filename,
      sha256Hash: caseArtifactsTable.sha256Hash,
      sizeBytes: caseArtifactsTable.sizeBytes,
      createdAt: caseArtifactsTable.createdAt,
    })
    .from(caseArtifactsTable)
    .where(eq(caseArtifactsTable.caseId, caseId))
    .orderBy(asc(caseArtifactsTable.createdAt));

  res.json(rows);
});

router.get("/cases/:caseId/steps", async (req, res) => {
  const { caseId } = req.params;
  await requireCaseAccessId(caseId, req.user!.id);

  const rows = await db
    .select()
    .from(analysisStepsTable)
    .where(eq(analysisStepsTable.caseId, caseId))
    .orderBy(asc(analysisStepsTable.stepNumber));

  res.json(rows);
});

router.get("/cases/:caseId/logs", async (req, res) => {
  const { caseId } = req.params;
  await requireCaseAccessId(caseId, req.user!.id);

  const rows = await db
    .select()
    .from(executionLogsTable)
    .where(eq(executionLogsTable.caseId, caseId))
    .orderBy(asc(executionLogsTable.startedAt));

  res.json(rows);
});

router.get("/cases/:caseId/report", async (req, res) => {
  const { caseId } = req.params;
  await requireCaseAccessId(caseId, req.user!.id);

  const [report] = await db
    .select()
    .from(incidentReportsTable)
    .where(eq(incidentReportsTable.caseId, caseId));
  if (!report) {
    throw new NotFoundError(
      "report_not_found",
      `No incident report exists for case ${caseId}`,
    );
  }
  res.json(report);
});

export default router;
