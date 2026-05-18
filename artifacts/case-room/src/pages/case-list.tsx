import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useListCases, useCreateCase, getListCasesQueryKey } from "@workspace/api-client-react";
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
import { format } from "date-fns";
import { Terminal, ShieldAlert, Plus, ArrowRight } from "lucide-react";

export default function CaseList() {
  const { data: cases, isLoading } = useListCases();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const createCase = useCreateCase();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();

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

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans">
      <header className="border-b border-border bg-card/50 backdrop-blur px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-primary/20 flex items-center justify-center border border-primary/50 text-primary">
            <ShieldAlert size={18} />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-primary">PROTOCOL SIFT</h1>
            <p className="text-xs text-muted-foreground uppercase tracking-widest">Autonomous Incident Response</p>
          </div>
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

      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
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
                    <div>
                      <div className="flex items-center gap-3 mb-1">
                        <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded-sm ${
                          c.status === 'analyzing' ? 'bg-amber-400/10 text-amber-400 border border-amber-400/20' :
                          c.status === 'complete' ? 'bg-primary/10 text-primary border border-primary/20' :
                          c.status === 'failed' ? 'bg-destructive/10 text-destructive border border-destructive/20' :
                          'bg-muted border border-border text-muted-foreground'
                        }`}>
                          {c.status}
                        </span>
                        <span className="text-xs text-muted-foreground font-mono">{format(new Date(c.createdAt), "yyyy-MM-dd HH:mm:ss")}</span>
                      </div>
                      <h3 className="font-semibold text-foreground tracking-tight">{c.title}</h3>
                    </div>
                  </div>
                  <ArrowRight className="text-muted-foreground group-hover:text-primary transition-colors" size={20} />
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}