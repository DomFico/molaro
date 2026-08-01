# Writing a Molaro mod

A **mod** is one self-contained Python file that runs *next to your data* — on the
cluster, in the producer process — and puts its result on screen. Writing the file
**is** the install: the extension watches the mods directory and hot-reloads on save.

This document exists because the contract used to be reassembled from five places (a
TypeScript parser, a docstring, a validator, a fixture, and a source file). Everything
you need is here.

---

## 1. The file

```python
# molaro-mod
# name: end_to_end
# kind: analysis
# produces: per-frame-series
# description: End-to-end distance per frame (nm).

import numpy as np

def compute(data, target_indices):
    ...
    return values
```

The header is the schema. `# molaro-mod` must be the first line; a malformed header
means the viewer **ignores the file silently**, which is why §5 starts with a parse check.

| field | required | meaning |
|---|---|---|
| `# name:` | yes | the command you type. **Must equal the filename** (`end_to_end.py`) |
| `# kind:` | yes | `analysis` |
| `# produces:` | yes | one of the seven kinds in §3 |
| `# axis:` | for `per-point-scalar` | `color`, `size` or `opacity` |
| `# channel:` | for `channel` | the channel's name — the single source, never returned from `compute` |
| `# edge-group:` | for `edges` | default group name for authored edges |
| `# requires-channel:` | no | one channel name; its provider runs FIRST, automatically |
| `# param:` | no | `<name> <type> <default…>` — see §4 |
| `# description:` | recommended | shown by `mods` and `help <name>`; write it for a stranger |
| `# author:` / `# source:` | no | attribution, displayed and never fetched |

The closed sets, which the parser enforces:

- **`produces`** — `per-point-scalar`, `per-frame-series`, `scatter`, `commands`,
  `figure`, `channel`, `edges`
- **`axis`** — `color`, `size`, `opacity`
- **`param` types** — `number`, `string`, `boolean`, `color`, `choice`, `hint`

---

## 2. The `data` object

`compute(data, target_indices)` — and `compute(data, target_indices, params)` if the mod
declares parameters. The third argument is **positional and by arity**: declare params,
take three; declare none, take two.

| member | what it is |
|---|---|
| `data.trajectory` | a live `mdtraj.Trajectory`, or **`None`** on the synthetic source |
| `data.labels[i]` | `(category, group, subgroup)` for point `i` — the exact strings the address grammar matches |
| `data.edges[e]` | `(i, j)` — the connectivity the viewer **DRAWS** |
| `data.channel(name)` | a declared channel, `(n_frames, n_points, components)` float32 read-only, or `None` |
| `data.neighborhood(idx, distance, keep)` | points near `idx`, grown to whole subgroups |
| `data.give_header()` | the header, including the live channel list |
| `data.frame_stride`, `data.n_frames_in_file` | what was sampled, and what exists |

**The index-alignment guarantee, which is load-bearing:** point `i` in header order is
atom `i` in `trajectory.topology` and column `i` in `trajectory.xyz`. Use it directly.

**`target_indices`** is the resolved target, in trajectory atom order. **An empty list
means the whole system** — not "nothing".

Three traps, each of which has caused a real bug:

- **`data.edges` is NOT `topology.bonds`.** The header's edge list is the file's declared
  bonds **plus** covalent inference minus cross-box pairs. On a membrane system the
  topology declares 50,495 bonds and the viewer draws 173,940, and a CONECT-less ligand
  has *nothing* in `topology.bonds`. Any mod reasoning about connectivity must read
  `data.edges`.
- **Never infer a label.** `chr(65 + chain.index)` is right only by luck; take names from
  `data.labels`, or you silently match nothing while reporting success.
- **`data.trajectory` can be `None`.** Check it and fail closed, or the synthetic source
  crashes your mod with an unrelated error.

---

## 3. What to return, per `produces`

