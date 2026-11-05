/**
 * HELLO app shell: a tinted desk with one paper sheet laid on it.
 *
 * - Brand: authorized IK logo on its own white plate (never CSS-inverted),
 *   the HELLO wordmark and a scope line.
 * - Navigation: TA/HR daily items (Dashboard · Candidates · Agents) under
 *   "Workspace"; Operations for admins/interviewers — Ashby Live Jobs
 *   and Mission Control stay admin-only, the phone calendar is for both
 *   roles.
 * - Material: a 232px sidebar on the desk, and the page as one opaque sheet
 *   inset 8px from the window (`.sheet`). No blur, no fixed ground, no shadow.
 * - The sidebar is sticky on desktop, so the nav stays on screen at any scroll.
 * - The calling state is NOT shown here. Its only read, `GET /api/phone/health`,
 *   is `requireRole('interviewer')`, so a viewer would get a 403 on every route,
 *   and `GET /api/status` carries no calling state. It needs its own safe read.
 * - Responsive: desktop sticky sidebar (lg+); mobile off-canvas drawer with
 *   backdrop, Escape-to-close, `inert` when closed (out of tab order and
 *   the accessibility tree), focus moved into the drawer on open and
 *   returned to the toggle on close.
 * - Top bar: MOBILE ONLY — menu toggle, brand, and the current page's name
 *   (the one thing a phone user cannot otherwise see once the sidebar is
 *   folded away). On desktop the sidebar already names the product and marks
 *   the current page, and every page opens with its own `<h1>`, so a desktop
 *   top bar could only repeat one of them; it is not rendered there.
 * - Route announcement: a visually hidden polite live region carries the
 *   page name at every width, so a screen-reader user still hears where a
 *   navigation landed even though no visible bar holds the name on desktop.
 * - Skip link + `#main-content` target (WCAG 2.4.1).
 * - Lazy route chunks suspend inside `<Suspense>` with a small loading
 *   fallback (route components are React.lazy in App.tsx). A route appears at
 *   once: nothing rises in.
 * - The page is keyed on the path, so it never outlives its URL. A route such
 *   as `/candidates/:id` reuses one component for every id, and a read still in
 *   flight would otherwise land on the next person's page.
 */

import { Fragment, Suspense, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth, type MembershipRole } from '../lib/auth';
import { LoadingPanel } from './design';
import { ErrorBoundary } from './ErrorBoundary';
import {
  Brand,
  BriefcaseIcon,
  CalendarIcon,
  CloseIcon,
  DashboardIcon,
  IntegrationIcon,
  LogOutIcon,
  MobileMenuButton,
  NavGroup,
  NavLinkItem,
  ShieldIcon,
  SkipLink,
  UsersIcon,
} from './navigation';

const DESKTOP_QUERY = '(min-width: 1024px)';

function readDesktop(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(DESKTOP_QUERY).matches;
}

/** Live ≥lg breakpoint hook (drawer vs static sidebar). */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(readDesktop);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(DESKTOP_QUERY);
    const onChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isDesktop;
}

type Status = 'checking' | 'online' | 'maintenance' | 'offline';

const STATUS_LABEL: Record<Status, string> = {
  checking: 'Checking…',
  online: 'API online',
  maintenance: 'Maintenance',
  offline: 'API offline',
};

const STATUS_DOT: Record<Status, string> = {
  checking: 'bg-ink-muted',
  online: 'bg-ink',
  maintenance: 'bg-ink-muted',
  offline: 'bg-error',
};

const ROLE_LABEL: Record<MembershipRole, string> = {
  admin: 'Admin',
  interviewer: 'Interviewer',
  viewer: 'Viewer',
};

