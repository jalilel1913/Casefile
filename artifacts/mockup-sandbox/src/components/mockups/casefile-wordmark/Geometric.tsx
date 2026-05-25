export function Geometric() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-white p-10 font-['Inter',_'Geist',_system-ui,_sans-serif]">
      <div className="w-full max-w-xl">
        {/* Mark + wordmark */}
        <div className="flex items-center gap-4">
          <Mark />
          <div className="flex items-baseline">
            <span className="text-neutral-950 text-5xl font-semibold tracking-[-0.04em]">
              Casefile
            </span>
            <span className="text-neutral-300 text-5xl font-semibold tracking-[-0.04em]">.</span>
          </div>
        </div>

        <p className="mt-5 text-neutral-500 text-[15px] leading-relaxed max-w-md">
          The autonomous incident-response agent. Triage, evidence, and a sealed
          report — in one pass.
        </p>

        {/* Browser chip */}
        <div className="mt-10 rounded-xl border border-neutral-200 bg-neutral-50 shadow-sm overflow-hidden">
          <div className="flex items-center gap-1.5 px-3 py-2 border-b border-neutral-200 bg-white">
            <span className="w-2.5 h-2.5 rounded-full bg-neutral-200" />
            <span className="w-2.5 h-2.5 rounded-full bg-neutral-200" />
            <span className="w-2.5 h-2.5 rounded-full bg-neutral-200" />
            <div className="ml-3 flex items-center gap-2 text-[11px] text-neutral-500 font-medium">
              <MiniMark />
              <span className="text-neutral-700">casefile.app</span>
              <span className="text-neutral-300">/cases/2026-cf-0421</span>
            </div>
          </div>
          <div className="px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <span className="text-neutral-700 font-medium">Case sealed</span>
              <span className="text-neutral-400">· 7 IOCs · HIGH</span>
            </div>
            <span className="text-[11px] text-neutral-400 font-mono">sha256 ✓</span>
          </div>
        </div>

        <div className="mt-10 flex items-center gap-6 text-[11px] uppercase tracking-[0.18em] text-neutral-400">
          <span>v0.1</span>
          <span className="h-px flex-1 bg-neutral-200" />
          <span>2026</span>
        </div>
      </div>
    </div>
  );
}

function Mark() {
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden>
      <rect x="2" y="2" width="52" height="52" rx="14" fill="#0a0a0a" />
      {/* Folder + tab geometry */}
      <path d="M14 19 H24 L27 22 H42 V40 H14 Z" stroke="white" strokeWidth="2.25" strokeLinejoin="round" />
      {/* Cursor/seek indicator */}
      <circle cx="32" cy="31" r="3.25" fill="#22d3ee" />
      <rect x="34.5" y="33.5" width="6" height="2.25" rx="1" transform="rotate(35 34.5 33.5)" fill="#22d3ee" />
    </svg>
  );
}

function MiniMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 56 56" fill="none" aria-hidden>
      <rect x="2" y="2" width="52" height="52" rx="14" fill="#0a0a0a" />
      <path d="M14 19 H24 L27 22 H42 V40 H14 Z" stroke="white" strokeWidth="3" strokeLinejoin="round" />
      <circle cx="32" cy="31" r="4" fill="#22d3ee" />
    </svg>
  );
}
