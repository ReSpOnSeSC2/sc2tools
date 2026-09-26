# Replay-guided reinforcement learning

`runs/response-league/reward-config.json` now selects `tactical-economy-v2`, which supplies feedback during every game observation. An isolated 360-second neural check loaded v2, completed with finite in-memory PPO, and preserved both checkpoints and the league manifest (`runs/neural-spending-attention-verification-20260925-v1/diagnostic.json`). Its Terran learner did not incur a bank penalty; excess-bank/grace/cap behavior remains verified by focused tests, and learning benefit is unmeasured. The next committed training game will use v2. PPO changes policy weights after the game. The league reads this file once at the next game boundary, so a running game keeps its original reward rules. Check the file and the latest match's `viewer.json` / `match.json` to distinguish configured from actually running settings.

Winning remains the main objective: victory earns +10, defeat -10, and a draw or time limit earns zero terminal reward. All auxiliary rewards and penalties together have an absolute episode budget of 4. The league requires gamma=1. Even using the full auxiliary allowance, a victory returns at least +6, a draw stays between -4 and +4, and a defeat returns at most -6. This preserves outcome ordering in undiscounted episode returns; it does not guarantee that PPO will find a winning policy.

| Feedback | Episode budget | What earns it |
|---|---:|---|
| Economy | 0.35 | Additional minerals and gas actually collected, rather than changes to the bank |
| Production | 0.80 | First observed completion of new workers, army, structures, expansions and upgrades; small bonus for suitable counters |
| Combat | 1.30 | Observed enemy damage and confirmed kills valued by mineral + 1.5 × gas cost, minus confirmed own losses; workers and bases receive extra economic-damage weight |
| Macro penalties | 0.20 | Time supply blocked below 200 supply, and observable avoidable worker/production idleness |
| Scouting | 0.35 | First observed enemy base (+0.35) and previously unseen enemy army/non-base structure types (+0.04 each, sharing the same budget) |
| Replay progress | 0.30 | New completed assets that improve coverage of the selected replay's current worker, building and army composition |
| Unspent-resource penalty | 0.70 | Sustained resource banks above the reserves, after a grace period and below 190 used supply |

Each budget is a separate lifetime absolute allowance: positive and negative feedback consume it without replenishment, and exhausting one does not consume another. Raw signals remain available for audit after their applied reward is capped. The v1 profile remains supported as the code default, with production 1.20, macro 0.25, scouting 0.60, and no bank penalty. V2 reallocates these budgets to the bank penalty and reduces the ordinary structure coefficient from 0.0005 to 0.00015; its worker and army coefficients are unchanged.

Production values a completed asset at minerals + 1.5 × gas, multiplied by 0.0008 for workers or 0.0006 for army. A newly observed completed 50-mineral worker therefore earns +0.04 before the shared production cap; a 100-mineral army unit earns +0.06. Suitable army counters can add 0.0002 × asset value. Structures use 0.00015, expansions 0.0003, and upgrades 0.0004. The initial observed assets establish a baseline, and each eligible tag can earn completion credit only once. Protoss unit and structure completion credit still requires permitted camera observation; completed upgrades come from its own HUD information.

Selections, camera moves, queued orders and rejected commands do not earn rewards. They are necessary steps toward productive actions, and retain their normal action cost. Direct payment for repeated clicks would teach input spam. Spending or lowering the bank receives no positive reward, and cancelling/refunding an unfinished asset earns no completion credit. Waste and cancel cycles have no separate reward. An actual new completed asset can still earn its category's bounded completion reward even if it proves strategically unhelpful; this is not a test of spending quality.

## Resource-bank feedback

V2 allows reserves of 400 minerals and 200 gas. From ordinary own resource and supply HUD values, it computes `min(2, max(0, minerals / 400 - 1) + max(0, gas / 200 - 1))`. Only the excess above each reserve contributes. Continuous excess starts a 20-game-second grace period; after that, the penalty subtracts 0.002 × this normalized excess per game second, capped at a deduction of 0.004 per second and 0.70 over the entire episode. For example, 800 minerals and 200 gas produces -0.002 per second after the grace period.

Returning both resources to their reserves or below resets the grace timer. The signal is also disabled and its timer reset at 190 or more used supply, or when any required HUD value is unavailable. Accrual uses the previous observation for the elapsed interval, including time spent waiting for inputs. Reducing a bank can stop future penalties but does not refund penalties already applied, restore the episode allowance, or create positive reward. The grace period and reserves allow ordinary saving; the signal cannot determine whether a larger planned purchase is strategically justified.

