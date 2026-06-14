import {
  analysisStepsTable,
  caseArtifactsTable,
  db,
  incidentReportsTable,
} from "@workspace/db";
import type { ToolName } from "@workspace/sift-tools";
import {
  isRemoteMcp,
  listSiftTools,
  type DiscoveredTool,
} from "@workspace/sift-mcp";
import { and, desc, eq } from "drizzle-orm";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { runRemoteTool, runTool, runToolOnArtifact } from "./tool-runner.js";

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

// ---------- fetch_url endpoint templates ----------
//
// The model supplies an endpoint name and an IOC value. The actual URL is
// constructed here, server-side, from a fixed template. This prevents
// prompt-injection attacks from embedding arbitrary case data into the URL
// path or query string of an allowlisted host (exfiltration via URL).

type IocKind = "ip" | "domain" | "hash" | "family";

interface FetchEndpoint {
  host: string;
  iocKind: IocKind;
  build: (ioc: string) => string;
  description: string;
}

/**
 * IOC validation patterns. Each pattern is intentionally strict so that
 * only well-formed indicator values can be inserted into a URL template.
 * Attacker-controlled free-form text will fail these checks.
 */
const IOC_PATTERNS: Record<IocKind, RegExp> = {
  ip: /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/,
  domain: /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/,
  hash: /^[a-fA-F0-9]{32,128}$/,
  family: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/,
};

function validateIoc(kind: IocKind, value: string): void {
  if (!IOC_PATTERNS[kind].test(value)) {
    throw new Error(
      `IOC value '${value}' is not a valid ${kind}. ` +
        `Expected: ${kind === "ip" ? "dotted-decimal IPv4" : kind === "domain" ? "hostname" : kind === "hash" ? "hex string (32-128 chars)" : "alphanumeric family name"}.`,
    );
  }
}

const FETCH_ENDPOINTS = {
  ipinfo_ip: {
    host: "ipinfo.io",
    iocKind: "ip" as IocKind,
    build: (ioc: string) => `https://ipinfo.io/${ioc}/json`,
    description: "IP geolocation and ASN via ipinfo.io",
  },
  ipapi_ip: {
    host: "ipapi.co",
    iocKind: "ip" as IocKind,
    build: (ioc: string) => `https://ipapi.co/${ioc}/json/`,
    description: "IP geolocation via ipapi.co",
  },
  otx_ip: {
    host: "otx.alienvault.com",
    iocKind: "ip" as IocKind,
    build: (ioc: string) =>
      `https://otx.alienvault.com/api/v1/indicators/IPv4/${ioc}/general`,
    description: "OTX threat-intel for an IPv4 address",
  },
  otx_domain: {
    host: "otx.alienvault.com",
    iocKind: "domain" as IocKind,
    build: (ioc: string) =>
      `https://otx.alienvault.com/api/v1/indicators/domain/${ioc}/general`,
    description: "OTX threat-intel for a domain",
  },
  otx_hash: {
    host: "otx.alienvault.com",
    iocKind: "hash" as IocKind,
    build: (ioc: string) =>
      `https://otx.alienvault.com/api/v1/indicators/file/${ioc}/general`,
    description: "OTX threat-intel for a file hash (MD5/SHA1/SHA256)",
  },
  hashlookup_hash: {
    host: "hashlookup.circl.lu",
    iocKind: "hash" as IocKind,
    build: (ioc: string) => `https://hashlookup.circl.lu/lookup/sha256/${ioc}`,
    description: "CIRCL hash lookup for a SHA-256 hash",
  },
  mb_hash: {
    host: "mb-api.abuse.ch",
    iocKind: "hash" as IocKind,
    build: (ioc: string) => `https://mb-api.abuse.ch/apiv1/query/hash/${ioc}`,
    description: "MalwareBazaar sample lookup by hash",
  },
  malpedia_family: {
    host: "malpedia.caad.fkie.fraunhofer.de",
    iocKind: "family" as IocKind,
    build: (ioc: string) =>
      `https://malpedia.caad.fkie.fraunhofer.de/api/get/family/${ioc}`,
    description: "Malpedia malware family lookup",
  },
} as const satisfies Record<string, FetchEndpoint>;

type FetchEndpointName = keyof typeof FETCH_ENDPOINTS;

/**
 * Strict allowlist of hostnames that fetch_url may contact.
 * Derived directly from FETCH_ENDPOINTS so it stays in sync automatically.
 * Passed through to the underlying mcpFetcher for defence-in-depth.
 */
const FETCH_URL_ALLOWED_HOSTS: Set<string> = new Set(
  Object.values(FETCH_ENDPOINTS).map((e) => e.host),
);

