import {
  analysisStepsTable,
  caseArtifactsTable,
  db,
  incidentReportsTable,
} from "@workspace/db";
import type { ToolName } from "@workspace/sift-tools";
import { and, desc, eq } from "drizzle-orm";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { runTool, runToolOnArtifact, type ToolRunResult } from "./tool-runner.js";

// ---------- LLM-facing tool argument schemas ----------

const ListArtifactsArgs = z.object({}).strict();

const ArtifactRefArgs = z
  .object({
    artifact_id: z
      .string()
      .uuid()
      .describe("Artifact id, exactly as returned by list_artifacts"),
  })
  .strict();

const BuildTimelineArgs = z
  .object({
    events: z
      .array(
        z.object({
          timestamp: z
            .string()
            .describe("ISO-8601 or syslog-style timestamp (e.g. 'Apr 26 22:13:55')"),
          label: z
            .string()
            .describe(
              "Short event label, e.g. 'auth_failure', 'process_start', 'network_egress'",
            ),
          source: z
            .string()
            .nullish()
            .describe("Hostname or other source of the event"),
        }),
      )
      .min(1),
  })
  .strict();

const AnalyzeNetworkArgs = z
  .object({
    connections: z
      .array(
        z.object({
          ip: z.string(),
          port: z.number().int().min(0).max(65535),
          protocol: z.enum(["tcp", "udp"]).nullish(),
          bytes: z.number().int().nonnegative().nullish(),
        }),
      )
      .min(1),
  })
  .strict();

/**
 * Strict allowlist of hostname suffixes that fetch_url may contact.
 * Only well-known, read-only threat-intel services are permitted.
 * No free-form external hosts are allowed — this prevents prompt-injection
 * attacks that try to exfiltrate case data to attacker-controlled servers.
 */
const FETCH_URL_ALLOWED_HOSTS = new Set([
  "otx.alienvault.com",
  "ipinfo.io",
  "api.ipinfo.io",
  "ipapi.co",
  "api.abuseipdb.com",
  "www.virustotal.com",
  "virustotal.com",
  "threatfox-api.abuse.ch",
  "urlhaus-api.abuse.ch",
  "hashlookup.circl.lu",
  "mb-api.abuse.ch",
  "malpedia.caad.fkie.fraunhofer.de",
]);

