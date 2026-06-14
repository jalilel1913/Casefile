import { casesTable, db } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { ArtifactIntegrityError } from "@workspace/db";
import { eq } from "drizzle-orm";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import {
  buildOpenAiTools,
  dispatchToolCall,
  type DispatchResult,
} from "./tool-adapter.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";

export const DEFAULT_MODEL = process.env.SIFT_AGENT_MODEL ?? "gpt-5.4";
export const DEFAULT_MAX_ITERATIONS = 25;
export const DEFAULT_MAX_TOKENS = 200_000;
// Hard cap on the JSON length of a single tool-result message added to the LLM
// conversation. The full payload is always preserved in `execution_logs`; this
// only bounds what re-enters the model context to prevent runaway token growth
// from e.g. a large fetch_url body or a verbose parser output.
const MAX_TOOL_RESULT_CHARS = 8_000;

function truncateForLlm(value: unknown): string {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  if (json.length <= MAX_TOOL_RESULT_CHARS) return json;
  const head = json.slice(0, MAX_TOOL_RESULT_CHARS);
  const omitted = json.length - MAX_TOOL_RESULT_CHARS;
  return (
    head +
    `\n…[truncated ${omitted} chars of tool output; the full payload is preserved in execution_logs and can be queried via /cases/:caseId/logs]`
  );
}

export interface RunInvestigationArgs {
  caseId: string;
  model?: string;
  maxIterations?: number;
  maxTokens?: number;
  /**
   * Called whenever the loop checks for cancellation. Return `true` to abort
   * the loop after the current iteration completes.
   */
  isCancelled?: () => boolean;
}

export type AgentEvent =
  | { type: "started"; caseId: string; model: string; iterationLimit: number }
  | { type: "iteration"; iteration: number }
  | { type: "thinking"; text: string }
  | {
      type: "tool_call";
      iteration: number;
      toolCallId: string;
      name: string;
      args: unknown;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      name: string;
      ok: boolean;
      executionLogId?: string;
      verifiedHash?: string | null;
      summary: string;
    }
  | {
      type: "finding";
      analysisStepId: string;
      step: number;
      phase: string;
      found: string;
    }
  | { type: "finalized"; reportId: string }
  | { type: "tokens"; promptTokens: number; completionTokens: number; total: number }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "done"; reason: "finalized" | "max_iterations" | "max_tokens" | "cancelled" | "error" };

/**
 * Runs the autonomous investigation loop for a single case. Yields a stream
 * of typed events that callers (typically an SSE route) forward to the client.
 *
 * Termination conditions, in priority order:
 *   1. The agent calls `finalize` → "finalized"
 *   2. The cancellation callback returns true → "cancelled"
 *   3. iteration count > maxIterations → "max_iterations" (forces summary pass)
 *   4. token usage > maxTokens → "max_tokens" (forces summary pass)
 *   5. A non-recoverable error → "error"
 */
