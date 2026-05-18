import { useEffect, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCaseQueryKey,
  getListCaseStepsQueryKey,
  getListCaseLogsQueryKey,
  getGetCaseReportQueryKey,
  getGetCaseChainOfCustodyQueryKey,
  getListCasesQueryKey,
} from "@workspace/api-client-react";

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
  | {
      type: "done";
      reason: "finalized" | "max_iterations" | "max_tokens" | "cancelled" | "error";
    };

export function useInvestigationStream(caseId: string) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();

  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  const invalidateQueries = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getGetCaseQueryKey(caseId) });
    queryClient.invalidateQueries({ queryKey: getListCaseStepsQueryKey(caseId) });
    queryClient.invalidateQueries({ queryKey: getListCaseLogsQueryKey(caseId) });
    queryClient.invalidateQueries({ queryKey: getGetCaseReportQueryKey(caseId) });
    queryClient.invalidateQueries({ queryKey: getGetCaseChainOfCustodyQueryKey(caseId) });
    queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
  }, [caseId, queryClient]);

  const start = useCallback(async () => {
    stop();
    setEvents([]);
    setError(null);
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch(
        `${import.meta.env.BASE_URL}api/cases/${caseId}/investigate`,
        {
          method: "POST",
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`Failed to start investigation: ${response.statusText}`);
      }
      if (!response.body) {
        throw new Error("No response body available for streaming");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line ("\n\n" or "\r\n\r\n").
        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary !== -1) {
          const rawFrame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + (buffer[boundary] === "\r" ? 4 : 2));

          // Multi-line `data:` values are joined with newlines per SSE spec.
          const dataLines: string[] = [];
          for (const line of rawFrame.split(/\r?\n/)) {
            if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).replace(/^ /, ""));
            }
          }

          if (dataLines.length > 0) {
            const dataStr = dataLines.join("\n");
            try {
              const parsed = JSON.parse(dataStr) as AgentEvent;
              if (parsed && typeof parsed.type === "string") {
                setEvents((prev) => [...prev, parsed]);
              }
            } catch (err) {
              console.error("Failed to parse SSE event data", err, dataStr);
            }
          }

          boundary = buffer.search(/\r?\n\r?\n/);
        }
      }

      setIsStreaming(false);
      invalidateQueries();
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      if (e.name === "AbortError") {
        // Intentional cancellation — stop() already cleared isStreaming.
        return;
      }
      setError(e.message ?? "An error occurred during the investigation stream");
      setIsStreaming(false);
      invalidateQueries();
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }, [caseId, stop, invalidateQueries]);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  return { events, isStreaming, error, start, stop };
}