| `produces` | return | notes |
|---|---|---|
| `per-point-scalar` | `list[float]`, one per `target_indices`, **all in [0, 1]** | mapped through one ramp onto `# axis:` |
| `per-frame-series` | `list[float]`, length `trajectory.n_frames` | drawn in the plot tab with a synced playhead |
| `commands` | `list[str]` — Molaro commands | executed as **one undo stroke**; the composable kind |
| `channel` | `{"values": [...], "components": 1\|3, "min"?: float, "max"?: float}` | **must NOT carry `name`** — the header's `# channel:` is the single source |
| `edges` | `[[i, j], ...]`, or `{"pairs": [...], "visibility": [n_frames][n_pairs]}` | drawn in an isolated pass; the mask makes edges appear/vanish per frame |
| `scatter` | `{"x": [...], "y": [...]}` | click a point to seek to that frame |
| `figure` | a figure spec | when the plot kinds are not enough |

**A channel is WHOLE-SYSTEM.** `target_indices` does not shrink it — the length check is
`n_frames × n_points × components` over *every* point. Compute zeros outside the target;
where a channel *applies* is the `bind` target's job.

---

## 4. Parameters

```
# param: window number 5
# param: style choice ribbon tube
# param: frame hint current
```

Invoked as `mymod <target> ?window=7 ?style=tube`.

- `choice` **restricts** to its list and tab-completes it.
- `hint` **suggests** its list and accepts anything — for a value whose legal domain is
  wider than any list (`current` *or* any frame index). Validate the rest in `compute`.
- `color` tab-completes CSS colour names.
- A parameter forwards to a `# requires-channel:` provider **only if the provider also
  declares that name.**

**A neighbourhood flag on a macro is inert.** The sequencer runs the provider *first*,
with the target as typed — so `?within` must be declared on the **provider**, not on the
`commands` mod that binds it.

---

## 5. Testing one without the editor

Three levels, each catching a different class of error.

**Level 1 — does the header parse?** A malformed header makes the viewer ignore the file
with no message, so check it first:

```bash
node --input-type=module -e "
import { parseModFile } from './webview/recipes.ts';
import { readFileSync } from 'node:fs';
console.log(parseModFile(readFileSync(process.argv[1], 'utf-8'), 'workspace'));
" ~/.molaro/mods/end_to_end.py
```

**Level 2 — does it run over the real protocol?** `producer.serve.run_mod` is the same
entry point the extension host drives, so a mod that passes here behaves identically in
the viewer — and you get the timing to compare against `molaro.modTimeoutSeconds`.

**Level 3 — are the numbers right?** Recompute independently and compare.

> **A third opinion catches what a second cannot.** A real example: a distance mod and its
> independent check agreed, because both made the same assumption — and
> `mdtraj.compute_distances` disagreed by up to 3.03 nm, because it applies the
> **minimum-image convention** whenever the trajectory carries unit cells. On a pulled
> chain that is wrong: past half the box, the image folds the distance back and the
> extension silently stops growing. Two agreeing implementations are not a check if they
> share a premise.

---

## 6. Conventions worth copying

From the eleven shipped mods, and each earned:

- **Fail closed with a sentence naming the fix.** Never return zeros for "I could not
  compute this" — a confident wrong picture is worse than an error.
- **Reduce in float64.** mdtraj stores float32; a float32 reduction drifts ~1e-3 nm, which
  broke a 1e-4 tolerance gate.
- **Derive the vocabulary at run time.** Do not hardcode the element or residue names your
  test system happens to have — a mod outlives the system it was written on.
- **Respect `target_indices`.** A mod that quietly does the whole system when given a
  selection is reporting one thing and doing another.
- **Put measured facts in comments.** Numbers you checked, with what you checked them
  against. This codebase's strongest habit.
- **Explain a categorical picture with `note`.** A colouring the user cannot read is
  half-finished; emit `note <text>` naming what each colour means.

---

## 7. Where mods live

`molaro.modsDir`, else `~/.molaro/mods`. `~` expands. The setting is **machine-scoped**:
a path from your laptop is never meaningful on a cluster, and the two must not sync.

Shipped mods live in `<extension>/mods` and load as `built-in`. **A same-named mod in your
own directory shadows a shipped one** — the way to customise one without losing the
original.

Saving over an existing mod preserves the displaced file as `<name>.py.<timestamp>.bak`;
the loader only registers `*.py`, so a backup can never come back as a mod.

`~/.molaro/mods` is outside any repository. If a mod matters, put it in one — those files
are one `rm -rf` from gone.
