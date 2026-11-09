# High Beam Assistant for BMW iDrive 7 (MGU)

An app for the iDrive 7 head unit (MGU) that tests BMW's high beam assistant (HBA). It was built
for a 2021 G30 LCI 530e (BDC-03, KAFAS4, FLM2) whose HBA button on the stalk doesn't work. The app
is a **test tool**. It does **not** turn HBA on for driving.

Full technical details: [apps/hba_assist/README.md](apps/hba_assist/README.md).

## Install on the car

The car needs the MGU Store (or this repo's kit) already set up on the head unit.

1. In the MGU Store, add this repo as a source: `https://github.com/HodgCodg/idrive7-apps`
   (default branch `hba-assist`).
2. Refresh, then install **High Beam Assistant**. The head unit builds it itself.

## What it does

| Button | What happens | Sends to the car |
|---|---|---|
| **Run checks** | Reads the BDC, the front camera (KAFAS), both headlights and the cluster: the HBA enabling code, calibration, why HBA switched off, HBA usage time, the HBA light in the cluster, stored faults | reads only (`22`, `19 02`) |
| **Button test** | 20 s: hold the HBA button ~1 s three times, then push and pull the stalk once each. Shows whether the BDC ever sees the HBA button | reads only |
| **Start / stop experiment** | Hidden until you pick one in Settings → Experiment. Runs one of BMW's own HBA demo jobs for at most 60 s, parked in P, and reports whether the cluster's HBA light came on. Then switches it back off | `2E D3A6` (E1) or `31 A539` (E2), plus diagnostic session control |

Settings → Experiment ships **Off**. While it is Off the app only reads.

## Can it switch HBA on?

Not yet. BMW's diagnostic descriptions for these units have **no command that does what the stalk
button does**. The only HBA jobs that write anything are two demo / showroom modes, and those are
the experiments above. If one of them lights the cluster's HBA indicator, that is the first
working path. It would still need a night test to show the camera keeps dipping the beam for
oncoming traffic before it could become an On / Off button. If neither lights it, the fix is a new
steering column switch.

## Safety and what it leaves behind

- No flashing, coding, FSC or security access (`27`). The app can only send a fixed list of
  messages; anything else is refused before it reaches the car. Programming history and flash
  counters can't change.
- Experiments run only parked in P at 0 km/h. They stop after 60 s or when you press the button
  again, and they are switched back off at the next app start if the app was closed mid-run.
- BMW's fault tables list no fault code for the demo jobs. To be sure, read all fault and info
  memories with ISTA before and after, and compare. Any new entry there is clearable.

## This repo

A fork of [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)
(MIT, see [LICENSE](LICENSE)), which provides the kit, the build and the other apps. Its original
README is [README.idrive7-apps.md](README.idrive7-apps.md).