export async function* runInvestigation(
  args: RunInvestigationArgs,
): AsyncGenerator<AgentEvent, void, void> {
  const {
    caseId,
    model = DEFAULT_MODEL,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    maxTokens = DEFAULT_MAX_TOKENS,
    isCancelled,
  } = args;

  // Sanity-check the case exists so we don't waste tokens on a bogus id.
  const [caseRow] = await db
    .select({ id: casesTable.id, title: casesTable.title, description: casesTable.description })
    .from(casesTable)
    .where(eq(casesTable.id, caseId));
  if (!caseRow) {
    yield {
      type: "error",
      message: `Case ${caseId} not found`,
      fatal: true,
    };
    yield { type: "done", reason: "error" };
    return;
  }

  yield {
    type: "started",
    caseId,
    model,
    iterationLimit: maxIterations,
  };

  const { tools, remoteToolNames } = await buildOpenAiTools();
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Case ${caseRow.id}\nTitle: ${caseRow.title}\n` +
        `Description: ${caseRow.description ?? "(none)"}\n\n` +
        `Investigate this case. Start by calling list_artifacts.`,
    },
  ];

  let iteration = 0;
  let totalTokens = 0;
  let finalized = false;
  let forcedSummaryPass = false;
  let stopReason: AgentEvent & { type: "done" } = { type: "done", reason: "error" };

  while (iteration < maxIterations) {
    iteration += 1;
    if (isCancelled?.()) {
      stopReason = { type: "done", reason: "cancelled" };
      break;
    }
    yield { type: "iteration", iteration };

    let response;
    try {
      // On the forced summary pass we restrict the tool surface to `finalize`
      // only and require a tool call so the model cannot keep doing analysis
      // after the token budget is blown.
      const iterationTools = forcedSummaryPass
        ? tools.filter(
            (t) => t.type === "function" && t.function.name === "finalize",
          )
        : tools;
      const iterationToolChoice: "auto" | "required" = forcedSummaryPass
        ? "required"
        : "auto";
      response = await openai.chat.completions.create({
        model,
        messages,
        tools: iterationTools,
        tool_choice: iterationToolChoice,
      });
    } catch (err) {
      yield {
        type: "error",
        message: `LLM call failed at iteration ${iteration}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        fatal: true,
      };
      stopReason = { type: "done", reason: "error" };
      break;
    }

    const choice = response.choices[0];
    const usage = response.usage;
    if (usage) {
      totalTokens += usage.total_tokens ?? 0;
      yield {
        type: "tokens",
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        total: totalTokens,
      };
    }
    if (!choice) {
      yield {
        type: "error",
        message: `LLM returned no choices at iteration ${iteration}`,
        fatal: true,
      };
      stopReason = { type: "done", reason: "error" };
      break;
    }

    const message = choice.message;
    const text =
      typeof message.content === "string" && message.content.trim()
        ? message.content.trim()
        : null;
    if (text) {
      yield { type: "thinking", text };
    }

    const toolCalls = (message.tool_calls ?? []) as ChatCompletionMessageToolCall[];

    // Append the assistant message verbatim — required for tool-result messages
    // to be valid in the next turn.
    messages.push({
      role: "assistant",
      content: message.content ?? null,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    });

    if (!toolCalls.length) {
      // No tool calls and no termination — nudge the agent to act.
      messages.push({
        role: "user",
        content:
          "You did not call a tool. Either call a tool or call `finalize` to end the investigation.",
      });
      continue;
    }

    for (const tc of toolCalls) {
      if (tc.type !== "function") {
        continue;
      }
      const argsRaw = tc.function.arguments ?? "";
      let parsedArgsForEvent: unknown = argsRaw;
      try {
        parsedArgsForEvent = argsRaw ? JSON.parse(argsRaw) : {};
      } catch {
        // leave as string
      }
      yield {
        type: "tool_call",
        iteration,
        toolCallId: tc.id,
        name: tc.function.name,
        args: parsedArgsForEvent,
      };

      let dispatch: DispatchResult;
      let spoliationHalt = false;
      try {
        dispatch = await dispatchToolCall(tc.function.name, argsRaw, {
          caseId,
          remoteToolNames,
        });
      } catch (err) {
        // ArtifactIntegrityError is a non-recoverable spoliation signal: the
        // stored hash did not match the recomputed hash. The investigation
        // MUST halt — anything else would be analyzing tampered evidence.
        if (err instanceof ArtifactIntegrityError) {
          spoliationHalt = true;
          dispatch = {
            kind: "error",
            message:
              `SPOLIATION: artifact ${err.artifactId} failed integrity check ` +
              `(stored ${err.storedHash.slice(0, 12)}…, computed ${err.computedHash.slice(0, 12)}…). ` +
              `Halting investigation.`,
          };
        } else {
          dispatch = {
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }

      // Build the tool message content the LLM will see in the next turn.
      let toolResultContent: unknown;
      let summaryForEvent = "ok";

      switch (dispatch.kind) {
        case "tool_result":
          toolResultContent = dispatch.data;
          summaryForEvent = dispatch.ok ? "ok" : "tool_failed";
          yield {
            type: "tool_result",
            toolCallId: tc.id,
            name: tc.function.name,
            ok: dispatch.ok,
            executionLogId: dispatch.runResult?.executionLogId,
            verifiedHash: dispatch.runResult?.verifiedHash,
            summary: summaryForEvent,
          };
          break;
        case "finding":
          toolResultContent = {
            recorded: true,
            analysis_step_id: dispatch.analysisStepId,
            step_number: dispatch.step,
          };
          summaryForEvent = `step ${dispatch.step} recorded`;
          // Re-derive the phase/found from the original args for the UI event.
          try {
            const a = JSON.parse(argsRaw) as { phase?: string; found?: string };
            yield {
              type: "finding",
              analysisStepId: dispatch.analysisStepId,
              step: dispatch.step,
              phase: a.phase ?? "unknown",
              found: a.found ?? "",
            };
          } catch {
            // fall through silently
          }
          yield {
            type: "tool_result",
            toolCallId: tc.id,
            name: tc.function.name,
            ok: true,
            summary: summaryForEvent,
          };
          break;
        case "finalized":
          toolResultContent = { finalized: true, report_id: dispatch.reportId };
          finalized = true;
          yield { type: "finalized", reportId: dispatch.reportId };
          yield {
            type: "tool_result",
            toolCallId: tc.id,
            name: tc.function.name,
            ok: true,
            summary: "report written",
          };
          break;
        case "error":
          toolResultContent = { error: dispatch.message };
          summaryForEvent = `dispatch_error: ${dispatch.message}`;
          yield {
            type: "tool_result",
            toolCallId: tc.id,
            name: tc.function.name,
            ok: false,
            summary: summaryForEvent,
          };
          break;
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: truncateForLlm(toolResultContent),
      });

      if (spoliationHalt) {
        yield {
          type: "error",
          message: dispatch.kind === "error" ? dispatch.message : "spoliation",
          fatal: true,
        };
        stopReason = { type: "done", reason: "error" };
        // Break out of the tool-calls loop; outer loop check below will exit.
        finalized = false;
        iteration = maxIterations + 1;
        break;
      }
    }

    if (iteration > maxIterations) break;

    if (finalized) {
      stopReason = { type: "done", reason: "finalized" };
      break;
    }

    if (totalTokens >= maxTokens) {
      if (!forcedSummaryPass) {
        // First time over budget — give the agent exactly one more iteration
        // with the tool surface restricted to `finalize` (handled above).
        forcedSummaryPass = true;
        messages.push({
          role: "user",
          content:
            "You have hit the token budget. Call `finalize` immediately with whatever conclusions the existing evidence supports; do not run any more analysis tools.",
        });
      } else {
        // Forced summary pass already happened and the agent still didn't
        // finalize — abort.
        stopReason = { type: "done", reason: "max_tokens" };
        break;
      }
    }
  }

  if (!finalized && stopReason.reason === "error") {
    // Loop exited without finalize and without an error: must have hit
    // maxIterations.
    stopReason = { type: "done", reason: "max_iterations" };
  }

  yield stopReason;
}
