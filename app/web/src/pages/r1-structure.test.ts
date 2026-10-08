import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural guards for the R1 candidate surface.
 *
 * PR-6 adds camera, role-play and phase UI beside the live legacy audio join.
 * These checks pin the boundaries that keep the two apart: the legacy files
 * are never edited to know about R1, R1 never reaches a legacy route or the
 * recording path, and the only things R1 may store or call are the ones the
 * plan names.
 */

const ROOT = process.cwd();

function read(relative: string): string {
  return readFileSync(resolve(ROOT, relative), 'utf8');
}

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(resolve(ROOT, directory))) {
    const relative = join(directory, name).replace(/\\/g, '/');
    if (statSync(resolve(ROOT, relative)).isDirectory()) found.push(...walk(relative));
    else found.push(relative);
  }
  return found;
}

const LEGACY_SCANNED = [
  'src/pages/CandidateJoinPage.tsx',
  'src/components/candidate-join/AudioReadinessStep.tsx',
  'src/components/candidate-join/InterviewerAura.tsx',
];

const R1_FILES = [
  ...walk('src/lib/r1'),
  ...walk('src/components/candidate-r1'),
  'src/pages/R1JoinPage.tsx',
].filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.(ts|tsx)$/.test(file));

const R1_TSX = R1_FILES.filter((file) => file.endsWith('.tsx'));

