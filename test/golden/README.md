# Golden results

The simulation is deterministic: the same seed and inputs give the same battle and the same match, bit for bit. These
files record the exact outcome of a fixed corpus of seeded scenarios, so a change that alters gameplay — even one meant
to be a pure refactor that only reorders random draws, hook order or iteration order — fails loudly instead of slipping
through.

- `tools/golden.mjs` builds the corpus from `data/*.json` (fixed order, fixed seeds) and reduces every scenario to a
  digest. Its header documents the families and the digest fields.
- `test/golden/<family>.json` hold the digests (`roster`, `bonds`, `fields`, `matches`, `standins`, `diy`).
- `test/golden.test.js` recomputes them and compares. On a mismatch it prints the scenario, the field and old → new.

本分支的 0.1.4 基线保留模式名单只过滤干员池、不限制盟约激活的策略，以及单人 ×1、多人随存活人数缩放的 Boss 血量。
相对上游 v0.1.4，7 个 roster、20 个 Boss/隐秘核心 fields、10 个 matches 场景的记录因此变化，bonds 不变。
合并时在独立临时副本中仅还原这些本分支规则后，全部 133 个场景与上游基线一致；当前文件记录本分支规则下的结果。

2026-10-07 合并 v0.2.0 (`1303321`) 时，在独立副本仅还原 Boss 配置、盟约激活和相关 AI 策略，全部 283 个上游场景一致。
本分支基线相对该标签变化 7 个 roster、3 个 matches 和 2 个 standins；bonds、fields、diy 不变。
变化保留模式名单只限制干员池的策略，并修正该策略暴露的泡泡与“余音”互相反伤递归；受击脉冲标记为反伤，直接攻击脉冲保持原行为。
“碎铳之簧”的无来源反伤补齐 sourceless 标记；两处均有 `test/sim/feedback5-counters-any-damage.test.js` 回归用例，更新后全部场景无模拟错误。

2026-10-07 修复 #282：联防保留本回合地形和设备，逃脱模板只提供漏怪重入批次与路线。更新前完整比对确认只有 7 个 matches 改变：
`coop2-NORMAL-3`、`coop2-HARD-4`、`coop3-ABYSS-5`、`coop4-FUNNY-6`、`coop4-ABYSS-7`、`coop2-NORMAL-8-serverrun`、`coop2-NORMAL-14-standins`。
差异来自联防中保留围栏、箱子和平台后敌人的路径、伤害与漏怪变化，继而影响生命值及后续回合；其余 276 场景不变。
仅更新上述 7 个基线。回归覆盖一人/两人联防、援助者独立拆箱、所有当前地图路径可达性以及客户端/服务器模拟一致性。

## The corpus

2026-10-11 合并 v0.2.4（`bc50cac0`）：完整 287 场景通过。相对本分支合并前，仅原有 18 个 matches
及 `diy-135`、`diy-136` 变化，新增 `coop2-NORMAL-1-coverage-standins` 和
`coop2-NORMAL-5-coverage-diy`；roster、bonds、fields、standins 记录不变。
matches 的变化来自共享干员/装备库存、库存过滤及拟态物质规则影响阵容和随机抽取，
两个 DIY 场景来自克莱门莎 S2 溅射与飞行目标触发修正（上游 §29.12）。没有移除原场景。

在独立副本中，只还原本分支 Boss 配置/人数倍率、模式盟约激活及相关 AI 规则、两处既有反伤差异，
全部 287 场景与目标标签一致。主合并副本未临时覆盖这些规则。
本分支相对该标签仍有 8 个 roster、3 个 matches、2 个 standins 不同；
这些模式盟约/AI 差异已经在独立副本验证，bonds、fields、diy 与标签一致。

2026-10-07 合并 v0.2.1（`c2a2ef7`）：在独立副本只还原本分支 Boss 配置、盟约激活及相关 AI 策略，并还原“余音”反伤防递归与“碎铳之簧”无来源反伤修复后，完整 283 场景与标签一致。当前工作树没有临时还原这些规则。

相对本次上游基线，仅更新 7 个 roster（`roster-005`、`roster-011`、`roster-017`、`roster-023`、`roster-029`、`roster-041`、`roster-047`）、3 个 matches（`solo-FUNNY-1`、`solo-FUNNY-2`、`coop4-FUNNY-6`）和 1 个 fields（`hidden-boss_10-solo`）。前两族差异来自模式名单不限制盟约激活及 AI 策略；fields 差异已在独立副本验证来自保留的“余音”反伤修复。bonds、diy 及本分支已有的 standins 基线不变；standins 相对上游仍保留此前 2 个规则差异场景。满潜能、敌人缩放、突袭和联防的新上游结果均保留。