function assertAllowedFetchHost(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL supplied to fetch_url`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!FETCH_URL_ALLOWED_HOSTS.has(hostname)) {
    throw new Error(
      `fetch_url destination '${hostname}' is not on the approved threat-intel allowlist. ` +
        `Permitted hosts: ${[...FETCH_URL_ALLOWED_HOSTS].join(", ")}`,
    );
  }
}

const FetchUrlArgs = z
  .object({
    url: z
      .string()
      .url()
      .refine((u) => u.startsWith("https://"), {
        message: "fetch_url only accepts https:// URLs",
      })
      .describe(
        "Full https URL to a permitted threat-intel endpoint. " +
          "Only GET requests are issued. " +
          "Permitted hosts: otx.alienvault.com, ipinfo.io, api.ipinfo.io, ipapi.co, " +
          "api.abuseipdb.com, virustotal.com, www.virustotal.com, threatfox-api.abuse.ch, " +
          "urlhaus-api.abuse.ch, hashlookup.circl.lu, mb-api.abuse.ch, " +
          "malpedia.caad.fkie.fraunhofer.de. " +
          "Example: https://otx.alienvault.com/api/v1/indicators/IPv4/<ip>/general",
      ),
  })
  .strict();

const PHASES = ["triage", "deep_analysis", "synthesis", "self_correction"] as const;

const RecordFindingArgs = z
  .object({
    phase: z.enum(PHASES),
    rationale: z
      .string()
      .min(1)
      .describe("Why you ran the tool / why this step exists"),
    expected: z
      .string()
      .min(1)
      .describe("What you hypothesised before running the tool"),
    found: z
      .string()
      .min(1)
      .describe(
        "What the tool actually returned. Cite specific values (IPs, hashes, etc.) from prior tool results.",
      ),
    next_step: z
      .string()
      .min(1)
      .describe(
        "What you intend to do next. Use 'finalize' if you are about to conclude.",
      ),
    tool_used: z.string().nullish(),
  })
  .strict();

const SEVERITIES = ["informational", "low", "medium", "high", "critical"] as const;

const FinalizeArgs = z
  .object({
    summary: z
      .string()
      .min(1)
      .describe("Plain-language incident summary, 2-6 sentences"),
    severity: z
      .enum(SEVERITIES)
      .describe(
        "Incident severity. informational = no impact / false positive; low = limited impact, contained; medium = single host or account compromised; high = multiple hosts/accounts or sensitive data exposure; critical = active exfil, ransomware, or domain-wide compromise.",
      ),
    iocs: z
      .array(
        z.object({
          type: z.enum(["ip", "domain", "hash", "url", "user", "other"]),
          value: z.string(),
          context: z.string().nullish(),
        }),
      )
      .default([]),
    ttps: z
      .array(
        z.object({
          id: z
            .string()
            .nullish()
            .describe("MITRE ATT&CK technique id, e.g. T1110.001"),
          name: z.string(),
          evidence: z.string(),
        }),
      )
      .default([]),
    timeline: z
      .array(
        z.object({
          timestamp: z.string(),
          event: z.string(),
        }),
      )
      .default([]),
    recommendations: z.array(z.string()).default([]),
    confidence_score: z
      .number()
      .min(0)
      .max(1)
      .describe("0.00–1.00; how confident you are in the conclusions"),
  })
  .strict();

// ---------- Tool table ----------

type AgentToolName =
  | "list_artifacts"
  | "parse_log"
  | "extract_iocs"
  | "scan_entropy"
  | "analyze_disk_image"
  | "build_timeline"
  | "analyze_network"
  | "fetch_url"
  | "record_finding"
  | "finalize";

interface AgentToolDef {
  name: AgentToolName;
  description: string;
  schema: z.ZodType<unknown>;
  // SIFT tool name (if this is a wrapper over a sift-tool); used only for the
  // record_finding `tool_used` field hint and chain-of-custody display.
  underlyingTool?: ToolName;
}

const TOOLS: AgentToolDef[] = [
  {
    name: "list_artifacts",
    description:
      "List every evidence artifact in the current case. Returns id, kind, filename, size, and stored sha256. Does not return content — to read content, call parse_log / extract_iocs / scan_entropy on the artifact id.",
    schema: ListArtifactsArgs,
  },
  {
    name: "parse_log",
    description:
      "Parse a log-file artifact into structured events (timestamp, action, user, ip).",
    schema: ArtifactRefArgs,
    underlyingTool: "logParser",
  },
  {
    name: "extract_iocs",
    description:
      "Scan an artifact's text content for indicators of compromise: IPs, domains, file hashes, URLs, email addresses.",
    schema: ArtifactRefArgs,
    underlyingTool: "iocExtractor",
  },
  {
    name: "scan_entropy",
    description:
      "Compute Shannon entropy of an artifact. High entropy (> ~7.5) suggests encryption, compression, or packed malware.",
    schema: ArtifactRefArgs,
    underlyingTool: "entropyScanner",
  },
  {
    name: "analyze_disk_image",
    description:
      "Parse a raw disk-image artifact (.img / .dd / .raw). Detects filesystem signatures (NTFS, FAT, ext, ISO9660), MBR or GPT partition table with each partition's type and LBA range, extracts printable ASCII strings, and surfaces embedded IPv4 addresses, domains, and URLs found in those strings. Only valid against artifacts of kind 'disk_image'.",
    schema: ArtifactRefArgs,
    underlyingTool: "diskImageAnalyzer",
  },
  {
    name: "build_timeline",
    description:
      "Sort events into chronological order and return the ordered timeline. Pass events you have already obtained from parse_log results.",
    schema: BuildTimelineArgs,
    underlyingTool: "timelineBuilder",
  },
  {
    name: "analyze_network",
    description:
      "Analyse a list of network connections. Flags suspicious ports and unique IPs. Pass connections you obtained from prior tool results.",
    schema: AnalyzeNetworkArgs,
    underlyingTool: "networkAnalyzer",
  },
  {
    name: "fetch_url",
    description:
      "Fetch an external http(s) URL and return the response body as text along with status code and content-type. The only network tool. Useful for enriching indicators against public, no-auth threat-intel or geolocation endpoints. Has a 10s timeout and ~500KB response cap. Refuses private/loopback hosts (SSRF protection).",
    schema: FetchUrlArgs,
    underlyingTool: "mcpFetcher",
  },
  {
    name: "record_finding",
    description:
      "Record a single analyst observation in the case file. Use this for every significant conclusion you draw from a tool result.",
    schema: RecordFindingArgs,
  },
  {
    name: "finalize",
    description:
      "Write the final incident report and end the investigation. Call exactly once, when you have enough evidence to conclude.",
    schema: FinalizeArgs,
  },
];

export function buildOpenAiTools(): ChatCompletionTool[] {
  return TOOLS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.schema, {
        target: "openAi",
      }) as Record<string, unknown>,
      strict: false,
    },
  }));
}

// ---------- Dispatch result ----------

export type DispatchResult =
  | { kind: "tool_result"; ok: boolean; data: unknown; runResult?: ToolRunResult }
  | { kind: "finding"; analysisStepId: string; step: number }
  | { kind: "finalized"; reportId: string }
  | { kind: "error"; message: string };

export interface DispatchContext {
  caseId: string;
}

export async function dispatchToolCall(
  name: string,
  rawArgs: string,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) {
    return { kind: "error", message: `Unknown tool '${name}'` };
  }
  let parsedArgsInput: unknown;
  try {
    parsedArgsInput = rawArgs ? JSON.parse(rawArgs) : {};
  } catch (e) {
    return {
      kind: "error",
      message: `Could not parse arguments for '${name}': ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
  const parsed = def.schema.safeParse(parsedArgsInput);
  if (!parsed.success) {
    return {
      kind: "error",
      message: `Invalid arguments for '${name}': ${parsed.error.message}`,
    };
  }

  switch (def.name) {
    case "list_artifacts":
      return dispatchListArtifacts(ctx);
    case "parse_log":
    case "extract_iocs":
    case "scan_entropy":
    case "analyze_disk_image": {
      const args = parsed.data as z.infer<typeof ArtifactRefArgs>;
      return dispatchArtifactTool(def.underlyingTool!, args.artifact_id, ctx);
    }
    case "build_timeline": {
      const args = parsed.data as z.infer<typeof BuildTimelineArgs>;
      return dispatchStructuredTool(def.underlyingTool!, args, ctx);
    }
    case "analyze_network": {
      const args = parsed.data as z.infer<typeof AnalyzeNetworkArgs>;
      return dispatchStructuredTool(def.underlyingTool!, args, ctx);
    }
    case "fetch_url": {
      const args = parsed.data as z.infer<typeof FetchUrlArgs>;
      assertAllowedFetchHost(args.url);
      return dispatchStructuredTool(def.underlyingTool!, {
        url: args.url,
        method: "GET",
        allowedHosts: FETCH_URL_ALLOWED_HOSTS,
      }, ctx);
    }
    case "record_finding": {
      const args = parsed.data as z.infer<typeof RecordFindingArgs>;
      return dispatchRecordFinding(args, ctx);
    }
    case "finalize": {
      const args = parsed.data as z.infer<typeof FinalizeArgs>;
      return dispatchFinalize(args, ctx);
    }
  }
}

