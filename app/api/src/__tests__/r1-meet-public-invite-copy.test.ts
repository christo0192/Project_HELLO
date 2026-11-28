/**
 * M035 S05 T2: the words of Lexy's calendar invite for a public booking
 * (lib/r1/meet/public/invite-copy.ts).
 *
 * Pinned here: the full description text (an inline snapshot, with the run-time manage token
 * replaced by <TOKEN> before the snapshot, so no token literal lives in this file); the Google
 * client's limits (at most 4096 UTF-16 units, no character its description rule refuses) and the
 * brief's 8 KB; the facts the candidate needs (laptop or phone with Chrome, no Google account, an
 * AI interviewer, the recording, the manage link once, where to ask for help); what it never holds
 * (the old interviewer name, a candidate name or email, the Meet link); the event summary; and the
 * strict refusal of a bad name or link.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GOOGLE_CALENDAR_DESCRIPTION_MAX_LENGTH,
  GOOGLE_CALENDAR_SUMMARY_MAX_LENGTH,
} from '../integrations/google/calendar.js';
import { R1_MEET_DEFAULT_PROFILE_ID, getR1MeetProfile } from '../lib/r1/meet/profiles.js';
import {
  R1_MEET_PUBLIC_EVENT_SUMMARY,
  R1_MEET_PUBLIC_INVITE_MAX_CHARS,
  buildR1MeetPublicInviteDescription,
} from '../lib/r1/meet/public/invite-copy.js';
import { mintR1MeetManageToken, r1MeetPublicManageLink } from '../lib/r1/meet/public/manage-token.js';
import { BRIDGE_PAGE_URL, BRIDGE_SOURCE } from './support/r1-meet-harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB_FILES = ['invite-copy.ts', 'manage-token.ts'].map((name) =>
  path.join(here, '..', 'lib', 'r1', 'meet', 'public', name),
);

/** The Google client's description rule (`integrations/google/calendar.ts`, newline allowed). */
const GOOGLE_UNSAFE_MULTILINE = /(?!\n)[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
/** The same rule without the newline exemption (the summary). */
const GOOGLE_UNSAFE_LINE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const DEX = /\bDex\b/;

const NAME = getR1MeetProfile(R1_MEET_DEFAULT_PROFILE_ID)!.botDisplayName;

/** A fresh token and its link, built at run time (never a literal). */
function freshLink(): { token: string; link: string } {
  const minted = mintR1MeetManageToken({ source: BRIDGE_SOURCE })!;
  expect(minted).not.toBeNull();
  const link = r1MeetPublicManageLink(BRIDGE_PAGE_URL, minted.token)!;
  expect(link).not.toBeNull();
  return { token: minted.token, link };
}

const count = (text: string, part: string): number => text.split(part).length - 1;

describe('buildR1MeetPublicInviteDescription: the full text', () => {
  it('is exactly the plan text, with the profile name and the run-time link', () => {
    expect(NAME).toBe('Lexy');
    const { token, link } = freshLink();
    const text = buildR1MeetPublicInviteDescription({ interviewerName: NAME, manageLink: link })!;
    expect(text).not.toBeNull();
    expect(count(text, token)).toBe(1);
    expect(text.split(token).join('<TOKEN>')).toMatchInlineSnapshot(`
      "Your R1 interview with Lexy, Interview Kickstart's AI interviewer.

      How to join
      - At the interview time, open the Google Meet link in this invite ("Join with Google Meet").
      - Use a laptop, or a phone with the Chrome browser. You do not need a Google account.
      - Allow microphone access when your browser asks, and join from a quiet place.

      What to expect
      - Lexy is an AI interviewer, not a person. She runs the interview over Google Meet.
      - The call is recorded so that the hiring team can review your interview.

      Move, cancel or withdraw
      - Use your personal link. It works until the interview ends:
        https://hello.example.test/book/manage#m=<TOKEN>
      - Please do not share or forward this link: anyone who has it can change your booking.

      Questions? Reply to the hiring team's email that sent you the booking link. Replies to this calendar invite are not read."
    `);
  });

  it('is deterministic for one input, and a new token gives a new text', () => {
    const { link } = freshLink();
    const a = buildR1MeetPublicInviteDescription({ interviewerName: NAME, manageLink: link });
    const b = buildR1MeetPublicInviteDescription({ interviewerName: NAME, manageLink: link });
    expect(a).toBe(b);
    const other = buildR1MeetPublicInviteDescription({ interviewerName: NAME, manageLink: freshLink().link });
    expect(other).not.toBe(a);
  });
});

describe('buildR1MeetPublicInviteDescription: limits and the Google rule', () => {
  it('stays within 4096 UTF-16 units (the Google client cap) and 8192 UTF-8 bytes, even with the longest name', () => {
    expect(R1_MEET_PUBLIC_INVITE_MAX_CHARS).toBe(4096);
    expect(R1_MEET_PUBLIC_INVITE_MAX_CHARS).toBe(GOOGLE_CALENDAR_DESCRIPTION_MAX_LENGTH);
    const { link } = freshLink();
    for (const name of [NAME, 'L', 'L'.repeat(40), `Ann-Marie O'Neil Jr.`]) {
      const text = buildR1MeetPublicInviteDescription({ interviewerName: name, manageLink: link })!;
      expect(text, name).not.toBeNull();
      expect(text.length, name).toBeLessThanOrEqual(4096);
      expect(Buffer.byteLength(text, 'utf8'), name).toBeLessThanOrEqual(8192);
    }
  });

  it('answers null rather than a text over the cap (a link with an absurdly long host)', () => {
    const { token } = freshLink();
    const linkFor = (host: string): string => `https://${host}/book/manage#m=${token}`;
    const fixed = buildR1MeetPublicInviteDescription({ interviewerName: NAME, manageLink: linkFor('h') })!;
    // The longest host that still fits exactly at the cap, and one character more.
    const room = R1_MEET_PUBLIC_INVITE_MAX_CHARS - fixed.length;
    const fits = buildR1MeetPublicInviteDescription({ interviewerName: NAME, manageLink: linkFor('h'.repeat(1 + room)) });
    expect(fits).not.toBeNull();
    expect(fits!.length).toBe(R1_MEET_PUBLIC_INVITE_MAX_CHARS);
    expect(buildR1MeetPublicInviteDescription({ interviewerName: NAME, manageLink: linkFor('h'.repeat(2 + room)) })).toBeNull();
  });

  it('is printable ASCII and newlines only, so the Google description rule never matches', () => {
    const { link } = freshLink();
    const text = buildR1MeetPublicInviteDescription({ interviewerName: NAME, manageLink: link })!;
    expect(text).toMatch(/^[\x20-\x7e\n]+$/);
    expect(GOOGLE_UNSAFE_MULTILINE.test(text)).toBe(false);
    expect(text).not.toMatch(/\r|\t/);
    expect(text).not.toMatch(/ \n|\n$/);
    expect(Buffer.byteLength(text, 'utf8')).toBe(text.length);
  });
});

describe('buildR1MeetPublicInviteDescription: what it says and never says', () => {
  it('carries the manage link exactly once, on its own line', () => {
    const { token, link } = freshLink();
    const text = buildR1MeetPublicInviteDescription({ interviewerName: NAME, manageLink: link })!;
    expect(count(text, link)).toBe(1);
    expect(count(text, token)).toBe(1);
    expect(text.split('\n')).toContain(`  ${link}`);
  });

  it('states every fact the candidate needs', () => {
    const { link } = freshLink();
    const text = buildR1MeetPublicInviteDescription({ interviewerName: NAME, manageLink: link })!;
    for (const fact of [
      'Lexy',
      'Google Meet',
      'laptop',
      'phone',
      'Chrome',
      'You do not need a Google account',
      'AI interviewer',
      'not a person',
      'recorded',
      'microphone',
      'Move, cancel or withdraw',
      'It works until the interview ends',
      'do not share or forward this link',
      "Reply to the hiring team's email",
      'Replies to this calendar invite are not read',
    ]) {
      expect(text, fact).toContain(fact);
    }
  });

  it('never holds the old interviewer name, an email, the Meet link, a placeholder or a candidate name', () => {
    const { link } = freshLink();
    const text = buildR1MeetPublicInviteDescription({ interviewerName: NAME, manageLink: link })!;
    expect(text).not.toMatch(DEX);
    expect(text).not.toMatch(/christy/i);
    expect(text).not.toContain('@');
    expect(text).not.toContain('meet.google.com');
    expect(text).not.toMatch(/[{}<>]/);
    expect(text).not.toMatch(/\b(?:Dear|Hi|Hello)\b/);
    // An extra field (a candidate name) is never read.
    const sentinel = 'Zedsentinel Qwvx';
    const withExtra = buildR1MeetPublicInviteDescription({
      interviewerName: NAME,
      manageLink: link,
      candidateName: sentinel,
      email: 'sentinel@example.test',
    } as unknown as Parameters<typeof buildR1MeetPublicInviteDescription>[0]);
    expect(withExtra).toBe(text);
    expect(withExtra).not.toContain(sentinel);
  });

  it('no shipped word of either lib file names the old interviewer, comments included', () => {
    for (const file of LIB_FILES) {
      const source = readFileSync(file, 'utf8');
      expect(source, path.basename(file)).not.toMatch(DEX);
      expect(source, path.basename(file)).not.toMatch(/christy/i);
    }
  });
});

describe('R1_MEET_PUBLIC_EVENT_SUMMARY', () => {
  it('is 1..200 characters of printable ASCII, names Lexy and never the old name', () => {
    expect(R1_MEET_PUBLIC_EVENT_SUMMARY).toBe('Interview Kickstart R1 with Lexy (AI interviewer)');
    expect(R1_MEET_PUBLIC_EVENT_SUMMARY.length).toBeGreaterThanOrEqual(1);
    expect(R1_MEET_PUBLIC_EVENT_SUMMARY.length).toBeLessThanOrEqual(200);
    expect(R1_MEET_PUBLIC_EVENT_SUMMARY.length).toBeLessThanOrEqual(GOOGLE_CALENDAR_SUMMARY_MAX_LENGTH);
    expect(R1_MEET_PUBLIC_EVENT_SUMMARY.trim()).toBe(R1_MEET_PUBLIC_EVENT_SUMMARY);
    expect(R1_MEET_PUBLIC_EVENT_SUMMARY).toMatch(/^[\x20-\x7e]+$/);
    expect(GOOGLE_UNSAFE_LINE.test(R1_MEET_PUBLIC_EVENT_SUMMARY)).toBe(false);
    expect(R1_MEET_PUBLIC_EVENT_SUMMARY).toContain('Lexy');
    expect(R1_MEET_PUBLIC_EVENT_SUMMARY).not.toMatch(DEX);
    expect(R1_MEET_PUBLIC_EVENT_SUMMARY).not.toMatch(/christy/i);
  });
});

describe('buildR1MeetPublicInviteDescription: strict inputs', () => {
  it('accepts names of a letter then up to 39 name characters', () => {
    const { link } = freshLink();
    for (const name of ['L', 'Lexy', 'L'.repeat(40), "Ann-Marie O'Neil Jr."]) {
      expect(buildR1MeetPublicInviteDescription({ interviewerName: name, manageLink: link }), name).not.toBeNull();
    }
  });

  it('refuses a bad interviewer name', () => {
    const { link } = freshLink();
    for (const name of [
      '',
      ' Lexy',
      '-Lexy',
      '1exy',
      'L'.repeat(41),
      'Lexy\n',
      'Lexy\u200b',
      'L\u00e9xy',
      'Lexy<b>',
      'Lexy, sent you',
      'Lexy@x',
    ]) {
      expect(buildR1MeetPublicInviteDescription({ interviewerName: name, manageLink: link }), JSON.stringify(name)).toBeNull();
    }
    for (const name of [undefined, null, 42, ['Lexy']]) {
      expect(
        buildR1MeetPublicInviteDescription({ interviewerName: name as unknown as string, manageLink: link }),
      ).toBeNull();
    }
  });

  it('accepts exactly a manage link r1MeetPublicManageLink answers, a non-default port included', () => {
    const { token } = freshLink();
    const withPort = r1MeetPublicManageLink('https://hello.example.test:8443/candidate/r1/meet', token)!;
    expect(withPort).not.toBeNull();
    expect(buildR1MeetPublicInviteDescription({ interviewerName: NAME, manageLink: withPort })).toContain(withPort);
  });

  it('refuses a bad manage link', () => {
    const { token, link } = freshLink();
    for (const bad of [
      '',
      `http://hello.example.test/book/manage#m=${token}`,
      `https://hello.example.test/book/manage?m=${token}`,
      `https://hello.example.test/book/manage/#m=${token}`,
      `https://hello.example.test/book#m=${token}`,
      `https://hello.example.test/candidate/r1/meet#t=${token}`,
      `https://HELLO.example.test/book/manage#m=${token}`,
      `https://user@hello.example.test/book/manage#m=${token}`,
      `https://hello.example.test/book/manage#m=${token.slice(1)}`,
      `https://hello.example.test/book/manage#m=${token}x`,
      `https://hello.example.test/book/manage#m=${token.slice(1)}=`,
      `https://hello.example.test/book/manage#t=${token}`,
      `${link} `,
      ` ${link}`,
      `${link}\n`,
      `javascript:alert(1)//${link}`,
      'https://hello.example.test/book/manage#m=',
    ]) {
      expect(buildR1MeetPublicInviteDescription({ interviewerName: NAME, manageLink: bad }), JSON.stringify(bad)).toBeNull();
    }
    for (const bad of [undefined, null, 42, new URL(link)]) {
      expect(buildR1MeetPublicInviteDescription({ interviewerName: NAME, manageLink: bad as unknown as string })).toBeNull();
    }
  });

  it('refuses a missing or non-object input', () => {
    for (const bad of [undefined, null, 'Lexy', 42, []]) {
      expect(
        buildR1MeetPublicInviteDescription(bad as unknown as Parameters<typeof buildR1MeetPublicInviteDescription>[0]),
      ).toBeNull();
    }
  });
});
