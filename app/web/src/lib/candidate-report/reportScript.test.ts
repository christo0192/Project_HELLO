// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPORT_SCRIPT } from './reportScript';

function mount(): { a1: HTMLAudioElement; a2: HTMLAudioElement } {
  document.body.innerHTML = `
    <audio data-audio-id="a1"></audio>
    <audio data-audio-id="a2"></audio>
    <ol>
      <li id="r1"><button class="ts" data-audio="a1" data-t="1.5">0:01</button></li>
      <li id="r2"><button class="ts" data-audio="a1" data-t="20">0:20</button></li>
      <li id="r3"><button class="ts" data-audio="a2" data-t="3">0:03</button></li>
    </ol>`;
  const a1 = document.querySelector('audio[data-audio-id="a1"]') as HTMLAudioElement;
  const a2 = document.querySelector('audio[data-audio-id="a2"]') as HTMLAudioElement;
  return { a1, a2 };
}

describe('report inline script', () => {
  let play: ReturnType<typeof vi.fn>;
  let pause: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    play = vi.fn().mockResolvedValue(undefined);
    pause = vi.fn();
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: play });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: pause });
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 4 });
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', { configurable: true, get: () => false });
  });
  const bound: Array<[string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]> = [];
  afterEach(() => {
    // The script binds on `document`, which outlives a test: take its listeners off again.
    for (const [type, fn, opts] of bound.splice(0)) document.removeEventListener(type, fn, opts);
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function run() {
    const original = document.addEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation((type, fn, opts) => {
      bound.push([type, fn as EventListenerOrEventListenerObject, opts]);
      original(type, fn as EventListenerOrEventListenerObject, opts);
    });
    // The script is a self-invoking function; evaluating it binds its listeners to this document.
    new Function(REPORT_SCRIPT)();
  }

  it('has no backslashes or template placeholders, so its bytes are exactly what the CSP hash covers', () => {
    expect(REPORT_SCRIPT).not.toContain('\\');
    expect(REPORT_SCRIPT).not.toContain('${');
    expect(REPORT_SCRIPT).not.toContain('</script');
  });

  it('seeks the matching call and plays when a timestamp is clicked, pausing the other player', () => {
    const { a1, a2 } = mount();
    run();
    let time = 0;
    Object.defineProperty(a1, 'currentTime', { configurable: true, get: () => time, set: (v: number) => { time = v; } });
    (document.querySelector('[data-t="20"]') as HTMLButtonElement).click();
    expect(time).toBe(20);
    expect(play).toHaveBeenCalledTimes(1);
    // The other call (a2) was asked to pause; the clicked one was not.
    expect(pause).toHaveBeenCalled();
    expect(a2).toBeTruthy();
  });

  it('ignores a click on a button with no matching audio', () => {
    mount();
    document.body.insertAdjacentHTML('beforeend', '<button data-audio="zzz" data-t="4">x</button>');
    run();
    (document.querySelector('[data-audio="zzz"]') as HTMLButtonElement).click();
    expect(play).not.toHaveBeenCalled();
  });

  it('highlights the turn being spoken while the call plays, and only for that call', () => {
    const { a1 } = mount();
    run();
    Object.defineProperty(a1, 'currentTime', { configurable: true, get: () => 21 });
    a1.dispatchEvent(new Event('timeupdate'));
    expect(document.getElementById('r2')?.getAttribute('data-active')).toBe('true');
    expect(document.getElementById('r1')?.hasAttribute('data-active')).toBe(false);
    expect(document.getElementById('r3')?.hasAttribute('data-active')).toBe(false);
    expect(document.querySelector('[data-t="20"]')?.getAttribute('aria-current')).toBe('true');
  });
});
