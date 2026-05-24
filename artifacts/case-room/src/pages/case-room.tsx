import { useState, useRef, useEffect, useMemo } from "react";
import { useParams, Link } from "wouter";
import {
  useGetCase,
  useListCaseArtifacts,
  useCreateArtifact,
  useGetCaseReport,
  useGetCaseChainOfCustody,
  getListCaseArtifactsQueryKey,
  getGetCaseQueryKey,
  getGetCaseReportQueryKey,
  getGetCaseChainOfCustodyQueryKey,
  ArtifactKind,
} from "@workspace/api-client-react";
import { useInvestigationStream } from "@/hooks/use-investigation-stream";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Terminal, ArrowLeft, Play, SquareSquare, FileText, Activity, Database, Lock, CheckCircle2, ChevronRight, Upload, XCircle, ArrowDown, Sparkles, Cpu } from "lucide-react";
import { format } from "date-fns";
import { ReasoningCard } from "@/components/reasoning-card";
import { LiveActivityCard } from "@/components/live-activity";
import { ExecLogPanel } from "@/components/exec-log-panel";

export default function CaseRoom() {
  const params = useParams();
  const caseId = params.id as string;
  const queryClient = useQueryClient();

  const { data: caseDetail, isLoading } = useGetCase(caseId, {
    query: {
      enabled: !!caseId,
      queryKey: getGetCaseQueryKey(caseId),
      refetchInterval: (query) => query.state.data?.case.status === 'analyzing' ? 5000 : false,
    }
  });

  const { data: artifacts } = useListCaseArtifacts(caseId, { query: { enabled: !!caseId, queryKey: getListCaseArtifactsQueryKey(caseId) } });
  const { data: report } = useGetCaseReport(caseId, { query: { enabled: !!caseId, queryKey: getGetCaseReportQueryKey(caseId) } });
  const { data: custody } = useGetCaseChainOfCustody(caseId, { query: { enabled: !!caseId, queryKey: getGetCaseChainOfCustodyQueryKey(caseId) } });

  const stream = useInvestigationStream(caseId);

  const [trainingMode, setTrainingMode] = useState(false);

  // Feed scroll lock: only auto-follow when the user is already at the bottom.
  const feedScrollRef = useRef<HTMLDivElement>(null);
  const feedEndRef = useRef<HTMLDivElement>(null);
  const [autoFollow, setAutoFollow] = useState(true);

  const handleFeedScroll = () => {
    const el = feedScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 40;
    setAutoFollow(atBottom);
  };

  const steps = useMemo(
    () =>
      [...(caseDetail?.steps ?? [])].sort((a, b) => a.stepNumber - b.stepNumber),
    [caseDetail?.steps],
  );
  const logs = caseDetail?.logs ?? [];

  // Live activity = streamed events since the last `finding` event (i.e. since
  // the agent last committed a step via record_finding). These haven't been
  // persisted to analysis_steps yet, so they don't have a reasoning card.
  const liveSlice = useMemo(() => {
    let lastFindingIdx = -1;
    let lastIteration: number | null = null;
    for (let i = 0; i < stream.events.length; i++) {
      const e = stream.events[i];
      if (e.type === "finding") lastFindingIdx = i;
      if (e.type === "iteration") lastIteration = e.iteration;
    }
    const tail = stream.events.slice(lastFindingIdx + 1).filter((e) =>
      e.type === "thinking" || e.type === "tool_call" || e.type === "tool_result" || e.type === "error",
    );
    return { events: tail, iteration: lastIteration };
  }, [stream.events]);

  const terminalEvent = useMemo(() => {
    for (let i = stream.events.length - 1; i >= 0; i--) {
      const e = stream.events[i];
      if (e.type === "done" || e.type === "finalized") return e;
    }
    return null;
  }, [stream.events]);

  // Aggregate token usage from `tokens` events for header readout (previously
  // shown inline in the terminal feed; now a compact running total).
  const tokenTotals = useMemo(() => {
    let prompt = 0;
    let completion = 0;
    let total = 0;
    for (const e of stream.events) {
      if (e.type === "tokens") {
        prompt += e.promptTokens;
        completion += e.completionTokens;
        total += e.total;
      }
    }
    return { prompt, completion, total };
  }, [stream.events]);

  useEffect(() => {
    if (!autoFollow) return;
    feedEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    // Include stream.events.length so terminal banners (finalized/done) also
    // trigger auto-follow when the user is at the bottom.
  }, [steps.length, liveSlice.events.length, stream.events.length, autoFollow]);

  const jumpToLatest = () => {
    setAutoFollow(true);
    feedEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  };

  const createArtifact = useCreateArtifact();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [artKind, setArtKind] = useState<ArtifactKind>("text");
  const [artFilename, setArtFilename] = useState("");
  const [artContent, setArtContent] = useState("");
  const [artEncoding, setArtEncoding] = useState<"text" | "base64">("text");
  const [artDecodedSize, setArtDecodedSize] = useState<number>(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const MAX_TEXT_BYTES = 10 * 1024 * 1024;
  const MAX_BINARY_BYTES = 64 * 1024 * 1024;
  const isBinaryKind = artKind === "disk_image";

  // Reset encoding state whenever the operator switches kind so we never
  // submit a text payload tagged as base64 or vice versa.
  useEffect(() => {
    setArtContent("");
    setArtDecodedSize(0);
    setArtEncoding(isBinaryKind ? "base64" : "text");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [artKind, isBinaryKind]);

  const handleFilePick = async (file: File) => {
    setUploadError(null);
    const cap = isBinaryKind ? MAX_BINARY_BYTES : MAX_TEXT_BYTES;
    if (file.size > cap) {
      setUploadError(
        `File is ${(file.size / 1024 / 1024).toFixed(1)}MB; max is ${cap / 1024 / 1024}MB.`,
      );
      return;
    }
    try {
      if (isBinaryKind) {
        const buf = await file.arrayBuffer();
        // Chunked base64 encode to avoid arguments-length overflow for big files.
        const bytes = new Uint8Array(buf);
        let bin = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        setArtContent(btoa(bin));
        setArtDecodedSize(bytes.length);
        setArtEncoding("base64");
      } else {
        const text = await file.text();
        setArtContent(text);
        setArtDecodedSize(new TextEncoder().encode(text).byteLength);
        setArtEncoding("text");
      }
      if (!artFilename) setArtFilename(file.name);
    } catch {
      setUploadError("Could not read file.");
    }
  };

  const handleUpload = (e: React.FormEvent) => {
    e.preventDefault();
    setUploadError(null);
    if (!artContent) return;
    if (isBinaryKind && artEncoding !== "base64") {
      setUploadError("Disk-image evidence must be uploaded from a file.");
      return;
    }
    let byteLength: number;
    if (artEncoding === "base64") {
      byteLength = artDecodedSize;
      if (byteLength > MAX_BINARY_BYTES) {
        setUploadError(
          `Decoded binary is ${(byteLength / 1024 / 1024).toFixed(1)}MB; max is 64MB.`,
        );
        return;
      }
    } else {
      byteLength = new TextEncoder().encode(artContent).byteLength;
      if (byteLength > MAX_TEXT_BYTES) {
        setUploadError(`Content is ${(byteLength / 1024 / 1024).toFixed(1)}MB; max is 10MB.`);
        return;
      }
    }
    createArtifact.mutate({
      caseId,
      data: {
        kind: artKind,
        filename: artFilename || undefined,
        content: artContent,
        contentEncoding: artEncoding,
      },
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCaseArtifactsQueryKey(caseId) });
        queryClient.invalidateQueries({ queryKey: getGetCaseQueryKey(caseId) });
        setUploadOpen(false);
        setArtContent("");
        setArtFilename("");
        if (fileInputRef.current) fileInputRef.current.value = "";
      },
      onError: (err: unknown) => {
        const e = err as { message?: string };
        setUploadError(e.message ?? "Upload failed.");
      },
    });
  };

  if (isLoading) {
    return <div className="min-h-screen bg-background flex items-center justify-center text-primary font-mono"><Terminal className="animate-pulse mr-2" /> Establishing connection...</div>;
  }

  if (!caseDetail) {
    return <div className="min-h-screen bg-background flex items-center justify-center text-destructive font-mono">Case not found.</div>;
  }

  const { case: c } = caseDetail;
  const isAnalyzing = c.status === 'analyzing' || stream.isStreaming;

  return (
    <div className="min-h-screen h-screen bg-background text-foreground flex flex-col font-sans overflow-hidden">
      {/* Header */}
      <header className="border-b border-border bg-card/50 px-4 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <Link href="/">
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary">
              <ArrowLeft size={16} />
            </Button>
          </Link>
          <div className="flex items-center gap-3">
            <div className={`w-2 h-6 rounded-full ${
              isAnalyzing ? 'bg-amber-400 animate-pulse' :
              c.status === 'complete' ? 'bg-primary' :
              c.status === 'failed' ? 'bg-destructive' :
              'bg-muted'
            }`} />
            <div>
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[10px] text-muted-foreground uppercase">{c.id.split('-')[0]}</span>
                <h1 className="text-lg font-bold tracking-tight text-foreground">{c.title}</h1>
              </div>
              <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider">{c.status}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label
            htmlFor="training-mode-switch"
            className="flex items-center gap-2 cursor-pointer select-none px-2 py-1 rounded hover:bg-card/60 transition-colors"
            data-testid="training-mode-label"
          >
            <Sparkles size={12} className={trainingMode ? "text-primary" : "text-muted-foreground"} />
            <span className={`font-mono text-[10px] uppercase tracking-widest ${trainingMode ? "text-primary" : "text-muted-foreground"}`}>
              Training
            </span>
            <Switch
              id="training-mode-switch"
              data-testid="switch-training-mode"
              checked={trainingMode}
              onCheckedChange={setTrainingMode}
            />
          </label>
          {stream.isStreaming && (
            <div className="flex items-center gap-2 px-3 py-1 bg-amber-400/10 border border-amber-400/20 rounded font-mono text-[10px] text-amber-400 uppercase tracking-widest">
              <Activity size={12} className="animate-pulse" />
              Agent Active
            </div>
          )}
          {!stream.isStreaming && c.status !== 'analyzing' && c.status !== 'complete' && (
            <Button 
              onClick={() => stream.start()} 
              className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono uppercase tracking-wider text-xs h-8"
            >
              <Play size={14} className="mr-2" /> Run Investigation
            </Button>
          )}
          {stream.isStreaming && (
            <Button 
              onClick={() => stream.stop()} 
              variant="destructive"
              className="font-mono uppercase tracking-wider text-xs h-8"
            >
              <SquareSquare size={14} className="mr-2" /> Halt
            </Button>
          )}
        </div>
      </header>

      {/* Main layout */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* Left Panel: Info & Artifacts */}
        <div className="w-[300px] lg:w-[350px] border-r border-border bg-sidebar flex flex-col shrink-0">
          <ScrollArea className="flex-1">
            <div className="p-4 space-y-6">
              <section>
                <h3 className="font-mono text-xs uppercase tracking-widest text-muted-foreground mb-2 flex items-center"><FileText size={12} className="mr-1"/> Brief</h3>
                <div className="text-sm text-foreground/80 leading-relaxed bg-card border border-border p-3 rounded font-mono">
                  {c.description}
                </div>
              </section>

              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-mono text-xs uppercase tracking-widest text-muted-foreground flex items-center"><Database size={12} className="mr-1"/> Evidence</h3>
                  <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
                    <DialogTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px] font-mono uppercase text-primary">
                        <Upload size={10} className="mr-1" /> Add
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-[425px] bg-background border-primary/20">
                      <DialogHeader>
                        <DialogTitle className="font-mono text-primary uppercase text-sm">Upload Evidence</DialogTitle>
                      </DialogHeader>
                      <form onSubmit={handleUpload} className="space-y-4 pt-2">
                        <div className="space-y-2">
                          <label className="text-xs font-mono text-muted-foreground uppercase">Kind</label>
                          <select
                            value={artKind}
                            onChange={(e) => setArtKind(e.target.value as ArtifactKind)}
                            className="w-full bg-card border border-border rounded p-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                          >
                            <option value="log_file">Log File</option>
                            <option value="network_capture">Network Capture</option>
                            <option value="memory_strings">Memory Strings</option>
                            <option value="text">Raw Text</option>
                            <option value="mcp_endpoint">MCP Endpoint</option>
                            <option value="disk_image">Disk Image (.img / .dd / .raw)</option>
                          </select>
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-mono text-muted-foreground uppercase">From File</label>
                          <Input
                            ref={fileInputRef}
                            type="file"
                            accept={
                              isBinaryKind
                                ? ".img,.dd,.raw,.iso,application/octet-stream"
                                : ".log,.txt,.json,.csv,.pcap,.cap,.bin,text/*,application/json"
                            }
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) void handleFilePick(f);
                            }}
                            className="font-mono bg-card border-border text-xs file:text-primary file:bg-transparent file:border-0 file:font-mono file:uppercase file:text-[10px] file:mr-2"
                          />
                          <p className="text-[10px] font-mono text-muted-foreground">
                            {isBinaryKind
                              ? "Max 64MB. Read as bytes, base64-encoded on the wire."
                              : "Max 10MB. Read as UTF-8 text."}
                          </p>
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-mono text-muted-foreground uppercase">Filename (optional)</label>
                          <Input value={artFilename} onChange={e=>setArtFilename(e.target.value)} className="font-mono bg-card border-border"/>
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-mono text-muted-foreground uppercase">
                            {isBinaryKind ? "Binary payload" : "Content"}
                          </label>
                          {isBinaryKind ? (
                            <div className="font-mono bg-card border border-border rounded p-2 text-xs text-muted-foreground min-h-[60px] flex items-center">
                              {artContent
                                ? `Loaded ${artDecodedSize.toLocaleString()} bytes (${artContent.length.toLocaleString()} chars base64). SHA-256 will be computed over the decoded bytes.`
                                : "Pick a disk-image file above to load its bytes."}
                            </div>
                          ) : (
                            <Textarea value={artContent} onChange={e=>setArtContent(e.target.value)} required className="font-mono bg-card border-border min-h-[150px]"/>
                          )}
                        </div>
                        {uploadError && (
                          <div className="text-xs font-mono text-destructive border border-destructive/30 bg-destructive/10 rounded p-2">
                            {uploadError}
                          </div>
                        )}
                        <Button type="submit" disabled={createArtifact.isPending || !artContent} className="w-full bg-primary text-primary-foreground font-mono uppercase text-xs">
                          {createArtifact.isPending ? "Uploading..." : "Submit Artifact"}
                        </Button>
                      </form>
                    </DialogContent>
                  </Dialog>
                </div>
                <div className="space-y-2">
                  {!artifacts || artifacts.length === 0 ? (
                    <p className="text-xs text-muted-foreground font-mono italic p-2 border border-dashed border-border rounded text-center">No artifacts provided.</p>
                  ) : (
                    artifacts.map(a => (
                      <div key={a.id} className="p-2 bg-card border border-border rounded flex items-center justify-between group cursor-pointer hover:border-primary/50 transition-colors">
                        <div className="truncate">
                          <p className="text-xs font-mono text-foreground truncate">{a.filename || a.kind}</p>
                          <p className="text-[10px] font-mono text-muted-foreground uppercase">{a.kind} • {(a.sizeBytes / 1024).toFixed(1)}kb</p>
                        </div>
                        <ChevronRight size={14} className="text-muted-foreground group-hover:text-primary"/>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          </ScrollArea>
        </div>

        {/* Center Panel: Reasoning Cards */}
        <div className="flex-1 flex flex-col min-w-0 border-r border-border bg-[#0a0a0c]">
          <div className="h-8 border-b border-border bg-card/30 flex items-center justify-between px-4 shrink-0">
            <span className="font-mono text-[10px] text-primary uppercase tracking-widest flex items-center">
              <Terminal size={12} className="mr-2" /> Reasoning Trace
            </span>
            <span
              data-testid="reasoning-trace-meta"
              className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest"
            >
              {steps.length} step{steps.length === 1 ? "" : "s"}
              {tokenTotals.total > 0 && ` · ${tokenTotals.total} tok`}
              {liveSlice.events.length > 0 && stream.isStreaming ? " · live" : ""}
            </span>
          </div>
          <div className="flex-1 relative overflow-hidden">
            <div
              ref={feedScrollRef}
              onScroll={handleFeedScroll}
              className="absolute inset-0 overflow-y-auto p-4"
              data-testid="feed-scroll"
            >
            {steps.length === 0 && liveSlice.events.length === 0 && !stream.isStreaming ? (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground opacity-50">
                <Terminal size={48} className="mb-4" />
                <p className="font-mono uppercase tracking-widest text-xs">Awaiting execution command</p>
              </div>
            ) : (
              <div className="space-y-3 pb-8">
                {trainingMode && (
                  <div
                    data-testid="training-mode-intro"
                    className="rounded border border-primary/30 bg-primary/[0.04] p-3 flex gap-2 text-[11px] leading-relaxed text-foreground/90"
                  >
                    <Sparkles size={12} className="text-primary mt-0.5 shrink-0" />
                    <div>
                      <div className="font-mono uppercase tracking-widest text-primary text-[10px] mb-1">
                        Training mode
                      </div>
                      Each card is one persisted reasoning step. Read in order: <em>rationale</em> (why this step), <em>expected</em> (hypothesis), <em>found</em> (what the tool returned — must cite concrete values), <em>next</em> (where this leads). Phases progress triage → deep analysis → synthesis, with self-correction whenever evidence contradicts a prior step.
                    </div>
                  </div>
                )}
                {steps.map((step) => (
                  <ReasoningCard
                    key={step.id}
                    step={step}
                    trainingMode={trainingMode}
                  />
                ))}
                {stream.isStreaming && liveSlice.events.length > 0 && (
                  <LiveActivityCard
                    events={liveSlice.events}
                    iteration={liveSlice.iteration}
                  />
                )}
                {terminalEvent?.type === "finalized" && (
                  <div
                    data-testid="banner-finalized"
                    className="rounded border border-primary/40 bg-primary/[0.06] px-3 py-2 font-mono text-xs text-primary uppercase tracking-widest flex items-center"
                  >
                    <CheckCircle2 size={14} className="mr-2" /> Report finalized
                  </div>
                )}
                {terminalEvent?.type === "done" && (
                  <div
                    data-testid="banner-done"
                    className="rounded border border-emerald-400/40 bg-emerald-400/[0.06] px-3 py-2 font-mono text-xs text-emerald-300 uppercase tracking-widest flex items-center"
                  >
                    <CheckCircle2 size={14} className="mr-2" /> Stream terminated — {terminalEvent.reason}
                  </div>
                )}
                <div ref={feedEndRef} />
              </div>
            )}
            </div>
            {!autoFollow && (steps.length > 0 || liveSlice.events.length > 0) && (
              <button
                type="button"
                onClick={jumpToLatest}
                data-testid="button-jump-to-latest"
                className="absolute bottom-3 right-3 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-primary-foreground font-mono text-[10px] uppercase tracking-widest shadow-lg hover:bg-primary/90 transition-colors border border-primary/40"
              >
                <ArrowDown size={12} /> Jump to latest
              </button>
            )}
          </div>
        </div>


        {/* Right Panel: Intelligence / Report */}
        <div className="w-[300px] lg:w-[400px] bg-sidebar flex flex-col shrink-0">
          <Tabs defaultValue="report" className="flex-1 flex flex-col">
            <div className="h-8 border-b border-border bg-card/30 flex items-center px-2 shrink-0">
               <TabsList className="h-6 bg-transparent p-0 gap-4">
                 <TabsTrigger value="report" data-testid="tab-report" className="text-[10px] font-mono uppercase tracking-widest data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-0">Report</TabsTrigger>
                 <TabsTrigger value="execlog" data-testid="tab-execlog" className="text-[10px] font-mono uppercase tracking-widest data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-0 flex items-center gap-1">
                   <Cpu size={10} /> Exec Log
                 </TabsTrigger>
                 <TabsTrigger value="custody" data-testid="tab-custody" className="text-[10px] font-mono uppercase tracking-widest data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-0">Custody</TabsTrigger>
               </TabsList>
            </div>
            
            <TabsContent value="report" className="flex-1 overflow-hidden m-0 data-[state=active]:flex flex-col">
              <ScrollArea className="flex-1 p-4">
                {!report ? (
                  <div className="flex flex-col items-center justify-center h-full text-muted-foreground opacity-50 mt-20">
                    <FileText size={32} className="mb-2" />
                    <p className="font-mono text-xs uppercase tracking-widest">Report pending completion</p>
                  </div>
                ) : (
                  <div className="space-y-6">
                    <div className="space-y-2">
                      <h3 className="font-mono text-xs uppercase tracking-widest text-primary border-b border-primary/20 pb-1">Executive Summary</h3>
                      <p className="text-sm leading-relaxed">{report.summary}</p>
                    </div>
                    {report.confidenceScore !== null && (
                      <div className="space-y-2">
                        <h3 className="font-mono text-xs uppercase tracking-widest text-primary border-b border-primary/20 pb-1">Confidence</h3>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                            <div className="h-full bg-primary" style={{ width: `${(report.confidenceScore || 0) * 100}%` }}/>
                          </div>
                          <span className="font-mono text-xs">{((report.confidenceScore || 0) * 100).toFixed(0)}%</span>
                        </div>
                      </div>
                    )}
                    <div className="space-y-2">
                      <h3 className="font-mono text-xs uppercase tracking-widest text-primary border-b border-primary/20 pb-1">IOCs</h3>
                      {report.iocs.map((ioc, i) => (
                         <div key={i} className="bg-card border border-border p-2 rounded text-xs font-mono overflow-x-auto">
                           <pre>{JSON.stringify(ioc, null, 2)}</pre>
                         </div>
                      ))}
                    </div>
                    <div className="space-y-2">
                      <h3 className="font-mono text-xs uppercase tracking-widest text-primary border-b border-primary/20 pb-1">Recommendations</h3>
                      {report.recommendations.map((rec, i) => (
                         <div key={i} className="bg-card border border-border p-2 rounded text-xs font-mono overflow-x-auto">
                           <pre>{JSON.stringify(rec, null, 2)}</pre>
                         </div>
                      ))}
                    </div>
                  </div>
                )}
              </ScrollArea>
            </TabsContent>

            <TabsContent value="execlog" className="flex-1 overflow-hidden m-0 data-[state=active]:flex flex-col">
              <ScrollArea className="flex-1 p-4">
                <ExecLogPanel logs={logs} />
              </ScrollArea>
            </TabsContent>

            <TabsContent value="custody" className="flex-1 overflow-hidden m-0 data-[state=active]:flex flex-col">
              <ScrollArea className="flex-1 p-4">
                {!custody || custody.entries.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-muted-foreground opacity-50 mt-20">
                    <Lock size={32} className="mb-2" />
                    <p className="font-mono text-xs uppercase tracking-widest">No reads recorded</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-2 mb-4">
                      <div className="bg-card border border-border p-2 rounded text-center">
                        <div className="text-xl font-mono text-primary">{custody.artifactCount}</div>
                        <div className="text-[10px] font-mono text-muted-foreground uppercase">Artifacts Accessed</div>
                      </div>
                      <div className="bg-card border border-border p-2 rounded text-center">
                        <div className="text-xl font-mono text-primary">{custody.readCount}</div>
                        <div className="text-[10px] font-mono text-muted-foreground uppercase">Total Reads</div>
                      </div>
                    </div>
                    <div className="space-y-2 border-l border-border pl-2 ml-2">
                      {custody.entries.map((e, i) => (
                        <div key={i} className="relative pl-4 pb-4">
                          <div className="absolute left-[-5px] top-1.5 w-2 h-2 rounded-full bg-border border border-background"/>
                          <div className="text-xs font-mono">
                            <span className="text-muted-foreground">{format(new Date(e.readAt), "HH:mm:ss.SSS")}</span>
                            <div className="text-foreground mt-1">
                              {e.toolName} read <span className="text-primary">{e.artifactFilename || e.artifactKind}</span>
                            </div>
                            {e.ok ? (
                              <div className="text-[10px] text-green-400 mt-0.5 flex items-center"><CheckCircle2 size={10} className="mr-1"/> Hash verified: {e.artifactSha256?.substring(0, 8)}...</div>
                            ) : (
                              <div className="text-[10px] text-destructive mt-0.5 flex items-center"><XCircle size={10} className="mr-1"/> Integrity Error: {e.error}</div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </div>

      </div>
    </div>
  );
}