import { useState, useRef, useEffect } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Terminal, ShieldAlert, ArrowLeft, Play, SquareSquare, FileText, Activity, Database, Lock, AlertTriangle, CheckCircle2, ChevronRight, Upload, XCircle } from "lucide-react";
import { format } from "date-fns";

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

  // Auto-scroll feed
  const feedEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (stream.events.length > 0) {
      feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [stream.events]);

  const createArtifact = useCreateArtifact();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [artKind, setArtKind] = useState<ArtifactKind>("text");
  const [artFilename, setArtFilename] = useState("");
  const [artContent, setArtContent] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const MAX_BYTES = 10 * 1024 * 1024;

  const handleFilePick = async (file: File) => {
    setUploadError(null);
    if (file.size > MAX_BYTES) {
      setUploadError(`File is ${(file.size / 1024 / 1024).toFixed(1)}MB; max is 10MB.`);
      return;
    }
    try {
      const text = await file.text();
      setArtContent(text);
      if (!artFilename) setArtFilename(file.name);
    } catch (err) {
      setUploadError("Could not read file as text.");
    }
  };

  const handleUpload = (e: React.FormEvent) => {
    e.preventDefault();
    setUploadError(null);
    if (!artContent) return;
    const byteLength = new TextEncoder().encode(artContent).byteLength;
    if (byteLength > MAX_BYTES) {
      setUploadError(`Content is ${(byteLength / 1024 / 1024).toFixed(1)}MB; max is 10MB.`);
      return;
    }
    createArtifact.mutate({
      caseId,
      data: {
        kind: artKind,
        filename: artFilename || undefined,
        content: artContent,
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
                          </select>
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-mono text-muted-foreground uppercase">From File</label>
                          <Input
                            ref={fileInputRef}
                            type="file"
                            accept=".log,.txt,.json,.csv,.pcap,.cap,.bin,text/*,application/json"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) void handleFilePick(f);
                            }}
                            className="font-mono bg-card border-border text-xs file:text-primary file:bg-transparent file:border-0 file:font-mono file:uppercase file:text-[10px] file:mr-2"
                          />
                          <p className="text-[10px] font-mono text-muted-foreground">Max 10MB. Read as UTF-8 text.</p>
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-mono text-muted-foreground uppercase">Filename (optional)</label>
                          <Input value={artFilename} onChange={e=>setArtFilename(e.target.value)} className="font-mono bg-card border-border"/>
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-mono text-muted-foreground uppercase">Content</label>
                          <Textarea value={artContent} onChange={e=>setArtContent(e.target.value)} required className="font-mono bg-card border-border min-h-[150px]"/>
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

        {/* Center Panel: Live Feed */}
        <div className="flex-1 flex flex-col min-w-0 border-r border-border bg-[#0a0a0c]">
          <div className="h-8 border-b border-border bg-card/30 flex items-center px-4 shrink-0">
            <span className="font-mono text-[10px] text-primary uppercase tracking-widest flex items-center"><Terminal size={12} className="mr-2"/> Terminal / Agent Feed</span>
          </div>
          <ScrollArea className="flex-1 p-4 font-mono text-xs">
            {stream.events.length === 0 && !stream.isStreaming ? (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground opacity-50">
                <Terminal size={48} className="mb-4" />
                <p className="uppercase tracking-widest">Awaiting execution command</p>
              </div>
            ) : (
              <div className="space-y-3 pb-8">
                {stream.events.map((ev, i) => (
                  <div key={i} className="leading-relaxed">
                    {ev.type === 'started' && (
                      <div className="text-primary/80 mb-1">
                        &gt; SESSION INIT // model={ev.model} // iter_limit={ev.iterationLimit}
                      </div>
                    )}
                    {ev.type === 'iteration' && (
                      <div className="text-amber-400/80 mb-1 mt-4">--- Iteration {ev.iteration} ---</div>
                    )}
                    {ev.type === 'thinking' && (
                      <div className="text-muted-foreground pl-4 border-l-2 border-border italic whitespace-pre-wrap">
                        {ev.text}
                      </div>
                    )}
                    {ev.type === 'tool_call' && (
                      <div className="text-primary mt-2">
                        <span className="font-bold">&gt; EXEC: {ev.name}</span>
                        <div className="bg-primary/5 p-2 rounded mt-1 border border-primary/20 text-primary/80 overflow-x-auto whitespace-pre-wrap">
                          {JSON.stringify(ev.args, null, 2)}
                        </div>
                      </div>
                    )}
                    {ev.type === 'tool_result' && (
                      <div className={`mt-1 ${ev.ok ? 'text-green-400' : 'text-destructive'}`}>
                        <span className="opacity-70">&lt; RESULT ({ev.name}) {ev.ok ? 'OK' : 'FAIL'}:</span>
                        <div className="bg-black/50 p-2 rounded mt-1 border border-border overflow-x-auto whitespace-pre-wrap opacity-80">
                          {ev.summary}
                        </div>
                        {ev.verifiedHash && (
                          <div className="text-[10px] font-mono text-muted-foreground mt-1 flex items-center">
                            <Lock size={10} className="mr-1" /> sha256: {ev.verifiedHash.substring(0, 16)}…
                          </div>
                        )}
                      </div>
                    )}
                    {ev.type === 'finding' && (
                      <div className="text-fuchsia-400 mt-2 p-2 border border-fuchsia-400/30 bg-fuchsia-400/5 rounded">
                        <span className="font-bold uppercase tracking-wide">! FINDING (step {ev.step} / {ev.phase})</span>
                        <div className="mt-1 opacity-90 whitespace-pre-wrap font-mono text-foreground/90">{ev.found}</div>
                      </div>
                    )}
                    {ev.type === 'tokens' && (
                      <div className="text-muted-foreground text-[10px] uppercase tracking-widest mt-1">
                        tokens: prompt={ev.promptTokens} completion={ev.completionTokens} total={ev.total}
                      </div>
                    )}
                    {ev.type === 'finalized' && (
                      <div className="text-primary mt-4 font-bold uppercase tracking-widest flex items-center">
                        <CheckCircle2 size={14} className="mr-2"/> Report finalized
                      </div>
                    )}
                    {ev.type === 'error' && (
                      <div className="text-destructive mt-2 p-2 border border-destructive/30 bg-destructive/10 rounded flex items-start gap-2">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                        <span>{ev.message}{ev.fatal ? ' (fatal)' : ''}</span>
                      </div>
                    )}
                    {ev.type === 'done' && (
                      <div className="text-green-400 mt-4 font-bold uppercase tracking-widest flex items-center">
                        <CheckCircle2 size={14} className="mr-2"/> Stream Terminated — {ev.reason}
                      </div>
                    )}
                  </div>
                ))}
                {stream.isStreaming && (
                  <div className="text-primary animate-pulse">_</div>
                )}
                <div ref={feedEndRef} />
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Right Panel: Intelligence / Report */}
        <div className="w-[300px] lg:w-[400px] bg-sidebar flex flex-col shrink-0">
          <Tabs defaultValue="report" className="flex-1 flex flex-col">
            <div className="h-8 border-b border-border bg-card/30 flex items-center px-2 shrink-0">
               <TabsList className="h-6 bg-transparent p-0 gap-4">
                 <TabsTrigger value="report" className="text-[10px] font-mono uppercase tracking-widest data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-0">Report</TabsTrigger>
                 <TabsTrigger value="custody" className="text-[10px] font-mono uppercase tracking-widest data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-0">Custody</TabsTrigger>
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