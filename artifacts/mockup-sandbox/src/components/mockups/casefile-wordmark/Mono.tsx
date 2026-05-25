export function Mono() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0e14] p-10 font-['JetBrains_Mono',_'Fira_Code',_monospace]">
      <div className="w-full max-w-xl">
        <div className="flex items-center gap-2 text-[10px] tracking-[0.25em] text-cyan-400/70 uppercase mb-8">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
          <span>protocol_sift // online</span>
        </div>

        <div className="flex items-baseline gap-3 leading-none">
          <span className="text-cyan-400 text-5xl font-light select-none">{"$"}</span>
          <h1 className="text-slate-100 text-6xl font-medium tracking-tight">
            casefile
            <span className="inline-block w-[14px] h-[42px] bg-cyan-400 ml-1 -mb-1 animate-pulse" />
          </h1>
        </div>

        <div className="mt-6 pl-9 text-slate-400 text-sm">
          <span className="text-slate-600">{"// "}</span>
          autonomous incident-response, evidence-first.
        </div>

        <div className="mt-12 pl-9 border-l border-slate-800 space-y-2 text-[13px]">
          <div className="text-slate-500">
            <span className="text-emerald-400">→</span> ingested 4 artifacts (2.1 MB)
          </div>
          <div className="text-slate-500">
            <span className="text-amber-400">→</span> 7 IOCs · severity:{" "}
            <span className="text-amber-300">HIGH</span>
          </div>
          <div className="text-slate-500">
            <span className="text-cyan-400">→</span> case sealed · sha256 verified
          </div>
        </div>

        <div className="mt-12 flex items-center justify-between text-[10px] tracking-[0.25em] text-slate-600 uppercase">
          <span>v0.1.0</span>
          <span>build {"//"} 2026.05.25</span>
        </div>
      </div>
    </div>
  );
}