async function dispatchListArtifacts(
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const rows = await db
    .select({
      id: caseArtifactsTable.id,
      kind: caseArtifactsTable.kind,
      filename: caseArtifactsTable.filename,
      size_bytes: caseArtifactsTable.sizeBytes,
      sha256: caseArtifactsTable.sha256Hash,
    })
    .from(caseArtifactsTable)
    .where(eq(caseArtifactsTable.caseId, ctx.caseId));
  return { kind: "tool_result", ok: true, data: { artifacts: rows } };
}

async function dispatchArtifactTool(
  toolName: ToolName,
  artifactId: string,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const runResult = await runToolOnArtifact({
    caseId: ctx.caseId,
    artifactId,
    toolName,
  });
  return {
    kind: "tool_result",
    ok: runResult.ok,
    data: runResult.ok
      ? {
          execution_log_id: runResult.executionLogId,
          verified_hash: runResult.verifiedHash,
          output: runResult.output,
        }
      : { error: runResult.error },
    runResult,
  };
}

async function dispatchStructuredTool(
  toolName: ToolName,
  input: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const runResult = await runTool({
    caseId: ctx.caseId,
    toolName,
    input,
  });
  return {
    kind: "tool_result",
    ok: runResult.ok,
    data: runResult.ok
      ? {
          execution_log_id: runResult.executionLogId,
          output: runResult.output,
        }
      : { error: runResult.error },
    runResult,
  };
}

