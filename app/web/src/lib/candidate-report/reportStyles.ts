/**
 * The report's own stylesheet. The report is a standalone document, not an app
 * surface, so it mirrors the app's tokens (tinted neutrals, one calm accent,
 * IBM Plex with a system fallback) instead of importing the app's components.
 *
 * - Fonts: IBM Plex is named first but never embedded or fetched (the file must
 *   work offline and stay small), so most readers get their system sans.
 * - Colour: tinted neutrals, no pure black or white. Light by default; dark
 *   under `prefers-color-scheme`. Text pairs are AA or better.
 * - Print: players are hidden, the transcript is fully expanded, rows do not
 *   split across pages. "Print, Save as PDF" is the PDF route.
 * - No animation at all, so there is nothing for reduced-motion to switch off.
 */
export const REPORT_CSS = `
:root {
  color-scheme: light dark;
  --bg: #f4f5f9;
  --panel: #fbfbfd;
  --sunken: #eceef5;
  --ink: #1b2130;
  --ink-2: #4a5266;
  --line: #d9dce8;
  --accent: #2b4fa0;
  --accent-bg: #e6ebf8;
  --pos: #1f6b46;
  --pos-bg: #e1f2e8;
  --warn: #8a5a00;
  --warn-bg: #fbf0d9;
  --neg: #a1262c;
  --neg-bg: #fae6e6;
  --active: #dfe7fa;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #12151d;
    --panel: #1a1e29;
    --sunken: #222735;
    --ink: #e7eaf3;
    --ink-2: #a9b1c6;
    --line: #333a4d;
    --accent: #9db7f5;
    --accent-bg: #26335a;
    --pos: #7fd1a1;
    --pos-bg: #1c3a2a;
    --warn: #f0c26a;
    --warn-bg: #3d3115;
    --neg: #f29a9e;
    --neg-bg: #43211f;
    --active: #2b3a66;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 15px/1.55 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  overflow-wrap: anywhere;
}
main { max-width: 62rem; margin: 0 auto; padding: 24px 16px 56px; }
h1, h2, h3, h4 { line-height: 1.25; margin: 0; }
h1 { font-size: 1.9rem; letter-spacing: -0.01em; }
h2 { font-size: 1.2rem; margin-bottom: 12px; }
h3 { font-size: 1rem; margin: 18px 0 8px; }
h4 { font-size: 0.9rem; margin: 14px 0 6px; color: var(--ink-2); }
p { margin: 0 0 8px; }
ul, ol { margin: 0; padding-left: 1.2rem; }
a { color: var(--accent); }
.eyebrow { font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-2); margin-bottom: 6px; }
.sub { color: var(--ink-2); margin-top: 6px; }
.muted { color: var(--ink-2); }
.small { font-size: 0.85rem; }
.mono, .num { font-variant-numeric: tabular-nums; }
.banner {
  margin: 18px 0 0; padding: 10px 14px; border: 1px solid var(--line);
  border-radius: 10px; background: var(--warn-bg); color: var(--warn); font-weight: 500;
}
nav.toc { margin: 18px 0 0; display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 0.9rem; }
section.panel {
  margin-top: 22px; padding: 18px 20px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 14px;
}
.strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 12px; margin: 0; }
.strip div { padding: 10px 12px; background: var(--sunken); border-radius: 10px; }
.strip dt { font-size: 0.75rem; color: var(--ink-2); text-transform: uppercase; letter-spacing: 0.05em; }
.strip dd { margin: 2px 0 0; font-size: 1.35rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.strip dd small { font-size: 0.8rem; font-weight: 400; color: var(--ink-2); }
dl.facts { display: grid; grid-template-columns: minmax(7rem, 11rem) 1fr; gap: 6px 16px; margin: 0; }
dl.facts dt { color: var(--ink-2); }
dl.facts dd { margin: 0; }
.tag { display: inline-block; padding: 1px 9px; margin: 0 6px 6px 0; border-radius: 999px; background: var(--accent-bg); color: var(--accent); font-size: 0.82rem; }
.tag.pos { background: var(--pos-bg); color: var(--pos); }
.tag.warn { background: var(--warn-bg); color: var(--warn); }
.tag.neg { background: var(--neg-bg); color: var(--neg); }
.notice { padding: 10px 14px; border-radius: 10px; background: var(--sunken); margin: 10px 0; }
.notice.warn { background: var(--warn-bg); color: var(--warn); }
.table-wrap { overflow-x: auto; }
.table-wrap:focus-visible { outline: 2px solid var(--accent, currentColor); outline-offset: 2px; }
table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-top: 1px solid var(--line); }
th { color: var(--ink-2); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; border-top: 0; white-space: nowrap; }
tr { break-inside: avoid; }
.score { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.call { margin: 14px 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); }
.call h4 { margin-top: 0; color: var(--ink); font-size: 0.95rem; }
audio { display: block; width: 100%; max-width: 34rem; margin-top: 8px; }
ol.transcript { list-style: none; margin: 8px 0 0; padding: 0; }
ol.transcript li {
  display: grid; grid-template-columns: 4.2rem 1fr; gap: 4px 12px;
  padding: 8px 10px; border-radius: 8px; break-inside: avoid;
}
ol.transcript li[data-who="Bot"] { background: transparent; }
ol.transcript li[data-who="Candidate"] { background: var(--sunken); }
ol.transcript li[data-active="true"] { background: var(--active); outline: 2px solid var(--accent); }
.ts { font: inherit; font-size: 0.82rem; font-variant-numeric: tabular-nums; padding: 2px 6px; min-height: 28px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--accent); cursor: pointer; align-self: start; }
.ts:hover { background: var(--accent-bg); }
.ts:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ts-plain { font-size: 0.78rem; color: var(--ink-2); align-self: start; padding-top: 3px; }
.who { display: block; font-size: 0.78rem; color: var(--ink-2); font-weight: 600; margin-bottom: 1px; }
.turn-text { white-space: pre-wrap; margin: 0; }
footer.report-foot { margin-top: 28px; font-size: 0.85rem; color: var(--ink-2); }
@media (max-width: 600px) {
  h1 { font-size: 1.5rem; }
  section.panel { padding: 14px 14px; }
  dl.facts { grid-template-columns: 1fr; gap: 0; }
  dl.facts dt { margin-top: 8px; font-size: 0.8rem; }
  ol.transcript li { grid-template-columns: 1fr; }
}
@media print {
  :root { color-scheme: light; --bg: #fefefe; --panel: #fefefe; --sunken: #f1f1f5; --active: #f1f1f5; }
  body { font-size: 11pt; background: #fefefe; }
  main { max-width: none; padding: 0; }
  section.panel { border-color: #bbbbc8; break-inside: auto; }
  audio, nav.toc, .ts { display: none; }
  .ts-plain-print { display: inline; }
  ol.transcript li { grid-template-columns: 3.4rem 1fr; }
  a { color: inherit; text-decoration: none; }
  @page { margin: 16mm; }
}
@media screen { .ts-plain-print { display: none; } }
`;
