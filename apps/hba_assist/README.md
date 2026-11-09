# High Beam Assistant (`hba_assist`)

Finds out, on the car, why BMW's high beam assistant (HBA, German *FLA, Fernlichtassistent*) does
not come on. It also shows which way of switching it from the head unit, if any, the car offers.
Built for a 2021 G30 LCI 530e (BDC-03, KAFAS4, FLM2, S552, S5AC); it identifies other cars' units
and reports what it finds there too.

**Status (0.2.0): read-only probe, plus BMW's own HBA demo jobs as guarded live-diagnostic
experiments. It has no Enable / Disable control yet.** BMW's descriptions of these control units
contain no request that switches the high beam assistant the way the stalk does (see *Evidence*). The
two diagnostic jobs that name it are demo / presentation modes. The app runs them as **experiments**
on the stationary car, measures what they do to the **cluster's own HBA indicator**, and switches
them back off. Enable / Disable gets built only on a path that is shown to light the indicator
*and* leave KAFAS's normal glare-dependent switching in charge: see *Phase 2*.

## What it does

Through the head unit's own diagnostic link (InternalTasu, as `kit/runtime/diag.js`), restricted
by `hba_link.js` to **`22` (read data) and `19 02` (read fault memory)**, to the BDC `0x40`,
KAFAS `0x5D`, headlights `0x43`/`0x44` and cluster `0x60`. The only other frames are the experiments'
exact ones (*Experiments* below). Anything else throws before it reaches the transport
(`kit/tools/test_hba_assist.js` checks 16 kinds of forbidden read and 20 near-miss experiment frames).
Opening the app sends nothing, except switching off an experiment the app was stopped in the middle of.

| Page | Shows | Source (BMW SGBD) |
|---|---|---|
| Findings | conclusions, colour-coded, inferences marked "(inferred)" | all of the below |
| KAFAS | variant `D807`, **HBA enabling code `E482`**, calibration `D6BC`, beam recommendation `D3AD`, **switch-off reasons `D341`**, **HBA usage counters `E474`** | KAFAS04 rev 8.000 |
| Button | the stalk's HBA button **as the BDC reads it**, live, during a 20 s test, with high-beam push / flash pull as a control | BDC_G05 `E3B8` (BDC_G11 / BDC: `D580`, `D583`) |
| Findings / Experiment | **the cluster's HBA indicator** as KOMBI drives it: `0x2520 STATUS_KONTROLLLEUCHTEN`, byte 21 low nibble `STAT_FERNLICHT_ASSISTENT` (0 off, 1 green, …), byte 21 high nibble low beam, byte 19 high nibble high beam | KOMB_G11 14.001 / KOMBSP18 9.001 / KOMBSP21 0.002 (identical layout) |
| Interfaces | every HBA-related interface, field, method, type or enum in the head unit's SOME/IP catalog (`/etc/oap/someip/someip-interfaces.json`), marked writable where it has a setter / is a method | the unit's own catalog |

Also read: `22 F150` (SGBD index → which BDC / KAFAS / FLM variant), fault memory of BDC and KAFAS
with the HBA-relevant codes named (SZL stalk faults `030340`-`030352`, KAFAS `800A21
FLA_FSC_Missing`, `800A01 FLA_Misconfiguration`, calibration `800AC4`/`800AC8`).

Each run and each button test is saved with **every raw request and reply** to
`data/reports/hba-<time>.json`, and every exchange is in the app log (`UDS 5D 22 E4 82 -> 62 E4 82 00 (38 ms)`).
Requests time out after 2 s (fault memory 6 s). A unit that does not answer `22 F150` gets no further
requests.

## Experiments (live diagnostics)

Settings, **Experiment** (ships **Off**: then nothing but reads is ever sent, and the button is
hidden). Each is a job from BMW's own SGBD, sent as fixed bytes:

| | Sends | Switches back | Unit must be |
|---|---|---|---|
| **E1** KAFAS HBA demo mode | `5D 2E D3 A6 01` (`DEMO_MODE_FLA`) | `5D 2E D3 A6 00` | KAFAS04 |
| **E2** BDC HBA demo routine, camera limits | `40 31 01 A5 39 01` + 13 × `00` (`LICHT_FLA_DEMO_MODUS`, `SCHALTER_KAMERA` = 1: the glare-free limits come from KAFAS's camera; distance and zone angles fixed 0, never set by the app) | `40 31 02 A5 39` (stop routine), `40 31 03 A5 39` read first (results) | BDC_G05 |

Safeguards (all in `experiments.js`, all tested):
- the unit must have answered `22 F150` as the SGBD the bytes come from; otherwise the experiment is
  refused ("these bytes are from BDC_G05; this car has …")
- **stationary in P on live data**: speed 0, selector P; the kit's demo drive never counts. The
  interlock is checked again every 2 s and a lost interlock ends the run
- the start button is pressed **twice within 4 s**; a blocked experiment only says why
- one run lasts at most **60 s**, and any press stops it
- switched back at stop, timeout, lost interlock, any refusal, and **at the next app start** if the
  app was stopped mid-run (`data/experiment-journal.json`)
- `NRC 7E/7F`: one retry in the extended session (`10 03`), kept alive with `3E 00`, `10 01` at the
  end. `NRC 33` (security access): stops; **`27` is never sent**. A missing stop routine (`NRC 12`):
  `10 01`, and the screen says an ignition cycle is the final revert
- E1 has **no read-back** in KAFAS04 (`D3A6` is write-only) and may persist: check the car after an
  ignition cycle (test procedure)
- E2 **may switch the headlights**: aim at a wall, nobody in front

Verdict: from the cluster's indicator (`2520`), read before, every 2 s during, and after:
"CAME ON (green)", "stayed off", "already on", or "could not be read". KAFAS's recommendation,
switch-off reasons and active-time counter are recorded alongside. Each run is saved with every frame
to `data/reports/experiment-<id>-<time>.json`.

**What a result would mean.** If the indicator comes on, that is the first hard evidence of a head-unit
path. It is still a demo mode, though, so before any Enable button it must also be shown that KAFAS
keeps switching normally: high beam off for oncoming traffic, on in the dark. That needs a supervised
night test, not a parked one. If the indicator stays off in both experiments, the evidence points
back at the enabling code or the button (the probe's findings).

## Evidence (why there is no Enable button yet)

Labels: **FACT** = read from BMW's SGBD or DTC text; **INFERENCE** = drawn from facts, not yet
observed on this car.

Revisions read: BDC_G05 **rev 1.000, "Teststand for 8.46.10"** (a test-bench build, not
necessarily your car's production SGBD), BDC_G11 rev 12.002, BDC (R62) rev 22.094, KAFAS04 rev
8.000. Items 3 and 4 below rest on BDC_G05 rev 1.000 until the production file is checked (test
procedure step 0).

1. **FACT.** Your earlier DIDs don't mean "HBA state". `0xD580` is `LENKSTOCK_BLINKER_TASTER_FLA`,
   the stalk button's raw input (read-only, BDC2015 / BDC_G11). `0xD57E` is `LWR_MODUS`, the
   headlight levelling mode, on every BDC variant. On BDC-03 (BDC_G05, "ab SP18") `D580` does not
   exist; the button is byte 6 of `0xE3B8 LENKSTOCK_BLINKER`, also read-only. (The app still reads
   `D580` once on a BDC-03 and reports it if the car's firmware answers.)
2. **FACT.** The BDC's per-profile HBA memory `0xD555 STAT_PIA_FLA_EIN` is marked "no longer used from
   SP2018" in BDC_G05.
3. **FACT.** BDC_G05 lets diagnostics *simulate* many buttons and inputs (SARAH button `DC84`, door
   contacts `5024`-`5027`, tailgate buttons, child-lock button `D18C`). None of them is the stalk
   or its HBA button.
4. **FACT.** The only HBA *write* jobs are demo modes. BDC_G05 `31 A539 LICHT_FLA_DEMO_MODUS`
   ("for presentations and diagnosis") takes explicit glare-free zone angles or the camera's limits.
   KAFAS04 `2E D3A6 DEMO_MODE_FLA` switches a showroom demo mode. BDC `2E D542 LEUCHTEN_FUNKTION`
   switches the high-beam lamp directly. **INFERENCE:** the demo modes bypass at least the normal
   activation logic, and the lamp job also bypasses KAFAS's glare detection. So none of them is an
   Enable button. The two demo jobs run only as reversible, measured *Experiments*. The lamp job is
   never sent, and E2 is sent only with the camera's limits (`SCHALTER_KAMERA` = 1).
5. **FACT** (DTC texts). The HBA signal chain is: the BDC reads the stalk (LIN from the SZL) and
   sends `0x1EE` "operation of steering column button" to KAFAS. The BDC also sends `0x36A`
   "status high-beam assistant" to KOMBI (the indicator) and KAFAS, plus a SOME/IP event
   `0x353B-0x001` "driver assistance, high beam". KAFAS answers with `0x292` "control high-beam
   assistant" to the BDC. **INFERENCE:** on/off is decided from the BDC's button input, so the
   head unit could only reach it by an HMI-level request (if the firmware has one) or by forging the
   BDC's own messages. Forging them is rejected: it impersonates the BDC on E2E-protected channels,
   fights the real BDC's messages, and is the "LIN as CAN" idea in another form.
6. **FACT** (KAFAS04). KAFAS will not run HBA unless its enabling code `E482` is
   `EC_Operational` (or `EC_Not_Needed`). The coding table `TAB_C_FLA_ON_OFF` has a state `0x11 FLA
   Prepared`, and fault `800A21 FLA_FSC_Missing` exists. **INFERENCE:** an HBA that "did not work
   even before any coding" fits a missing enabling code / FSC at least as well as a dead button.
   The probe settles it in one run.

## Phase 2: what the probe's answer leads to

| Probe result | Meaning | Next step |
|---|---|---|
| `E482` ≠ Operational, or `800A21` / `800A01` stored | KAFAS has HBA switched off / not enabled | No button emulation can help. Fix the enabling (BMW dealer / proper FA + coding of KAFAS); this app doesn't touch FSCs or coding |
| Button test: stalk pushes / flash counted, **0 HBA presses although each was held ~1 s**; or SZL fault `030342` / `030343` | the button or its contact in the SZL is faulty | replace the stalk / SZL; the app re-tests it |
| **Experiment E1 or E2: cluster indicator CAME ON** | a diagnostic job reaches the HBA function from the head unit | supervised night test of that experiment: does KAFAS still dip for oncoming traffic? Only then an Enable / Disable built on it |
| Experiments: indicator stayed off in both | the demo jobs don't touch the activation state | the enabling code / button rows decide |
| Button test: HBA presses counted, `E482` Operational, `E474` active time stays 0 | the button reaches the BDC but HBA never engages | check the conditions on the KAFAS page (`D341`: daylight, speed, town); light switch in **AUTO**; try the lever gesture (below) |
| Interfaces page lists a **writable** HBA field / method | the HMI has an HBA switch | Phase 2: Enable / Disable via that interface, confirmed by `E474` active time rising and the indicator. Built and verified on the car only then |
| none of the above | no clean head-unit path on this firmware | BLOCKED, with the saved reports as evidence |

**Worth trying first (UNVERIFIED for this exact car):** BMW's US FAQ describes HBA activation as
*light switch in AUTO, low beam on, then tap the turn-signal / high-beam lever toward high beam*. On
cars without that gesture it's *press the button on the lever*. If your car uses the gesture, a
"dead button" may be the wrong press. The KAFAS page shows the active-time counter rising when HBA
engages.

## Test procedure (repeatable)

Vehicle **stationary, parking brake on, P**, ignition on (a battery charger is a good idea). Nothing
in the car is changed by any step.

0. **On the laptop (no car needed).** Open your ISTA / EDIABAS `Ecu\BDC_G05.prg` (the production
   file, newer than the rev 1.000 read here) in Tool32, or with the `ediabasx` CLI (`jobs`, `tables`).
   Search the jobs and the `SG_FUNKTIONEN` table for `FLA`, `FERNLICHT`, `LENKSTOCK` and `SZL` rows
   whose SERVICE has `2E`, `2F` or `31`. A *simulation* entry for the stalk's HBA button there would
   be a new candidate, so send it back before anything is written. Do the same for `KAFAS04.prg`.
1. Open *High Beam Assistant*. Note that the Findings page says "Press Run checks" (nothing sent yet).
2. **Run checks.** About 15 s. Findings shows BDC / KAFAS variants, enabling code, calibration,
   counters and faults.
3. **Button test** (20 s): press and **hold** the HBA button ~1 s, 3 times, then push the stalk
   forward once and pull it once. The control inputs (push / pull) prove the BDC is answering. The
   app reads the button many times a second, but a quick tap can still fall between two reads, so
   "0 HBA presses" only means a faulty button if each press was held.
4. Light switch to **AUTO**, low beam on. Press the HBA button (or use the lever gesture). **The
   cluster's HBA indicator is the check**: note whether it lights. Wait 60 s, then **Run checks**
   again. A rising HBA active-time counter (`E474`) confirms it. An unchanged counter proves
   nothing: KAFAS may store it only at the end of a drive cycle.
5. **Experiments** (stationary, P, parking brake, aimed at a wall, nobody in front of the car):
   Settings, Experiment, *E1*. Run checks, then press *Start / stop experiment* twice. Watch the
   cluster for 60 s; the Experiment page shows the indicator as KOMBI reports it, every 2 s.
   Then the same with *E2* (the headlights may switch). Set Experiment back to *Off*. Switch the
   ignition off and on, then Run checks once more: everything should read as before step 5. If it
   doesn't, a demo mode persisted, so say so.
6. Collect the evidence from your PC:
   `HU=root@<unit-ip> KEY=~/.ssh/id_mgu kit/tools/hba-mgu-probe.sh`. This copies and scans the
   unit's SOME/IP catalog, lists HMI resources that name the high beam assistant, and pulls the
   app's reports and log into `hba-probe-<time>/`. It is read-only.
7. Send the folder (or the Findings page) back. Each row of the Phase 2 table maps to a next step.

## Install

From a fork of `idrive7-apps` that has this folder at `apps/hba_assist/` (the Store's repo-tree
source builds every `apps/*` folder; `mgu-repo.json` needs no change):

- **MGU Store:** add / refresh the repo as a source, install *High Beam Assistant*. The head unit
  builds it with its own SDK (Node 8.16; the app is checked against Node 8.16.2's parser).
- **Kit by hand:** `python3 kit/tools/build.py hba_assist`, then
  `deploy/make-car-kit.sh hba_assist && HU=root@<unit> KEY=~/.ssh/id_mgu deploy/push-to-car.sh install`.

App id `hba_assist`, logging id `OAB1` (unused by the kit's and the Store's apps).

## Development

```sh
node kit/tools/test_hba_assist.js                              # guard, decoders, probe, button test, catalog, pages
python3 kit/tools/build.py hba_assist --preview-only           # no SDK needed
node kit/tools/preview_hba.js dist/hba_assist --scenario off   # pages vs a simulated car -> preview/hba-sim-off/
```

The simulated car (`kit/tools/hba_fake_car.js`) answers through the same TASU frame format the
head unit uses, so `kit/runtime/diag.js` parses it as on the car. It is a simulation: none of
this has run on a real car yet.