describe('R1 is a separate surface from the legacy candidate join', () => {
  it('finds the R1 sources it is guarding', () => {
    expect(R1_FILES.length).toBeGreaterThanOrEqual(15);
    expect(R1_FILES).toContain('src/pages/R1JoinPage.tsx');
    expect(R1_FILES).toContain('src/lib/r1/r1-api.ts');
  });

  it('keeps the three files candidate-webrtc-structure scans free of any R1 knowledge', () => {
    for (const file of LEGACY_SCANNED) {
      const source = read(file);
      expect(source, `${file} mentions R1`).not.toMatch(/\bR1\b|\br1\b|candidate-r1|lib\/r1/);
      expect(source, `${file} grew a camera path`).not.toMatch(
        /createLocalVideoTrack|getUserMedia\(\{\s*video|VideoCapture/,
      );
    }
  });

  it('still scans exactly those three files', () => {
    const structure = read('src/pages/candidate-webrtc-structure.test.ts');
    expect(structure).toContain("'src/pages/CandidateJoinPage.tsx'");
    expect(structure).toContain("'src/components/candidate-join/AudioReadinessStep.tsx'");
    expect(structure).toContain("'src/components/candidate-join/InterviewerAura.tsx'");
  });

  it('is routed beside, not through, the legacy join route', () => {
    const app = read('src/App.tsx');
    expect(app).toContain('path="/candidate/r1"');
    expect(app).toContain('path="/candidate/join"');
    expect(app).toMatch(/lazyPage\(\(\) => import\('\.\/pages\/R1JoinPage'\), 'R1JoinPage'\)/);
  });
});

describe('R1 never touches the legacy or recording paths', () => {
  const LEGACY_CONSENT = new RegExp(
    [
      'candidateConsentStatus',
      'submitCandidateConsent',
      'getCandidateConsentTemplate',
      '\\/api\\/candidate-consent',
    ].join('|'),
  );
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['browser recording', /MediaRecorder/],
    ['the legacy completion call', /completeCandidateScreening/],
    ['the legacy recording upload', /uploadCandidateRecording/],
    ['the legacy exchange and preflight', /exchangeCandidateInvite|candidateLiveKitPreflight/],
    ['the legacy consent API', LEGACY_CONSENT],
    ['any legacy LiveKit route', /\/api\/livekit\//],
    ['the shared api module', /from '\.\.\/(\.\.\/)?api'/],
    ['the spoofable speaker attribute', /hello_speaker/],
    ['raw HTML injection', /dangerouslySetInnerHTML|innerHTML/],
    ['console output', /console\.(log|warn|error|info|debug)/],
    ['local storage', /localStorage/],
  ];

  for (const [what, pattern] of FORBIDDEN) {
    it(`has no reference to ${what}`, () => {
      for (const file of R1_FILES) {
        const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(code, `${file} references ${what}`).not.toMatch(pattern);
      }
    });
  }

  it('declares every /api path in the one client module', () => {
    for (const file of R1_FILES) {
      const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
      if (file === 'src/lib/r1/r1-api.ts') continue;
      expect(code, `${file} hard-codes an API path`).not.toMatch(/['"`]\/api\//);
      expect(code, `${file} calls fetch directly`).not.toMatch(/\bfetch\(/);
    }
  });

  it('keeps session storage inside the one link module', () => {
    for (const file of R1_FILES) {
      if (file === 'src/lib/r1/r1-link.ts') continue;
      expect(read(file), `${file} touches web storage`).not.toMatch(/sessionStorage/);
    }
  });
});

describe('R1 trusts only the agent', () => {
  it('reads the phase, the speaker and the other attributes only through the agent-kind rule', () => {
    const room = read('src/lib/r1/r1-room.ts');
    expect(room).toContain('isAgentParticipant');
    expect(room).toContain('trustedSignals');
    expect(room).not.toMatch(/\.attributes\b/);
    const agent = read('src/lib/r1/r1-agent.ts');
    expect(agent).toContain('ParticipantKind');
    expect(agent).toMatch(/participant\.kind === agentKind/);
  });

  it('has no phase parsing outside the vocabulary module', () => {
    for (const file of R1_FILES) {
      if (file === 'src/lib/r1/r1-phase.ts' || file === 'src/lib/r1/r1-agent.ts') continue;
      const rawPhase = /attributes\??\.\s*phase|\[['"]phase['"]\]/;
      expect(read(file), `${file} reads a raw phase attribute`).not.toMatch(rawPhase);
    }
  });

  it('reads the learner name, the clock and the ready flag only in the agent module', () => {
    for (const file of R1_FILES) {
      if (file === 'src/lib/r1/r1-agent.ts') continue;
      const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const raw = /attributes\??\.\s*(leadname|rpleft|awaiting)|\[['"](leadname|rpleft|awaiting)['"]\]/;
      expect(code, `${file} reads a raw agent attribute`).not.toMatch(raw);
    }
  });

  it('sends "I\'m ready" through the one API client, never over the room', () => {
    // The candidate token cannot publish data (canPublishData: false is a pinned security
    // control), and the browser must not try: the server relays the signal.
    for (const file of R1_FILES) {
      const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${file} publishes data from the browser`).not.toMatch(
        /\b(publishData|performRpc|sendText|sendBytes|setAttributes|setMetadata)\b/,
      );
    }
    expect(read('src/lib/r1/r1-api.ts')).toContain("ready: '/api/r1/ready'");
    expect(read('src/pages/R1JoinPage.tsx')).toContain('r1Api.ready(');
  });
});

describe('R1 live view fits the window and bounds its captions', () => {
  // jsdom has no layout, so the chain of heights that makes the captions list the only
  // scroller is pinned here; e2e/candidate-r1.e2e.ts measures it in a real browser.
  const css = read('src/styles/candidate-r1.css');

  it('locks the desktop shell to the viewport height, with a modifier the page opts into', () => {
    // 480, not 600: a real window is the screen minus the taskbar and the browser's bars, so a
    // 1080p laptop at 150% is about 1280x580 and must stay two columns. 860, not 769: the stage
    // beside the 360 px column is only 440 px wide there, which is what the aura (at least 132 px)
    // and the 200 px camera need side by side; narrower windows get the one-column layout.
    expect(css).toMatch(/@media \(min-width: 860px\) and \(min-height: 480px\) \{/);
    expect(css).not.toMatch(/min-width: 769px/);
    expect(css).toMatch(/\.candidate-shell--fill \{[^}]*height: 100dvh;[^}]*overflow: hidden/);
    expect(css).toMatch(/\.candidate-shell--fill \.r1-live \{[^}]*grid-template-rows: minmax\(0, 1fr\)/);
    expect(read('src/pages/R1JoinPage.tsx')).toMatch(/<R1Shell fill=\{stage\.name === 'live'\}>/);
  });

  it('lets the stage scroll inside its card rather than clip when the window is short', () => {
    expect(css).toMatch(/\.candidate-shell--fill \.r1-live__stage \{[^}]*overflow-y: auto/);
  });

  it('makes the captions list, and only the list, the scroller of the right column', () => {
    expect(css).toMatch(/\.r1-live \.candidate-interview__captions \{[^}]*flex: 1 1 0;[^}]*min-height: 140px/);
    expect(css).toMatch(/\.r1-captions__body \{[^}]*min-height: 0/);
    expect(css).toMatch(/\.r1-captions__list \{[^}]*min-height: 0;[^}]*overflow-y: auto/);
  });

  it('restyles the scenario card at once, so the captions list is resized once and not again a frame later', () => {
    // The global reduced-motion rule gives every property a 0.01 ms transition; without this the card
    // is half restyled at the commit and finishes later, with no render and no observer callback.
    expect(css).toMatch(/\.r1-scenario, \.r1-scenario \* \{ transition: none !important; \}/);
  });

  it('keeps the browser from moving the captions list, and gives its content one box to observe', () => {
    // R1Captions owns the scroll position: scroll anchoring would shift it when a web font re-wraps the
    // lines above the viewport and report that as the reader scrolling away.
    expect(css).toMatch(/\.r1-captions__list \{[^}]*overflow-anchor: none/);
    // The lines' bottom margins stay inside the box R1Captions observes (a margin that collapsed
    // through it would change the content's height without changing the box).
    expect(css).toMatch(/\.r1-captions__content \{[^}]*display: flow-root/);
  });

  it('sizes the aura from the window height so the controls keep their room', () => {
    expect(css).toMatch(/\.candidate-aura \{[^}]*width: clamp\(168px, calc\(100dvh - 600px\), 420px\)/);
  });

  it('lets the aura give way to the camera, so a narrow stage never wraps them or spills the aura out', () => {
    // The height-derived aura (up to 420 px) is wider than a narrow stage holds beside a 200 px
    // camera: it shrinks (to no less than 120 px) rather than the row wrapping under it.
    expect(css).toMatch(/\.candidate-shell--fill \.r1-live__media \{[^}]*flex-wrap: nowrap/);
    expect(css).toMatch(/\.candidate-aura \{[^}]*flex: 0 1 auto;[^}]*min-width: 120px/);
    expect(css).not.toMatch(/\.candidate-aura \{[^}]*flex: none/);
  });

  it('lets a phone scroll the page and bounds the captions card instead', () => {
    expect(css).toMatch(/@media \(max-width: 859px\), \(max-height: 479px\)/);
    expect(css).not.toMatch(/max-width: 768px/);
    expect(css).toMatch(/\.r1-live \.candidate-interview__captions \{[^}]*height: clamp\(240px, 45dvh, 440px\)/);
  });

  it('never crushes the candidate\'s camera: the self-view keeps its box and sits beside the aura', () => {
    // A flex item that may shrink is squeezed before the stage's scroll valve is used (it was 0 to
    // 38 px high on a 1280x720 window). It does not shrink, and it costs no height beside the aura.
    expect(css).toMatch(/\.r1-live__selfview \{[^}]*flex: none;[^}]*width: 200px/);
    expect(css).toMatch(/\.r1-live__media \{[^}]*display: flex;[^}]*flex-wrap: wrap/);
    expect(read('src/components/candidate-r1/R1LiveView.tsx')).toMatch(
      /<div className="r1-live__media">\s*<InterviewerAura[\s\S]*?\/>\s*<div className="r1-selfview r1-live__selfview">/,
    );
  });

  it('has a short-window variant that gives the chrome up before the interview', () => {
    expect(css).toMatch(
      /@media \(min-width: 860px\) and \(min-height: 480px\) and \(max-height: 740px\) \{[^@]*\.r1-live__stage \{[^}]*gap: 8px/,
    );
    expect(css).toMatch(/\.r1-scenario--compact \{/);
  });

  it('squeezes the aura and the camera below 580 px so the controls stay in the stage card', () => {
    // Under 580 px high (590 on a narrow stage, which wraps one more line) the tallest states
    // (camera off, a failed "I'm ready") need more than the card has: the aura gives up 28 px and
    // the camera shrinks to 168x95, still whole, and the controls stay inside the card.
    const block = css.match(
      /@media \(min-width: 860px\) and \(min-height: 480px\) and \(max-height: 579px\),\s*\(min-width: 860px\) and \(max-width: 999px\) and \(min-height: 480px\) and \(max-height: 589px\) \{([^@]*)\}\s*\n/,
    );
    expect(block, 'the squeeze block').not.toBeNull();
    expect(block![1]).toMatch(/\.candidate-aura \{[^}]*width: 104px/);
    expect(block![1]).toMatch(/\.r1-live__selfview\.r1-selfview \{[^}]*width: 168px/);
  });

  it('clips the decorative blobs of the R1 shell, which would add blank scroll', () => {
    expect(css).toMatch(/\.r1-shell \{ overflow: clip; \}/);
  });
});

describe('R1 publishes the plan camera budget and nothing else', () => {
  it('has the 640x360, 15 fps, 500 kbps, no-simulcast numbers in exactly one module', () => {
    const media = read('src/lib/r1/r1-media.ts');
    expect(media).toMatch(/R1_VIDEO_WIDTH = 640/);
    expect(media).toMatch(/R1_VIDEO_HEIGHT = 360/);
    expect(media).toMatch(/R1_VIDEO_FPS = 15/);
    expect(media).toMatch(/R1_VIDEO_MAX_BITRATE = 500_000/);
    expect(media).toMatch(/simulcast: false/);
    for (const file of R1_FILES) {
      if (file === 'src/lib/r1/r1-media.ts') continue;
      expect(read(file), `${file} restates a budget number`).not.toMatch(/\b(640|360|500_000)\b/);
    }
  });

  it('never asks for a screen share', () => {
    for (const file of R1_FILES) {
      const screenShare = /getDisplayMedia|ScreenShare|screen_share/i;
      expect(read(file), `${file} uses screen share`).not.toMatch(screenShare);
    }
  });
});

describe('R1 styling stays inside the candidate palette', () => {
  const COLOURS = 'gray|slate|zinc|red|green|blue|amber|yellow|indigo|purple|pink|white|black';
  const UTILITIES = 'bg|text|border|ring|from|to|via';
  const STOCK_PALETTE = new RegExp(`\\b(?:${UTILITIES})-(?:${COLOURS})(?:-\\d{2,3})?\\b`);
  const RAW_COLOUR = /#[0-9a-fA-F]{3,8}\b/;

  it('uses no stock Tailwind palette utility or raw colour in R1 components', () => {
    for (const file of R1_TSX) {
      const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${file} uses a stock palette utility`).not.toMatch(STOCK_PALETTE);
      expect(code, `${file} has a raw colour`).not.toMatch(RAW_COLOUR);
    }
  });

  it('keeps the house type rules: no uppercase, no open tracking, no layout transitions', () => {
    const css = read('src/styles/candidate-r1.css');
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
    const open = [...css.matchAll(/letter-spacing:\s*(-?[\d.]+)em/g)].filter(
      (match) => parseFloat(match[1]) > 0,
    );
    expect(open).toEqual([]);
    for (const [, value] of css.matchAll(/transition:\s*([^;}]+)/g)) {
      expect(value).not.toMatch(/\b(?:height|width|padding|margin)\b/);
    }
    expect(css).not.toMatch(/animation:/);
  });

  it('mirrors only the local preview, never the video that is published', () => {
    const css = read('src/styles/candidate-r1.css');
    expect(css).toMatch(/\.r1-selfview video \{[^}]*scaleX\(-1\)/);
  });
});