## Replay guidance

`runs/reward-targets-v1.json` contains 36 original winning ReSpOnSe training trajectories: 12 per matchup, with 344 minute snapshots of completed living own units. Every source hash, player identity, victory and eight-worker start was verified. The 18 held-out games and the 36 losing training games do not supply these positive Protoss targets. Opponent build bootstrapping keeps its separate, previously configured 2× sampling weight for builds that defeated ReSpOnSe.

Each Protoss game chooses one same-matchup trajectory, fixed for that game. Production receives a bounded bonus for improving coverage against the same current target frame. Moving into a later minute, changing camera, matching the initial eight Probes, or producing surplus units cannot independently earn this bonus. Coverage weights are workers 25%, army 45%, buildings 30%, renormalized over categories present in the target.

This guides phase timings and compositions; it is not exact replay action playback. The policy does not yet receive an explicit selected-build input. Consequently it learns across the reference distribution rather than following a named build on command. A recurrent, build-conditioned policy and improved gameplay-command imitation remain separate future improvements.

## Observation limits and deliberate approximations

Protoss remains at 200 APM with the existing camera, spatial-selection and fog contract. Its reward collector receives on-screen own units and visible enemies, plus its ordinary own resource/supply/upgrade information. Terran and Zerg retain 600 APM and their broader own-unit/current-visible-enemy contract. No reward uses global enemy kill scores or hidden enemy inventories.

Damage is credited only below each known target's previous lowest health/shield fraction. Healing, revisiting a target and duplicate death notifications cannot reset the ledger. Leaving sight is not a death. Death credit requires a previously observed asset whose last position is currently visible, and inside the Protoss camera when applicable. This intentionally misses some off-screen losses and kills.

Counter production uses a conservative public weapon/attribute heuristic against enemy types observed earlier. It is a hint, not a complete tactical counter model: numbers, positioning, upgrades and abilities matter. Actual fighting outcomes carry more weight. Same-tag morphs receive conservative production credit to avoid paying repeatedly for reversible forms. Temporary summons and hallucinations are excluded.

## Runtime controls and terminal outcomes

The scout correction allows only one designated Probe per game, even after it dies; Observers and Warp Prisms remain valid scouts. Repeating a scout choice cannot recruit another Probe. Accepted spatial commands establish the designation, so a failed selection is not treated as a completed dispatch. These controls do not grant scouting reward: only the existing observed base/type discoveries do.

An economy resignation requires zero workers, fewer than 50 minerals (or the public Probe cost), and no permitted evidence of a queued Probe or possible refundable production, research or construction. Known off-screen work remains uncertain until observable evidence resolves it. The bot leaves through SC2, and its terminal result is defeat: -10 under the dense profile, with the normal auxiliary budget retained. The decision and evidence are recorded. A user-interrupted or disconnected match with incomplete results is rejected rather than awarded a synthetic win or loss.

Terran/Zerg strategic commitments last five game seconds, with a one-second response exception for relevant currently observed combat pressure. Remembered enemy-building locations come from previous sightings. Resource-aware placement and legal expansion geometry improve where a policy-selected building can be placed. None of these command or placement helpers earns a reward by itself; production credit still requires observed completion, and combat credit still requires the existing visible evidence.

Reusing the action forward pass's critic value removes duplicate inference at each decision. Reward sampling still runs on every engine observation, including input waits. Game steps, history, gamma, camera/fog restrictions and action limits are unchanged. Validate and activate these corrections between games; their implementation alone does not demonstrate better play.

## Coaching and assessment

Use `scripts/training_reward_report.py --league runs/response-league` at recurring checks. Inspect committed reward components, confirmed completions, resource collection, combat value and command proportions separately for each learner and reward version. Compare with actual match outcomes and frozen, unweighted standard evaluations; a larger shaped reward alone does not establish improvement.

Any tuning must create a reviewable configuration, pass relevant checks, and activate only between games. Preserve completed checkpoints, reference files, whole-replay separation, STOP markers and fair-play limits. Do not continually increase auxiliary rewards merely because the bot can collect them. If production and combat remain absent across a useful sample, diagnose action availability, imitation balance and credit assignment before repeating the same training indefinitely.

The pre-change imitation set contained 5,904 gameplay-command examples among 45,001 training examples (about 13%). Selected-model held-out gameplay accuracy was about 34%. Training had not demonstrated reliable play against Very Easy. These measurements explain why replay availability is not evidence of learned strategy. Neither reward totals nor computer difficulty are ladder MMR.