| family | what runs |
|---|---|
| `roster` | 49 battles: every visible chess record (normal and elite) with every selectable skill and module (DESIGN §16), 12 operators per battle on a real stage (all 11 in turn) against the round's real wave three times over, every non-leader enemy kind of `data/enemies.json` as extra spawns (half of them bounties), placeable summons on the board, every equipment item, band, battle-side 机变 card and stage map card in turn, bonds from the board |
| `bonds` | 46 battles: every bond at its activation threshold (1 layer) and at its top tier (999 layers) |
| `fields` | 22 battles: every Final Assault / Hidden Core leader on a pair and a solo template (shared pool, 200 s cap) and the 联防 field with 1 and 2 helpers on the round's stage, both halves (carried HP / SP, a knocked-out operator, two leakers' enemies) |
| `matches` | 20 matches to the end in virtual time: 16 bot-only (solo 标准 / 险境 / 绝境 / 终极 × 2 seeds, co-op 2 / 3 / 4, one server-run combat match, two runs boosted to the Hidden Core), one co-op match whose human seat (AI 托管, offline) does not own 9 NORMAL chess — they fight as their 补位 stand-ins (its digest lists them per round, `standIns`) — and one whose human seat slots 自选 picks (推进之王 and prototypes) with its 调度中心 at level 5 from the first prep: its own shop draws them and its AI fields 推进之王 (its digest lists per round the 自选 shop draws and the fielded pieces, `diy`) |
| `standins` | 10 battles: every NORMAL chess record (normal and elite, 110) fielded as its 补位 stand-in (`standIn: true`: the stand-in's body, backup skill / module and kit — all 17 stand-ins, every skill a chess names for them), 12 per battle by strength band, laid out by the stand-in's position on a real stage, against the round's real wave three times over plus 8 ground enemy kinds (melee stand-ins always meet an enemy), an item each, bonds from the board |
| `diy` | battles of 自选 pieces (a DIY slot with its `diy` pick, `shared/diy.js`): every owned 6★ with an operator kit (`kits/index.js OPERATOR_KITS`) in each form of tiers 5 and 6 (normal; elite with no module and with each module) under each skill, then every prototype pick with a kit at its locked selection, normal and elite, 12 per battle against the round's real wave; a new operator kit adds its scenarios (the battle count grows with the kits) |

Battles go through the production BattleSpec path (`server/sim/spec.js`, as browsers and the server's headless fields
run them); matches construct `Match` directly with a `VirtualScheduler`. Every option is explicit, so a change to a
test-harness default never moves a digest.

What a digest ignores on purpose (it does not affect gameplay): object key order, engine unit ids (snapshot ids are
renumbered by first appearance, units are named by board uid or def id), board piece uids, the order of client events
within a tick (they are counted, not hashed) and wall-clock time. Damage / healing sums are rounded to integers and HP
to 2 decimals.

`npm test` runs the fast subset (the scenarios marked `"fast": true`: every chess record with its default loadout,
every stage and every non-leader enemy kind, every bond at its top tier, six fields, seven matches, the five stand-in
battles of the normal records, the first 自选 battle of the operator kits and of the prototypes — 62 of the 151). `GOLDEN_FULL=1` checks everything.

## Workflow

```sh
GOLDEN_FULL=1 node --test test/golden.test.js   # the whole corpus (≈ 20 s with 4 worker threads)
node --test test/golden.test.js                 # the fast subset
npm run golden                                  # the same comparison from the tool (all families, a short report)
npm run golden:update                           # recompute and rewrite test/golden/*.json
node tools/golden.mjs --twice                   # determinism: the corpus twice in one process, the second pass reversed
```

- **A refactor commit must never change these files.** Run `GOLDEN_FULL=1 node --test test/golden.test.js` before
  committing it. If a digest moves, the refactor changed behaviour: find out why (the first differing value of `snaps`
  says when two runs parted, in 10-game-second steps) instead of updating the files.
- **An intended gameplay change** (a fix, new content, a data rebuild): run `npm run golden:update` and commit the
  changed files together with the change, saying in the commit message which scenarios moved and why.
- **Reviewing the diff:** every scenario is a block of its own and every unit / enemy / round is one line, so a diff
  shows which scenarios moved and which values changed. A change confined to the scenarios that contain the touched
  operator, enemy or rule is expected; a change everywhere (every `rngDraws`, every `snaps`) means something global
  moved — the RNG draw order, the tick order, a shared rule.
- **Adding to the corpus** (a new family, more scenarios, a new digest field) changes the files by design: do it in a
  commit of its own, never together with a refactor.
- A new engine hook, event or chess record does not change the digests of the existing scenarios by itself — the
  hook list is frozen in the tool and the corpus is regenerated only on `golden:update` — but new data records do join
  the corpus there (the roster family enumerates `data/chess.json`).

After the measured shared-stock update (DESIGN §29.8), the original stand-in / DIY seeds remain as outcome regressions even when they field no such operator. Companion seeds `coop2-NORMAL-1-coverage-standins` and `coop2-NORMAL-5-coverage-diy` exercise those full paths; the corpus now contains 287 scenarios.
