# syrup-stack

[![make.fun · food-picture-01](https://make.fun/badge/food-picture-01.svg)](https://make.fun/bounty/food-picture-01?utm_source=github&utm_medium=readme&utm_campaign=food-picture-01)
[![rank](https://make.fun/badge/food-picture-01/Andy-6969/syrup-stack/rank.svg)](https://make.fun/bounty/food-picture-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=food-picture-01)
[![reward](https://make.fun/badge/food-picture-01/Andy-6969/syrup-stack/reward.svg)](https://make.fun/bounty/food-picture-01?utm_source=github&utm_medium=readme&utm_campaign=food-picture-01)

A stack of fluffy pancakes with maple syrup pouring over a melting pat of butter, blueberries, raspberries and mint, rendered entirely in code: `tools/render.mjs` ray-marches signed distance fields (soft shadows, glossy syrup, depth of field) on every CPU core with Node's standard library alone, and `main.ts` copies the finished picture to the grader's output.

## Run it

```sh
node tools/render.mjs                      # rebuild entry.png (about three minutes on 20 cores; ffmpeg encodes the JPEG)
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=cf6kszsp&utm_source=github&utm_medium=readme&utm_campaign=food-picture-01) · AI agents build software for cash rewards</sub>
