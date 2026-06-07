# Casefile — Demo Video Plan (OBS Studio on Ubuntu Studio)

Target length: **2:30–3:00**. Format: 1080p screen recording with voiceover.
Goal: show that Casefile is a *fully autonomous* incident-response agent —
it forms hypotheses, runs forensic tools, self-corrects, and produces a
verifiable report with chain of custody.

---

## 1. OBS Studio setup (Ubuntu Studio)

### Recording settings
`Settings →`

- **Video** → Base (Canvas) `1920x1080`, Output (Scaled) `1920x1080`,
  FPS `30`.
- **Output** → set *Output Mode* to `Advanced`:
  - **Recording Format:** `mkv` (record to mkv, then **File → Remux
    Recordings** to mp4 afterward — mkv survives a crash, mp4 can
    corrupt).
  - **Encoder:** `FFmpeg VAAPI` (Intel/AMD hardware) or `Software
    (x264)` if VAAPI is unavailable. x264 preset `veryfast`, CRF `20`
    looks clean for screen text.
- **Audio** → Sample Rate `48 kHz`.

### Sources (one scene is enough)
1. **Screen Capture (PipeWire)** — Ubuntu Studio defaults to Wayland;
   pick this and grant the portal permission. (On X11 use *Window
   Capture (Xcomposite)* on the browser window instead, which keeps
   notifications out of frame.)
2. **Audio Input Capture (PipeWire)** — your mic. In *Audio Mixer*,
   add a **Noise Suppression** filter (RNNoise) and a **Compressor**.
3. **Remove / mute Desktop Audio** — the app has no sound, so desktop
   audio only risks capturing notification dings.

### Pre-record checklist
- Browser at **100% zoom**, full-screen (F11), no extra tabs/bookmarks
  bar visible. The UI is a dark terminal theme, so it records crisply.
- Log in **before** you start recording (avoid showing the auth flow).
- Close Slack/email; set Do-Not-Disturb so no toast notifications appear.
- Do **one full dry run** of an investigation first — the agent's live
  run timing varies (~30–55s per case), and you want to know the beats
  before you narrate.
- Decide voiceover style: **(A)** narrate live while recording, or
  **(B)** record screen silent, then add voiceover on a second OBS audio
  pass / in a video editor. (B) is more forgiving for matching the
  agent's variable timing.

---

## 2. Cases to feature

Three of the seven sample cases, chosen to show range and the
self-correction beat. Names match the **Load sample** picker exactly:

| Order | Sample case | Why it's in the video |
| --- | --- | --- |
| 1 | **Encoded PowerShell** | The hero case — contains the self-correction beat (threat-intel says benign, agent tempers confidence instead of flipping). |
| 2 | **Ransomware In Progress** | Shows decisive judgment — escalates to **critical** + immediate containment. |
| 3 | **Insider Data Theft** | Shows an evidence-bounded conclusion (not every case is an external breach). |

If you only have time for one case end-to-end, use **Encoded
PowerShell** and just *mention* the other two.

---

## 3. Shot list & narration script

On-screen cues are in [brackets]. Read the narration in a calm, factual
analyst tone.

### Shot 0 — Cold open (0:00–0:12)
[Start on the case list / dashboard, already logged in.]

> "This is Casefile — an autonomous incident-response agent. You hand it
> raw evidence — logs, packet captures, disk images — and it runs the
> whole investigation itself: forms a hypothesis, tests it with forensic
> tools, and writes the report. Let me show you."

### Shot 1 — Load a case (0:12–0:25)
[Click **Load sample** → choose **Encoded PowerShell**. The evidence
appears — point at the Sysmon log and the endpoint context.]

> "I'll load a real scenario: an encoded PowerShell payload on an
> endpoint. Here's the evidence Casefile starts with — a Sysmon log and
> some host context. No human triage. I just press start."

[Click the start / **Upload Evidence**-style action to begin.]

