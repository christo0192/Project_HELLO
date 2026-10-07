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