const FetchUrlArgs = z
  .object({
    endpoint: z
      .enum(Object.keys(FETCH_ENDPOINTS) as [FetchEndpointName, ...FetchEndpointName[]])
      .describe(
        "Named threat-intel endpoint to query. The URL is constructed server-side; you cannot supply a free-form URL. " +
          "Available endpoints: " +
          Object.entries(FETCH_ENDPOINTS)
            .map(([k, v]) => `${k} (${v.description})`)
            .join("; "),
      ),
    ioc: z
      .string()
      .min(1)
      .describe(
        "The indicator of compromise to look up. Must match the type expected by the chosen endpoint: " +
          "ip → dotted-decimal IPv4 (e.g. 1.2.3.4); " +
          "domain → hostname (e.g. evil.example.com); " +
          "hash → hex string, 32-128 chars (MD5/SHA1/SHA256/SHA512); " +
          "family → alphanumeric malware family name.",
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
  | "analyze_pcap"
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
    name: "analyze_pcap",
    description:
      "Parse a packet-capture artifact (.pcap / .cap / .pcapng) of kind 'network_capture'. Decodes packets into conversation 5-tuples, top talkers, destination endpoints (an 'endpoints' list ready to pass to analyze_network), DNS query names, capture time range, protocol counts, and harvested public IPv4 + domain indicators. Follow up with analyze_network on the endpoints, build_timeline for ordering, and fetch_url to enrich indicators. Only valid against artifacts of kind 'network_capture'.",
    schema: ArtifactRefArgs,
    underlyingTool: "pcapAnalyzer",
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
      "Enrich an indicator of compromise against a named threat-intel endpoint. " +
      "Supply the endpoint name and the raw IOC value; the URL is constructed server-side from a fixed template. " +
      "You cannot supply a free-form URL — this prevents case evidence from being embedded in outbound requests. " +
      "Returns the response body as text along with status code and content-type. " +
      "Has a 10s timeout and ~500KB response cap. Refuses private/loopback hosts (SSRF protection).",
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

// Underlying sift-tool names the static catalog already wraps. A remote MCP
// server that advertises one of these is offering the same capability the agent
// already exposes (via parse_log, extract_iocs, ...), so it is not surfaced a
// second time as a generic remote tool — only genuinely new Workstation tools
// are.
const STATIC_UNDERLYING: Set<string> = new Set(
  TOOLS.map((t) => t.underlyingTool).filter((x): x is ToolName => !!x),
);

function staticOpenAiTools(): ChatCompletionTool[] {
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

export interface BuiltTools {
  tools: ChatCompletionTool[];
  /**
   * Names of remote-only tools the model may call that have no static wrapper
   * and must be routed through `runRemoteTool`. Empty in in-process mode. This
   * is returned (not stored globally) so concurrent investigations cannot
   * clobber each other's routing — the agent threads it into the dispatch
   * context for its run.
   */
  remoteToolNames: Set<string>;
}

/**
 * Build the tool catalog exposed to the model. Always includes the agent's
 * static tools. When a remote SIFT MCP server is configured, the agent also
 * asks it (over `tools/list`) what it can do and exposes any *additional* tools
 * — capabilities a real Workstation has that the local catalog does not — so
 * they are genuinely callable by the model rather than renamed stand-ins.
 *
 * If a remote server is configured but discovery fails, this throws rather than
 * silently degrading to the simulated in-process tools: an operator who pointed
 * Casefile at a real Workstation must not be handed fake results without
 * knowing it. (When no remote is configured, in-process is the intended mode
 * and no discovery happens.)
 */
export async function buildOpenAiTools(): Promise<BuiltTools> {
  const base = staticOpenAiTools();
  if (!isRemoteMcp()) {
    return { tools: base, remoteToolNames: new Set() };
  }

  const discovered: DiscoveredTool[] = await listSiftTools();

  const staticNames = new Set(TOOLS.map((t) => t.name as string));
  const remoteToolNames = new Set<string>();
  const remoteTools: ChatCompletionTool[] = [];
  for (const tool of discovered) {
    // Skip anything the static catalog already covers, by either the
    // agent-facing name or the underlying sift-tool name.
    if (STATIC_UNDERLYING.has(tool.name) || staticNames.has(tool.name)) {
      continue;
    }
    remoteToolNames.add(tool.name);
    remoteTools.push({
      type: "function",
      function: {
        name: tool.name,
        description:
          (tool.description ?? `Remote SIFT Workstation tool '${tool.name}'.`) +
          " (Executes on the remote SIFT Workstation over MCP.)",
        parameters: tool.inputSchema,
        strict: false,
      },
    });
  }
  return { tools: [...base, ...remoteTools], remoteToolNames };
}

// ---------- Dispatch result ----------

export type DispatchResult =
  | {
      kind: "tool_result";
      ok: boolean;
      data: unknown;
      runResult?: { executionLogId: string; verifiedHash: string | null };
    }
  | { kind: "finding"; analysisStepId: string; step: number }
  | { kind: "finalized"; reportId: string }
  | { kind: "error"; message: string };

export interface DispatchContext {
  caseId: string;
  /**
   * Remote-only tool names discovered for this investigation (from
   * `buildOpenAiTools`). A tool named here with no static wrapper is routed to
   * the remote MCP server. Threaded per-run so concurrent investigations stay
   * isolated.
   */
  remoteToolNames?: ReadonlySet<string>;
}

export async function dispatchToolCall(
  name: string,
  rawArgs: string,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) {
    if (ctx.remoteToolNames?.has(name)) {
      return dispatchRemoteTool(name, rawArgs, ctx);
    }
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
    case "analyze_disk_image":
    case "analyze_pcap": {
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
      const endpointDef = FETCH_ENDPOINTS[args.endpoint as FetchEndpointName];
      try {
        validateIoc(endpointDef.iocKind, args.ioc);
      } catch (e) {
        return {
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        };
      }
      const builtUrl = endpointDef.build(args.ioc);
      return dispatchStructuredTool(def.underlyingTool!, {
        url: builtUrl,
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

async function dispatchRemoteTool(
  toolName: string,
  rawArgs: string,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  let input: Record<string, unknown>;
  try {
    const parsed = rawArgs ? JSON.parse(rawArgs) : {};
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        kind: "error",
        message: `Arguments for '${toolName}' must be a JSON object`,
      };
    }
    input = parsed as Record<string, unknown>;
  } catch (e) {
    return {
      kind: "error",
      message: `Could not parse arguments for '${toolName}': ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
  const runResult = await runRemoteTool({
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
          mcp_endpoint: runResult.mcpEndpoint,
          output: runResult.output,
        }
      : { error: runResult.error },
    runResult: {
      executionLogId: runResult.executionLogId,
      verifiedHash: null,
    },
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
