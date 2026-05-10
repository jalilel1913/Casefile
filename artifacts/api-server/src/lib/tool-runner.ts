import {
  db,
  executionLogsTable,
  loadVerifiedArtifact,
  type VerifiedArtifact,
} from "@workspace/db";
import { invokeTool, type ToolName } from "@workspace/sift-tools";

const CONTENT_CONSUMING_TOOLS = new Set<ToolName>([
  "logParser",
  "iocExtractor",
  "entropyScanner",
]);

export interface RunToolOnArtifactArgs {
  caseId: string;
  artifactId: string;
  toolName: ToolName;
  extraInput?: Record<string, unknown>;
  analysisStepId?: string;
}

export interface RunToolArgs {
  caseId: string;
  toolName: ToolName;
  input: Record<string, unknown>;
  analysisStepId?: string;
}

export interface ToolRunResult {
  ok: boolean;
  toolName: ToolName;
  artifactId: string | null;
  verifiedHash: string | null;
  output: unknown;
  error: string | null;
  startedAt: Date;
  endedAt: Date;
  executionLogId: string;
}

/**
 * Run a content-consuming tool against a stored artifact. The artifact is
 * loaded via `loadVerifiedArtifact` (which checks SHA-256), the verified
 * content is injected into the tool input as `content`, the tool is invoked
 * through the Zod-validated registry, and the result is recorded in
 * `execution_logs` for the chain of custody.
 *
 * The agent never gets to type artifact content directly; it can only point
 * at an artifact by id. This is the architectural boundary that prevents
 * fabricated evidence from ever reaching a tool.
 */
export async function runToolOnArtifact(
  args: RunToolOnArtifactArgs,
): Promise<ToolRunResult> {
  const { caseId, artifactId, toolName, extraInput, analysisStepId } = args;
  if (!CONTENT_CONSUMING_TOOLS.has(toolName)) {
    throw new Error(
      `Tool '${toolName}' does not consume artifact content; use runTool() instead`,
    );
  }
  const startedAt = new Date();
  let verified: VerifiedArtifact | null = null;
  let output: unknown = null;
  let errorMessage: string | null = null;
  let ok = false;
  try {
    verified = await loadVerifiedArtifact(artifactId);
    if (verified.artifact.caseId !== caseId) {
      throw new Error(
        `Artifact ${artifactId} does not belong to case ${caseId} (belongs to ${verified.artifact.caseId})`,
      );
    }
    const input = { ...(extraInput ?? {}), content: verified.artifact.content };
    const result = await invokeTool(toolName, input);
    if (result.ok) {
      ok = true;
      output = result.data;
    } else {
      errorMessage = result.error;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  const endedAt = new Date();

  const loggedInput = {
    artifactId,
    sha256: verified?.verifiedHash ?? null,
    extraInput: extraInput ?? {},
  };
  const [logRow] = await db
    .insert(executionLogsTable)
    .values({
      caseId,
      analysisStepId: analysisStepId ?? null,
      artifactId,
      toolName,
      input: loggedInput,
      output: ok ? (output as object) : { error: errorMessage },
      startedAt,
      endedAt,
      error: errorMessage,
    })
    .returning({ id: executionLogsTable.id });

  return {
    ok,
    toolName,
    artifactId,
    verifiedHash: verified?.verifiedHash ?? null,
    output,
    error: errorMessage,
    startedAt,
    endedAt,
    executionLogId: logRow.id,
  };
}

/**
 * Run a structured tool (timelineBuilder, networkAnalyzer, mcpFetcher) that
 * does not consume artifact content directly. Still writes an execution_logs
 * row so every tool invocation is auditable.
 */
export async function runTool(args: RunToolArgs): Promise<ToolRunResult> {
  const { caseId, toolName, input, analysisStepId } = args;
  if (CONTENT_CONSUMING_TOOLS.has(toolName)) {
    throw new Error(
      `Tool '${toolName}' must be run via runToolOnArtifact() so the content is verified`,
    );
  }
  const startedAt = new Date();
  let output: unknown = null;
  let errorMessage: string | null = null;
  let ok = false;
  try {
    const result = await invokeTool(toolName, input);
    if (result.ok) {
      ok = true;
      output = result.data;
    } else {
      errorMessage = result.error;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  const endedAt = new Date();

  const [logRow] = await db
    .insert(executionLogsTable)
    .values({
      caseId,
      analysisStepId: analysisStepId ?? null,
      artifactId: null,
      toolName,
      input,
      output: ok ? (output as object) : { error: errorMessage },
      startedAt,
      endedAt,
      error: errorMessage,
    })
    .returning({ id: executionLogsTable.id });

  return {
    ok,
    toolName,
    artifactId: null,
    verifiedHash: null,
    output,
    error: errorMessage,
    startedAt,
    endedAt,
    executionLogId: logRow.id,
  };
}
