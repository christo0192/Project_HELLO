/**
 * Layout checks shared by the recruiter and candidate specs.
 */

import type { Page } from '@playwright/test';

export interface Overflow {
  overflowPx: number;
  offenders: string[];
}

/**
 * How far the document scrolls sideways, and the elements responsible.
 * Elements inside a horizontal scroll container (tab strips, wide tables)
 * are skipped: they scroll inside their own box, which is fine on a phone.
 */
export function horizontalOverflow(page: Page): Promise<Overflow> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const viewport = root.clientWidth;
    const overflowPx = Math.max(0, root.scrollWidth - viewport);
    if (overflowPx === 0) return { overflowPx, offenders: [] };
    const clipped = (el: Element): boolean => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox !== 'visible') return true;
      }
      return false;
    };
    const offenders = Array.from(document.body.querySelectorAll('*'))
      .map((el) => ({ el, right: el.getBoundingClientRect().right }))
      .filter(({ el, right }) => right > viewport + 1 && getComputedStyle(el).position !== 'fixed' && !clipped(el))
      .sort((a, b) => b.right - a.right)
      .slice(0, 5)
      .map(({ el, right }) => {
        const cls = typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 4).join('.')}` : '';
        return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls} → right edge ${Math.round(right)}px`;
      });
    return { overflowPx, offenders };
  });
}

export interface Box {
  top: number;
  bottom: number;
  height: number;
  /** The element's scrollable content height and visible height: they differ when it scrolls inside. */
  scrollHeight: number;
  clientHeight: number;
}

export interface LiveLayout {
  viewport: { width: number; height: number };
  /** `document.scrollingElement.scrollHeight`: what the PAGE scrolls through. */
  pageScrollHeight: number;
  stage: Box | null;
  captionsCard: Box | null;
  list: (Box & { scrollTop: number }) | null;
  /** The newest caption is inside the visible part of the list. */
  newestLineInView: boolean | null;
  /** The lowest of the three controls (mute, camera, leave), in viewport coordinates. */
  controlsBottom: number | null;
  jumpButton: string | null;
}

/**
 * Where everything of the R1 live view is, measured in the page: the page itself, the stage card,
 * the captions card and its list. Used to prove the live view fits the window and that the
 * captions list, not the page, is what scrolls.
 */
export function liveLayout(page: Page): Promise<LiveLayout> {
  return page.evaluate(() => {
    const q = (selector: string) => document.querySelector<HTMLElement>(selector);
    const box = (el: HTMLElement | null) => {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      };
    };
    const list = q('[role="log"]');
    const lines = document.querySelectorAll<HTMLElement>('.candidate-caption');
    const newest = lines.length > 0 ? lines[lines.length - 1] : null;
    let newestLineInView: boolean | null = null;
    if (list && newest) {
      const line = newest.getBoundingClientRect();
      const frame = list.getBoundingClientRect();
      newestLineInView = line.bottom <= frame.bottom + 1 && line.top >= frame.top - 1;
    }
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>('.r1-live__stage .candidate-interview__controls button'),
    );
    const listBox = box(list);
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      pageScrollHeight: document.scrollingElement?.scrollHeight ?? 0,
      stage: box(q('.r1-live__stage')),
      captionsCard: box(q('.candidate-interview__captions')),
      list: listBox && list ? { ...listBox, scrollTop: Math.round(list.scrollTop) } : null,
      newestLineInView,
      controlsBottom: controls.length
        ? Math.round(Math.max(...controls.map((button) => button.getBoundingClientRect().bottom)))
        : null,
      jumpButton: q('.r1-captions__jump')?.textContent ?? null,
    };
  });
}