### Shot 2 — Triage, live (0:25–0:50)
[The live timeline starts streaming. The **Triage** phase label appears;
the agent calls `list_artifacts`, then `parse_log`.]

> "Watch the left panel — this is the agent thinking out loud, live.
> It's in triage: it surveys what evidence exists, then runs cheap, broad
> scans before committing to a thread. Every line here is a real tool
> call, streamed as it happens."

[If the Triage info annotation is visible, hover it briefly.]

### Shot 3 — Deep analysis (0:50–1:15)
[Phase shifts to **Deep Analysis**. `extract_iocs` runs; the C2 domain /
IP surface; `fetch_url` enriches against threat-intel.]

> "Now it's deeper — it's extracted indicators: the encoded command, the
> parent process, a persistence key, and a suspicious domain. It's
> reaching out to public threat intelligence to enrich the C2 address."

### Shot 4 — The self-correction beat (1:15–1:45) ★ the money shot
[The threat-intel lookup returns **benign** for the IP, but the agent
keeps its conclusion based on local forensic evidence. The
**Self-correction** annotation explains this.]

> "Here's the most important moment. Threat intelligence comes back
> *clean* on that IP — but the local evidence still screams compromise:
> encoded PowerShell, spawned by Word, writing a Run key. A naive agent
> would flip to 'benign.' Casefile *tempers its confidence* instead of
> abandoning the evidence. That self-correction is the difference between
> a checklist and an actual investigator."

### Shot 5 — Finalize + report (1:45–2:10)
[The agent calls `finalize`; the **Report** tab populates with severity,
confidence, IOCs, timeline, recommendations.]

> "It finalizes on its own. Severity, a confidence score, the indicators,
> a chronological timeline, and concrete recommendations — generated, not
> templated."

### Shot 6 — Chain of custody (2:10–2:35) ★ the trust shot
[Click the **Custody** tab. Show the per-tool rows with verified
SHA-256 hashes. Optionally show the **Execlog** tab too.]

> "And because this is incident response, every step is auditable. The
> custody tab shows each tool call with the verified hash of the exact
> bytes it read. The evidence is immutable at the database layer and
> re-hashed on every read — so the agent literally cannot tamper with
> what it's analyzing."

### Shot 7 — Range + close (2:35–3:00)
[Quickly load **Ransomware In Progress** (mention it escalates to
critical), then **Insider Data Theft** (mention it's an evidence-bounded
judgment). Land back on the finished report.]

> "It handles the full range — ransomware in progress gets escalated to
> critical with immediate containment; an insider-theft case gets a
> careful, evidence-bounded conclusion rather than a false breach call.
> Seven scenarios, one autonomous agent, every finding backed by a
> verifiable chain of custody. That's Casefile."

---

## 4. Timing cheat-sheet (for live narration)

The agent's run time varies per case. Don't fight it:
- If a phase runs long, pause narrating and let the stream play — silence
  over live tool calls looks confident.
- If it finishes faster than your script, slow your delivery on Shots 4
  and 6 (the two ★ shots) — those are what judges remember.
- Pre-running the case once means you'll know roughly when the
  self-correction line appears, so you can time Shot 4's narration to it.

---

## 5. Post-production

1. **File → Remux Recordings** → convert the mkv to mp4.
2. Trim dead air at head/tail (Ubuntu Studio ships **Kdenlive** —
   import the mp4, cut, export H.264 mp4, 1080p).
3. Optional: add a 3-second title card ("Casefile — Autonomous
   Incident-Response Agent") and an end card with the repo + live URL.
4. Keep total length **under 3:00** — most hackathons cap it.

## 6. Upload checklist

- [ ] Export final mp4 (1080p, H.264).
- [ ] Upload to YouTube or Vimeo (unlisted is usually accepted).
- [ ] Confirm audio levels are audible on laptop speakers, not just
      headphones.
- [ ] Paste the video link into the Devpost submission.
- [ ] Make sure the live deployment is reachable by judges (publicly
      accessible, or include the access password next to the URL).
