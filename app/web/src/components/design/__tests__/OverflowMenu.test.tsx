/**
 * OverflowMenu — the WAI-ARIA APG "menu button" contract a keyboard or
 * screen-reader user relies on, plus the rules that exist because the menu
 * floats: it is portalled out of the page (so no panel clips or covers it)
 * but stays INSIDE a modal (so `aria-modal` does not hide it), Escape closes
 * the menu and not the dialog around it, and it flips above its trigger
 * near the bottom of the viewport.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverflowMenu } from '../OverflowMenu';
import type { OverflowMenuItem } from '../OverflowMenu';
import { Dialog } from '../Dialog';

function makeItems(onSelect = vi.fn()): OverflowMenuItem[] {
  return [
    { key: 'discover', label: 'Discover feedback form', onSelect: (t) => onSelect('discover', t) },
    { key: 'binding', label: 'Preview scorecard binding', onSelect: (t) => onSelect('binding', t) },
    {
      key: 'backlog',
      label: 'Preview existing backlog',
      onSelect: (t) => onSelect('backlog', t),
      disabled: true,
      disabledReason: 'Available once the mapping is live',
    },
    { key: 'delete', label: 'Delete', tone: 'danger', haspopup: 'dialog', onSelect: (t) => onSelect('delete', t) },
  ];
}

function Harness({ items = makeItems() }: { items?: OverflowMenuItem[] }) {
  return (
    <div>
      <button type="button">Before</button>
      <OverflowMenu label="More actions for Data Analyst" items={items} />
      <button type="button">After</button>
    </div>
  );
}

const trigger = () => screen.getByRole('button', { name: 'More actions for Data Analyst' });
const items = () => within(screen.getByRole('menu')).getAllByRole('menuitem');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OverflowMenu — the trigger', () => {
  it('is a menu button named by its label, which starts with the visible text', () => {
    render(<Harness />);
    const button = trigger();
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).not.toHaveAttribute('aria-controls');
    // WCAG 2.5.3: the name contains what is on screen.
    expect(button).toHaveTextContent('More');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a click opens the menu on the FIRST item, labelled by the trigger', async () => {
    render(<Harness />);
    await userEvent.click(trigger());
    const menu = screen.getByRole('menu');
    expect(menu).toHaveAccessibleName('More actions for Data Analyst');
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(trigger()).toHaveAttribute('aria-controls', menu.id);
    expect(items()[0]).toHaveFocus();
    expect(items().map((i) => i.textContent)).toEqual([
      'Discover feedback form',
      'Preview scorecard binding',
      'Preview existing backlogAvailable once the mapping is live',
      'Delete',
    ]);
  });

  it('Enter, Space and ArrowDown open on the first item; ArrowUp on the last', async () => {
    render(<Harness />);
    for (const key of ['{Enter}', ' ', '{ArrowDown}']) {
      trigger().focus();
      await userEvent.keyboard(key);
      expect(items()[0]).toHaveFocus();
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).toBeNull();
    }
    trigger().focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(items()[3]).toHaveFocus();
  });

  it('a second click on the trigger closes it and keeps focus there', async () => {
    render(<Harness />);
    await userEvent.click(trigger());
    await userEvent.click(trigger());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('a disabled trigger does not open', async () => {
    render(<OverflowMenu label="More actions" items={makeItems()} disabled />);
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('OverflowMenu — moving inside the menu', () => {
  it('ArrowDown / ArrowUp move and wrap; Home / End jump', async () => {
    render(<Harness />);
    await userEvent.click(trigger());
    await userEvent.keyboard('{ArrowDown}');
    expect(items()[1]).toHaveFocus();
    // Disabled items stay focusable, so their reason can be read.
    await userEvent.keyboard('{ArrowDown}');
    expect(items()[2]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(items()[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(items()[3]).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(items()[0]).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(items()[3]).toHaveFocus();
  });

  it('typeahead jumps to the next item starting with the typed letters, and cycles', async () => {
    render(<Harness />);
    await userEvent.click(trigger());
    await userEvent.keyboard('p');
    expect(items()[1]).toHaveFocus();
    await userEvent.keyboard('p');
    expect(items()[2]).toHaveFocus();
    await userEvent.keyboard('{Escape}');

    // A fresh menu starts on Discover: the next "d" is Delete, and the one
    // after that wraps round to Discover.
    await userEvent.click(trigger());
    await userEvent.keyboard('d');
    expect(items()[3]).toHaveFocus();
    await userEvent.keyboard('d');
    expect(items()[0]).toHaveFocus();
    await userEvent.keyboard('{Escape}');

    // A longer prefix refines instead of cycling.
    await userEvent.click(trigger());
    await userEvent.keyboard('prev');
    expect(items()[1]).toHaveFocus();
  });

  it('hovering an item focuses it, so pointer and keyboard share one highlight', async () => {
    render(<Harness />);
    await userEvent.click(trigger());
    fireEvent.mouseMove(items()[1]);
    expect(items()[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(items()[2]).toHaveFocus();
  });

  it('sets the destructive item apart with a separator and names each item by its label only', async () => {
    render(<Harness />);
    await userEvent.click(trigger());
    const menu = screen.getByRole('menu');
    const separator = within(menu).getByRole('separator');
    expect(separator.nextElementSibling).toBe(items()[3]);
    expect(items()[3]).toHaveAccessibleName('Delete');
    expect(items()[3]).toHaveAttribute('aria-haspopup', 'dialog');
    expect(items()[0]).toHaveAccessibleName('Discover feedback form');
  });
});

describe('OverflowMenu — choosing', () => {
  it('Enter chooses: the menu closes, focus returns to the trigger, THEN onSelect gets the trigger', async () => {
    const onSelect = vi.fn((_key: string, t: HTMLButtonElement) => {
      // By the time the handler runs, the menu is gone and focus is home.
      expect(t).toHaveFocus();
    });
    render(<Harness items={makeItems(onSelect)} />);
    await userEvent.click(trigger());
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('binding', trigger());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('Space and a click choose too', async () => {
    const onSelect = vi.fn();
    render(<Harness items={makeItems(onSelect)} />);
    await userEvent.click(trigger());
    await userEvent.keyboard(' ');
    expect(onSelect).toHaveBeenLastCalledWith('discover', trigger());
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onSelect).toHaveBeenLastCalledWith('delete', trigger());
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('a DISABLED item cannot be chosen, and says why as its description', async () => {
    const onSelect = vi.fn();
    render(<Harness items={makeItems(onSelect)} />);
    await userEvent.click(trigger());
    const backlog = screen.getByRole('menuitem', { name: 'Preview existing backlog' });
    expect(backlog).toHaveAttribute('aria-disabled', 'true');
    // Visible text, tied to the item — not a tooltip.
    expect(backlog).toHaveAccessibleDescription('Available once the mapping is live');
    expect(within(backlog).getByText('Available once the mapping is live')).not.toHaveClass('sr-only');
    await userEvent.click(backlog);
    backlog.focus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    // An enabled item carries no description.
    expect(screen.getByRole('menuitem', { name: 'Delete' })).not.toHaveAccessibleDescription();
  });
});

describe('OverflowMenu — leaving', () => {
  it('Escape closes and returns focus to the trigger', async () => {
    render(<Harness />);
    await userEvent.click(trigger());
    await userEvent.keyboard('{ArrowDown}{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('Tab closes and moves on from the TRIGGER; Shift+Tab moves back from it', async () => {
    render(<Harness />);
    await userEvent.click(trigger());
    await userEvent.tab();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();

    await userEvent.click(trigger());
    await userEvent.tab({ shift: true });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus();
  });

  it('a press elsewhere closes it without moving focus there', async () => {
    render(<Harness />);
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole('button', { name: 'After' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('closes when its trigger is switched off under it', async () => {
    const { rerender } = render(<OverflowMenu label="More actions" items={makeItems()} />);
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    rerender(<OverflowMenu label="More actions" items={makeItems()} disabled />);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('OverflowMenu — where it renders', () => {
  it("on a page, it is portalled to the page's <main>, out of every panel that could clip or cover it", async () => {
    render(
      <main>
        <section data-testid="panel">
          <Harness />
        </section>
      </main>,
    );
    await userEvent.click(trigger());
    const menu = screen.getByRole('menu');
    expect(screen.getByTestId('panel').contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(screen.getByRole('main'));
    expect(menu.style.position).toBe('fixed');
  });

  it('with no <main>, it is portalled to <body>', async () => {
    const { container } = render(<Harness />);
    await userEvent.click(trigger());
    const menu = screen.getByRole('menu');
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
  });

  it('inside a modal it stays IN the dialog, and Escape closes the menu before the dialog', async () => {
    function InDialog() {
      const [open, setOpen] = useState(true);
      const opener = useRef<HTMLButtonElement | null>(null);
      return (
        <>
          <button ref={opener} type="button" onClick={() => setOpen(true)}>
            Open dialog
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} idPrefix="t" title="Mapping" returnFocusRef={opener}>
            <OverflowMenu label="More actions" items={makeItems()} />
            <button type="button">Last inside</button>
          </Dialog>
        </>
      );
    }
    render(<InDialog />);
    const dialog = screen.getByRole('dialog', { name: 'Mapping' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'More actions' }));
    const menu = screen.getByRole('menu');
    // Outside the dialog, `aria-modal` would hide it from assistive tech.
    expect(dialog.contains(menu)).toBe(true);

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Mapping' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'More actions' })).toHaveFocus();

    // Tab from inside a modal wraps as the dialog's own trap would.
    await userEvent.click(within(dialog).getByRole('button', { name: 'More actions' }));
    await userEvent.tab();
    expect(within(dialog).getByRole('button', { name: 'Last inside' })).toHaveFocus();

    // The next Escape is the dialog's.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens BELOW its trigger, aligned to its end, when there is room', async () => {
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
      return this.getAttribute('role') === 'menu' ? 200 : 0;
    });
    render(<Harness />);
    const button = trigger();
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, left: 900, width: 80, height: 36 }));
    await userEvent.click(button);
    const menu = screen.getByRole('menu');
    expect(menu.dataset.side).toBe('bottom');
    expect(menu.style.top).toBe(`${100 + 36 + 6}px`);
    // jsdom has no layout, so the menu's own width is 0: its end is the trigger's.
    expect(menu.style.left).toBe('980px');
  });

  it('FLIPS above its trigger near the bottom of the viewport', async () => {
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
      return this.getAttribute('role') === 'menu' ? 200 : 0;
    });
    render(<Harness />);
    const button = trigger();
    const top = window.innerHeight - 60;
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(rect({ top, left: 100, width: 80, height: 36 }));
    await userEvent.click(button);
    const menu = screen.getByRole('menu');
    expect(menu.dataset.side).toBe('top');
    expect(menu.style.top).toBe(`${top - 6 - 200}px`);
  });

  it('has no axe violations while open', async () => {
    render(
      <main>
        <Harness />
      </main>,
    );
    await userEvent.click(trigger());
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await expect(document.body).toHaveNoViolations();
  });
});

function rect({ top, left, width, height }: { top: number; left: number; width: number; height: number }): DOMRect {
  return {
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}
