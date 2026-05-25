import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useListCases,
  useCreateCase,
  getListCasesQueryKey,
  createArtifact,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { format, formatDistanceToNow } from "date-fns";
import { Terminal, Plus, ArrowRight, Sparkles, FileStack } from "lucide-react";
import { SAMPLE_CASES, type SampleCase } from "@/lib/sample-cases";

export default function CaseList() {
  const { data: cases, isLoading } = useListCases();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const createCase = useCreateCase();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [loadingSampleId, setLoadingSampleId] = useState<string | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !description) return;

    createCase.mutate(
      { data: { title, description } },
      {
        onSuccess: (newCase) => {
          queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
          setOpen(false);
          setLocation(`/cases/${newCase.id}`);
        },
      }
    );
  };

  const handleLoadSample = async (sample: SampleCase) => {
    if (loadingSampleId) return;
    setSampleError(null);
    setLoadingSampleId(sample.id);
    try {
      const newCase = await createCase.mutateAsync({
        data: { title: sample.title, description: sample.description },
      });
      for (const artifact of sample.artifacts) {
        await createArtifact(newCase.id, {
          kind: artifact.kind,
          filename: artifact.filename,
          content: artifact.content,
          contentEncoding: artifact.contentEncoding,
        });
      }
      queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
      setLocation(`/cases/${newCase.id}`);
    } catch (err) {
      const e = err as { message?: string };
      setSampleError(e.message ?? "Could not load sample case.");
    } finally {
      setLoadingSampleId(null);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans">
      <header className="border-b border-border bg-card/50 backdrop-blur px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 font-mono text-[9px] tracking-[0.25em] text-primary/80 uppercase">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            <span>casefile // online</span>
          </div>
          <div className="h-6 w-px bg-border mx-1" />
          <div className="flex items-baseline gap-1.5 font-mono leading-none">
            <span className="text-primary text-xl font-light select-none">$</span>
            <h1 className="text-foreground text-xl font-medium tracking-tight lowercase">casefile</h1>
            <span className="inline-block w-[7px] h-[18px] bg-primary -mb-0.5 animate-pulse" aria-hidden />
          </div>
          <span className="hidden md:inline-block ml-3 text-xs font-mono text-muted-foreground">
            <span className="text-muted-foreground/60">{"// "}</span>autonomous incident-response
          </span>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono uppercase tracking-wider text-xs">
              <Plus size={14} className="mr-2" />
              New Case
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[500px] border-primary/20 bg-background">
            <DialogHeader>
              <DialogTitle className="font-mono text-primary uppercase tracking-widest border-b border-primary/20 pb-2">Initialize Investigation</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4 pt-4">
              <div className="space-y-2">
                <label className="text-xs font-mono text-muted-foreground uppercase">Case Designation</label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Suspicious outbound traffic on DB-01"
                  required
                  className="font-mono bg-card border-border focus-visible:ring-primary"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-mono text-muted-foreground uppercase">Initial Intelligence</label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Paste initial alerts, symptoms, or context..."
                  required
                  className="min-h-[150px] font-mono bg-card border-border focus-visible:ring-primary resize-none"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button type="button" variant="outline" onClick={() => setOpen(false)} className="font-mono uppercase text-xs">
                  Abort
                </Button>
                <Button type="submit" disabled={createCase.isPending} className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono uppercase text-xs">
                  {createCase.isPending ? "Initializing..." : "Execute"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </header>

      <main className="flex-1 p-6 max-w-7xl mx-auto w-full space-y-8">
        <section>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-primary" />
              <h2 className="font-mono text-xs uppercase tracking-widest text-primary">
                Load Sample Case
              </h2>
            </div>
            <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              Pre-loaded incident scenarios · one-click
            </span>
          </div>
          <p className="text-xs text-muted-foreground font-mono mb-3">
            New here? Skip the upload step — load a canonical incident with
            real-looking logs already attached, then hit{" "}
            <span className="text-primary">Run Investigation</span>.
          </p>
          <div className="grid gap-3 md:grid-cols-3">
            {SAMPLE_CASES.map((sample) => {
              const isLoading = loadingSampleId === sample.id;
              const isDisabled = loadingSampleId !== null;
              return (
                <button
                  key={sample.id}
                  type="button"
                  onClick={() => handleLoadSample(sample)}
                  disabled={isDisabled}
                  data-testid={`button-load-sample-${sample.id}`}
                  className="text-left border border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/60 transition-colors rounded p-4 cursor-pointer disabled:opacity-50 disabled:cursor-wait flex flex-col gap-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-primary/80">
                      {sample.scenario}
                    </span>
                    <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground flex items-center gap-1">
                      <FileStack size={10} /> {sample.artifacts.length} file
                      {sample.artifacts.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <h3 className="font-semibold text-foreground tracking-tight text-sm leading-snug">
                    {sample.shortLabel}
                  </h3>
                  <p className="text-xs text-muted-foreground font-mono line-clamp-3 flex-1">
                    {sample.description}
                  </p>
                  <div className="flex items-center justify-end text-[10px] font-mono uppercase tracking-widest text-primary mt-1">
                    {isLoading ? (
                      <span className="animate-pulse">Loading…</span>
                    ) : (
                      <>
                        Load &amp; open <ArrowRight size={12} className="ml-1" />
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          {sampleError && (
            <div className="mt-3 text-xs font-mono text-destructive border border-destructive/30 bg-destructive/10 rounded p-2">
              {sampleError}
            </div>
          )}
        </section>

        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
              Active Investigations
            </h2>
          </div>
        {isLoading ? (
          <div className="flex items-center justify-center h-64 text-primary font-mono animate-pulse">
            <Terminal className="mr-2" /> Initializing datalinks...
          </div>
        ) : !cases || cases.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 border border-dashed border-border rounded-lg bg-card/20">
            <Terminal size={32} className="text-muted-foreground mb-4" />
            <p className="text-muted-foreground font-mono uppercase tracking-widest text-sm">No active investigations</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {cases.map((c) => (
              <Link key={c.id} href={`/cases/${c.id}`}>
                <div className="group border border-border bg-card hover:bg-secondary/40 hover:border-primary/50 transition-colors rounded p-4 flex items-center justify-between cursor-pointer">
                  <div className="flex items-center gap-4">
                    <div className={`w-2 h-10 rounded-full ${
                      c.status === 'analyzing' ? 'bg-amber-400 animate-pulse' :
                      c.status === 'complete' ? 'bg-primary' :
                      c.status === 'failed' ? 'bg-destructive' :
                      'bg-muted'
                    }`} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-3 mb-1 flex-wrap">
                        <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded-sm ${
                          c.status === 'analyzing' ? 'bg-amber-400/10 text-amber-400 border border-amber-400/20' :
                          c.status === 'complete' ? 'bg-primary/10 text-primary border border-primary/20' :
                          c.status === 'failed' ? 'bg-destructive/10 text-destructive border border-destructive/20' :
                          'bg-muted border border-border text-muted-foreground'
                        }`}>
                          {c.status}
                        </span>
                        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground bg-muted/40 border border-border px-1.5 py-0.5 rounded-sm">
                          {c.id.substring(0, 8)}
                        </span>
                        <span
                          className="text-xs text-muted-foreground font-mono"
                          title={format(new Date(c.createdAt), "yyyy-MM-dd HH:mm:ss")}
                        >
                          {formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}
                        </span>
                      </div>
                      <h3 className="font-semibold text-foreground tracking-tight truncate">{c.title}</h3>
                    </div>
                  </div>
                  <ArrowRight className="text-muted-foreground group-hover:text-primary transition-colors" size={20} />
                </div>
              </Link>
            ))}
          </div>
        )}
        </section>
      </main>
    </div>
  );
}