/** Human page name for the top bar, derived from the first path segment. */
const PAGE_TITLES: Array<[RegExp, string]> = [
  [/^\/dashboard/, 'Dashboard'],
  [/^\/candidates\/[^/]+/, 'Candidate'],
  [/^\/candidates/, 'Candidates'],
  [/^\/sessions\//, 'Session'],
  [/^\/screening\//, 'Screening'],
  [/^\/roles/, 'Agents'],
  [/^\/phone-calendar/, 'Phone calendar'],
  [/^\/ashby-mission-control/, 'Ashby Live Jobs'],
  [/^\/ashby\/review/, 'Ashby review'],
  [/^\/admin\/r1/, 'R1 settings'],
  [/^\/mission-control/, 'Mission Control'],
];

export function pageTitleFor(pathname: string): string {
  const hit = PAGE_TITLES.find(([pattern]) => pattern.test(pathname));
  return hit ? hit[1] : 'HELLO';
}

export function Layout() {
  const { user, signOut, isAuthenticated, role } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [status, setStatus] = useState<Status>('checking');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isDesktop = useIsDesktop();

  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  // Bounded /api/status only — no model/provider display (Phase 9 L4).
  useEffect(() => {
    let cancelled = false;
    api
      .status()
      .then((s) => {
        if (cancelled) return;
        if (s.status === 'maintenance') setStatus('maintenance');
        else if (s.status === 'ok') setStatus('online');
        else setStatus('offline');
      })
      .catch(() => {
        if (!cancelled) setStatus('offline');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close the drawer on any route change.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Escape closes the drawer; focus returns to the toggle.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawerOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  // Focus management + scroll lock while the mobile drawer is open.
  useEffect(() => {
    if (drawerOpen) {
      const aside = document.getElementById('app-sidebar');
      const firstLink = aside?.querySelector<HTMLElement>('a[href]');
      firstLink?.focus();
      const previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = previousOverflow;
      };
    }
    return undefined;
  }, [drawerOpen]);

  const closeDrawer = () => {
    setDrawerOpen(false);
    menuButtonRef.current?.focus();
  };

  async function handleLogout() {
    await signOut();
    navigate('/login', { replace: true });
  }

  // Closed mobile drawer is inert: removed from tab order and the
  // accessibility tree until opened (desktop sidebar stays static).
  const sidebarInert = !drawerOpen && !isDesktop;
  const pageTitle = pageTitleFor(location.pathname);

  return (
    <div className="app-ground flex min-h-screen text-ink">
      <SkipLink />

      {/* Backdrop (mobile drawer only) — programmatic-focus-only button so
          axe never sees a focusable element with aria-hidden. */}
      {drawerOpen && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Close navigation menu"
          onClick={closeDrawer}
          className="fixed inset-0 z-30 cursor-default bg-ink/40 lg:hidden"
        />
      )}

      {/* ── Sidebar / mobile drawer ─────────────────────────────────── */}
      <aside
        id="app-sidebar"
        inert={sidebarInert || undefined}
        className={`fixed inset-y-0 left-0 z-40 flex w-[232px] shrink-0 flex-col bg-surface-tertiary px-3 pb-3 pt-4 transition-transform duration-[220ms] ease-out lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:translate-x-0 lg:self-start lg:transition-none ${
          drawerOpen
            ? 'translate-x-0 shadow-pop lg:shadow-none'
            : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="flex items-center justify-between gap-2 px-2 pb-6">
          <Brand />
          <button
            type="button"
            onClick={closeDrawer}
            aria-label="Close navigation menu"
            className="inline-flex h-8 w-8 items-center justify-center rounded-control text-ink-tertiary transition-colors duration-hover hover:bg-ink/[0.05] hover:text-ink lg:hidden"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        {/* A scroller clips at its padding box, and a link's focus ring reaches
            4px past the link. `-mx-1 px-1` keeps the links where they were and
            moves the clip 4px out, so the ring keeps its sides. */}
        <nav className="-mx-1 flex-1 overflow-y-auto px-1 py-1" aria-label="Main navigation">
          <NavGroup label="Workspace">
            <NavLinkItem
              to="/dashboard"
              label="Dashboard"
              end
              icon={<DashboardIcon className="h-4 w-4" />}
              onNavigate={closeDrawer}
            />
            <NavLinkItem
              to="/candidates"
              label="Candidates"
              icon={<UsersIcon className="h-4 w-4" />}
              onNavigate={closeDrawer}
            />
            <NavLinkItem
              to="/roles"
              label="Agents"
              icon={<BriefcaseIcon className="h-4 w-4" />}
              onNavigate={closeDrawer}
            />
          </NavGroup>

          {/*
            Operations. The GROUP is shown to admins and interviewers, but
            each link keeps its own visibility rule — Ashby Live Jobs
            and Mission Control are admin-only, because both routes are
            `requireRole="admin"` and offering an interviewer a link that
            redirects to /unauthorized would be a worse experience than not
            showing it. The phone calendar is shown to both roles, matching
            the API's "interviewer or above may read" rule. Ashby Live Jobs
            sits directly above Mission Control; it used to be
            reachable only from a quick link in the Mission Control header.
          */}
          {(role === 'admin' || role === 'interviewer') && (
            <NavGroup label="Operations">
              {role === 'admin' && (
                <>
                  <NavLinkItem
                    to="/ashby-mission-control"
                    label="Ashby Live Jobs"
                    icon={<IntegrationIcon className="h-4 w-4" />}
                    onNavigate={closeDrawer}
                  />
                  <NavLinkItem
                    to="/mission-control"
                    label="Mission Control"
                    icon={<ShieldIcon className="h-4 w-4" />}
                    onNavigate={closeDrawer}
                  />
                </>
              )}
              <NavLinkItem
                to="/phone-calendar"
                label="Phone calendar"
                icon={<CalendarIcon className="h-4 w-4" />}
                onNavigate={closeDrawer}
              />
            </NavGroup>
          )}
        </nav>

        <div className="mt-3 border-t border-line-strong px-2.5 pt-3">
          {isAuthenticated && user ? (
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-label font-medium text-ink" title={user.email ?? ''}>
                  {user.email ?? 'Signed in'}
                </p>
                <div className="flex items-center gap-1.5 text-meta text-ink-tertiary">
                  {role && <span>{ROLE_LABEL[role]}</span>}
                  {role && <span aria-hidden="true">·</span>}
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
                    {STATUS_LABEL[status]}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                aria-label="Sign out"
                title="Sign out"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-[var(--control)] text-ink-secondary transition-colors duration-hover hover:bg-surface hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-surface-tertiary"
              >
                <LogOutIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-meta text-ink-tertiary">
              <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
              <span>{STATUS_LABEL[status]}</span>
            </div>
          )}
        </div>
      </aside>

      {/* ── Main column ─────────────────────────────────────────────── */}
      {/* While the mobile drawer is open the page behind it is inert, so
          Tab cannot escape the drawer and assistive tech reads only it. */}
      <div className="flex min-w-0 flex-1 flex-col" inert={drawerOpen && !isDesktop ? true : undefined}>
        {/*
          The route announcer. Visually hidden at every width and never
          duplicated by a live copy elsewhere: the page name changes here on
          each navigation and is read politely, after whatever the user is
          currently hearing.
        */}
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {pageTitle}
        </p>

        {/*
          Mobile top bar. The page name is shown next to the brand so a phone
          user always knows where they are with the sidebar folded away; it is
          `aria-hidden` because the announcer above already speaks it, and a
          second readable copy would be read twice in a row.
        */}
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line-strong bg-surface-tertiary px-4 sm:px-6 lg:hidden">
          <MobileMenuButton
            open={drawerOpen}
            onToggle={() => setDrawerOpen((open) => !open)}
            ref={menuButtonRef}
          />
          {/* The brand keeps its width; a long page name truncates instead. */}
          <div className="shrink-0">
            <Brand compact />
          </div>
          <span aria-hidden="true" className="h-5 w-px shrink-0 bg-rule-2" />
          <p
            aria-hidden="true"
            className="min-w-0 truncate text-sm font-medium text-ink-secondary"
          >
            {pageTitle}
          </p>
        </header>

        {/* The sheet: one opaque page on the desk, inset 8px from the window. */}
        <main
          id="main-content"
          tabIndex={-1}
          className="sheet m-2 min-w-0 flex-1 outline-none lg:ml-0"
        >
          <div className="mx-auto max-w-page px-4 py-6 sm:p-6">
            <ErrorBoundary resetKey={location.pathname}>
              <Suspense fallback={<LoadingPanel />}>
                <Fragment key={location.pathname}>
                  <Outlet />
                </Fragment>
              </Suspense>
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}
