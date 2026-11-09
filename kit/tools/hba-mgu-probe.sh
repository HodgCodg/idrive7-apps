#!/bin/sh
# hba-mgu-probe.sh - READ-ONLY look at the head unit for the High Beam Assistant investigation, run from
# your PC (the one with the kit checkout and SSH access to the unit). Changes nothing on the unit.
#
#   HU=root@<unit-ip> [PORT=22] [KEY=~/.ssh/id_mgu] kit/tools/hba-mgu-probe.sh [out_dir]
#
# 1. copies /etc/oap/someip/someip-interfaces.json (the interfaces an app may use) and scans it with the
#    app's own catalog.js: every interface / field / method / type / enum about the high beam assistant
# 2. lists HMI text resources that mention it (does this firmware's iDrive menu have an HBA switch?)
# 3. copies the hba_assist app's saved reports and log (data/reports/hba-*.json, hba_assist.log)
set -eu
: "${HU:?set HU=root@<head unit address>}"
OUT=${1:-hba-probe-$(date +%Y%m%d-%H%M%S)}
HERE=$(cd "$(dirname "$0")" && pwd)
SSH="ssh -p ${PORT:-22} ${KEY:+-i $KEY} -o ConnectTimeout=10"
SCP="scp -P ${PORT:-22} ${KEY:+-i $KEY} -o ConnectTimeout=10"
mkdir -p "$OUT"

echo "== 1. SOME/IP catalog"
$SCP "$HU:/etc/oap/someip/someip-interfaces.json" "$OUT/someip-interfaces.json"
node -e '
const c = require(require("path").resolve(process.argv[1]));
const r = c.scanFile(process.argv[2]);
if (!r.ok) { console.log("not readable: " + r.error); process.exit(1); }
console.log(r.interfaces + " interfaces, " + r.hits.length + " matches, " + r.users.length + " fields using a matching type");
r.hits.concat(r.users).forEach((h) => console.log("  " + h.kind.padEnd(9) + " " + (h.iface ? h.iface + "  " : "") + h.name + (h.flags.length ? "  [" + h.flags.join(",") + "]" : "")));
if (r.context.length) console.log("light-related interfaces: " + r.context.join(", "));
' "$HERE/../../apps/hba_assist/catalog.js" "$OUT/someip-interfaces.json" | tee "$OUT/catalog-scan.txt"

echo "== 2. HMI resources naming the high beam assistant"
# text tables and HMI descriptions only; -I skips binaries, the size limit keeps it quick
$SSH "$HU" 'for d in /opt /usr/share /usr/lib/oap-mainapp /etc; do
  [ -d "$d" ] && find "$d" -xdev -type f -size -20M 2>/dev/null | xargs grep -IilE "high.?beam.?assist|fernlichtassist|HIGH_BEAM_ASSIST|FERNLICHTASSIST" 2>/dev/null
done | head -200' | tee "$OUT/hmi-files.txt" || true
$SSH "$HU" 'for f in $(for d in /opt /usr/share /usr/lib/oap-mainapp /etc; do [ -d "$d" ] && find "$d" -xdev -type f -size -20M 2>/dev/null | xargs grep -IilE "high.?beam.?assist|fernlichtassist" 2>/dev/null; done | head -40); do
  grep -IhoiE ".{0,80}(high.?beam.?assist|fernlichtassist).{0,80}" "$f" 2>/dev/null | head -5 | sed "s|^|$f: |"; done' > "$OUT/hmi-strings.txt" || true
echo "($(wc -l < "$OUT/hmi-strings.txt") matching lines in $OUT/hmi-strings.txt)"

echo "== 3. hba_assist reports and log"
mkdir -p "$OUT/reports"
for f in $($SSH "$HU" 'find /var/opt/public/oap -path "*hba_assist*" \( -name "hba-*.json" -o -name "hba_assist.log" \) 2>/dev/null'); do
  $SCP "$HU:$f" "$OUT/reports/" >/dev/null && echo "  $f"
done
echo "done: $OUT"
