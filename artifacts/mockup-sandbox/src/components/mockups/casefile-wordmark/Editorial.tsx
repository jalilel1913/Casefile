export function Editorial() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f3ede0] p-10">
      <div className="w-full max-w-xl">
        <div
          className="relative bg-[#e8dcc4] border border-[#c9b890] shadow-[0_18px_45px_-20px_rgba(60,40,10,0.35)] px-10 pt-14 pb-12"
          style={{
            backgroundImage:
              "repeating-linear-gradient(180deg, transparent 0 27px, rgba(120,90,40,0.06) 27px 28px)",
          }}
        >
          {/* Folder tab */}
          <div className="absolute -top-5 left-10 bg-[#e8dcc4] border border-b-0 border-[#c9b890] px-5 py-2 text-[10px] tracking-[0.3em] text-[#7a5a2a] uppercase font-['IBM_Plex_Mono',_monospace]">
            Case · 2026-CF-0421
          </div>

          {/* Confidential stamp */}
          <div className="absolute top-8 right-8 -rotate-[8deg]">
            <div className="border-[3px] border-red-700/70 text-red-700/80 px-3 py-1 text-[10px] tracking-[0.3em] font-bold uppercase font-['IBM_Plex_Mono',_monospace]">
              Confidential
            </div>
          </div>

          <div className="text-[10px] tracking-[0.35em] text-[#7a5a2a] uppercase mb-4 font-['IBM_Plex_Mono',_monospace]">
            Incident Dossier
          </div>

          <h1
            className="text-[#2a1d0a] text-7xl leading-[0.95] tracking-tight font-normal"
            style={{ fontFamily: "'Cormorant Garamond', 'Playfair Display', serif" }}
          >
            Casefile
          </h1>

          <div className="mt-5 flex items-center gap-3">
            <span className="h-px w-12 bg-[#7a5a2a]/60" />
            <span
              className="text-[#5a4318] italic text-base"
              style={{ fontFamily: "'Cormorant Garamond', serif" }}
            >
              Evidence-first incident response
            </span>
          </div>

          <div className="mt-10 grid grid-cols-3 gap-6 text-[11px] font-['IBM_Plex_Mono',_monospace] text-[#5a4318]">
            <div>
              <div className="text-[9px] tracking-[0.25em] uppercase text-[#7a5a2a]/70">Opened</div>
              <div className="mt-1">25 MAY 2026</div>
            </div>
            <div>
              <div className="text-[9px] tracking-[0.25em] uppercase text-[#7a5a2a]/70">Severity</div>
              <div className="mt-1">HIGH</div>
            </div>
            <div>
              <div className="text-[9px] tracking-[0.25em] uppercase text-[#7a5a2a]/70">Status</div>
              <div className="mt-1">SEALED</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
