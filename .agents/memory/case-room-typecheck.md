---
name: case-room typecheck quirk & deliberate fixture errors
description: Why case-room shows 2 persistent tsc errors and why it builds clean anyway
---

# case-room typecheck is separate from the project-reference graph

`pnpm exec tsc --build` (root composite graph) passes with exit 0 and does
NOT include `artifacts/case-room`. The case-room app is typechecked on its own
(`pnpm --filter @workspace/case-room exec tsc --noEmit`) and built by Vite/esbuild
(no typecheck at build time).

## Deliberate, DO-NOT-FIX type errors
`artifacts/case-room/src/lib/sample-cases.ts` intentionally carries exactly two
errors inside `buildSampleDiskImage` (around the `fragments` tuple — `.length`,
`+`, `.charCodeAt` on `string | number`). The file comment says type annotations
are intentionally omitted so the accuracy harness can `new Function` over the file
after a regex strip.

**Why:** these are fixtures, not bugs. "Fixing" them would break the harness.
**How to apply:** when validating case-room, treat ONLY these 2 errors as the
expected baseline; any other error is real. Production publishing is unaffected
because Vite does not run tsc.

## Embedding binary capture/disk fixtures
Sample binary artifacts (pcap, disk image) are embedded as static base64 string
literals. Generate + verify them OFFLINE through the real tool (e.g. run
`lib/sift-tools/src/pcap.ts` `pcap.run({content})` via tsx), then paste the
base64 — do NOT add a generator with typed params to the browser file (noImplicitAny
+ the regex-strip harness make that fragile). `network_capture` artifacts MUST be
base64 (API enforces it) and `handleLoadSample` forwards `contentEncoding`.