async function dispatchRecordFinding(
  args: z.infer<typeof RecordFindingArgs>,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  // Atomically compute next step_number for this case.
  const [maxRow] = await db
    .select({ stepNumber: analysisStepsTable.stepNumber })
    .from(analysisStepsTable)
    .where(eq(analysisStepsTable.caseId, ctx.caseId))
    .orderBy(desc(analysisStepsTable.stepNumber))
    .limit(1);
  const nextStepNumber = (maxRow?.stepNumber ?? 0) + 1;

  const [row] = await db
    .insert(analysisStepsTable)
    .values({
      caseId: ctx.caseId,
      stepNumber: nextStepNumber,
      phase: args.phase,
      toolUsed: args.tool_used ?? null,
      rationale: args.rationale,
      expected: args.expected,
      found: args.found,
      nextStep: args.next_step,
    })
    .returning({ id: analysisStepsTable.id, stepNumber: analysisStepsTable.stepNumber });

  return { kind: "finding", analysisStepId: row.id, step: row.stepNumber };
}

async function dispatchFinalize(
  args: z.infer<typeof FinalizeArgs>,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  // incident_reports has a UNIQUE constraint on case_id; if a prior partial
  // finalize wrote a row, upsert instead of erroring.
  const existing = await db
    .select({ id: incidentReportsTable.id })
    .from(incidentReportsTable)
    .where(eq(incidentReportsTable.caseId, ctx.caseId))
    .limit(1);

  if (existing[0]) {
    await db
      .update(incidentReportsTable)
      .set({
        summary: args.summary,
        severity: args.severity,
        iocs: args.iocs,
        ttps: args.ttps,
        timeline: args.timeline,
        recommendations: args.recommendations,
        confidenceScore: args.confidence_score.toFixed(2),
      })
      .where(eq(incidentReportsTable.id, existing[0].id));
    return { kind: "finalized", reportId: existing[0].id };
  }

  const [row] = await db
    .insert(incidentReportsTable)
    .values({
      caseId: ctx.caseId,
      summary: args.summary,
      severity: args.severity,
      iocs: args.iocs,
      ttps: args.ttps,
      timeline: args.timeline,
      recommendations: args.recommendations,
      confidenceScore: args.confidence_score.toFixed(2),
    })
    .returning({ id: incidentReportsTable.id });

  // Touch the placeholder so the compiler does not complain about and/eq
  // when this branch ships isolated.
  void and;
  return { kind: "finalized", reportId: row.id };
}
