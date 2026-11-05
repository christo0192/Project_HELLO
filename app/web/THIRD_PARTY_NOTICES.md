# THIRD-PARTY NOTICES

This document lists the third-party software and adapted open-source
patterns used by the HELLO web application, together with the licenses
that govern their use.

## Apache ECharts — Apache License 2.0

ECharts (package `echarts`, v6) is used for dashboard visualizations via a
tree-shaken core (`src/components/charts/echarts.ts`).

- Project: https://echarts.apache.org
- License: Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0)

## echarts-for-react — MIT License

echarts-for-react (package `echarts-for-react`, v3) is the React binding
used by `src/components/charts/EChart.tsx`.

- Project: https://github.com/hustcc/echarts-for-react
- License: MIT — Copyright (c) 2017 hustcc

## bklit-ui — MIT License (patterns adapted)

A small chart interaction pattern was adapted from the MIT-covered
`packages/ui/src/charts/` directory of bklit-ui
(https://github.com/bklit/bklit-ui). Adapted files and the patterns they
borrow:

- `src/components/charts/legend-hover.tsx` — adapted from
  `chart-legend-hover.tsx` (legend hover index contract).
- `src/components/design/Skeleton.tsx` — deterministic chart-skeleton bar
  heights from `loading-sweep.tsx` (implemented natively; never random).

No source is copied verbatim; each adaptation is marked with a scoped
comment in the file. Nothing is taken from the proprietary
`packages/studio` directory of bklit-ui.

### MIT License

Copyright (c) 2026 uixmat

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## transitions.dev — no license, zero reuse

Jakubantalik/transitions.dev was evaluated and found to carry **no license**
(no LICENSE/COPYING file at repository root or in source files, and no
license grant in the README). Consistent with the project policy, **zero
code and zero CSS** are copied from transitions.dev; its patterns were used
as conceptual inspiration only, and all animations are implemented natively
with CSS in this repository. No attribution is owed.
