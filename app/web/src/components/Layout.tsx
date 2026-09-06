/**
 * HELLO app shell — glass edition.
 *
 * - Brand: authorized IK logo on a neutral plate (never CSS-inverted) +
 *   "HELLO" wordmark.
 * - Navigation: TA/HR daily items (Dashboard · Candidates · Roles) under
 *   "Workspace"; Operations for admins/interviewers — Mission Control stays
 *   admin-only, the phone calendar is for both roles.
 * - Material: a frosted rail (sidebar) and a frosted top bar float on a
 *   softly lit ground (`.app-ground`). Both collapse to opaque surfaces under
 *   `prefers-reduced-transparency` or without `backdrop-filter`.
 * - Responsive: desktop fixed sidebar (lg+); mobile off-canvas drawer with
 *   backdrop, Escape-to-close, `inert` when closed (out of tab order and
 *   the accessibility tree), focus moved into the drawer on open and
 *   returned to the toggle on close.
 * - Topbar: mobile menu toggle, current page name, workspace label.
 * - Skip link + `#main-content` target (WCAG 2.4.1).
 * - Lazy route chunks suspend inside `<Suspense>` with a small loading
 *   fallback (route components are React.lazy in App.tsx); each route
 *   rises in via `PageTransition` (collapses under reduced motion).
 */

import { Suspense, useEffect, useRef, useState } from 'react';
import { LayoutGroup } from 'motion/react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth, type MembershipRole } from '../lib/auth';
import { LoadingPanel, PageTransition } from './design';
import { ErrorBoundary } from './ErrorBoundary';
import {
  Brand,
  BriefcaseIcon,
  CalendarIcon,
  CloseIcon,
  DashboardIcon,
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
  checking: 'bg-ink-muted/60',
  online: 'bg-success',
  maintenance: 'bg-warning',
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
  [/^\/roles/, 'Roles'],
  [/^\/phone-calendar/, 'Phone calendar'],
  [/^\/ashby-mission-control/, 'Ashby Mission Control'],
  [/^\/ashby\/review/, 'Ashby review'],
  [/^\/mission-control/, 'Mission Control'],
];

export function pageTitleFor(pathname: string): string {
  const hit = PAGE_TITLES.find(([pattern]) => pattern.test(pathname));
  return hit ? hit[1] : 'HELLO';
}

function initialsFor(email: string | null | undefined): string {
  if (!email) return '·';
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
  return letters.toUpperCase();
}

export function Layout() {
  const { user, signOut, isAuthenticated, role } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [status, setStatus] = useState<Status>('checking');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const isDesktop = useIsDesktop();

  // The frosted top bar gains a soft shadow once content slides under it.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

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
          className="fixed inset-0 z-30 cursor-default bg-ink/30 backdrop-blur-[3px] lg:hidden"
        />
      )}

      {/* ── Sidebar / mobile drawer ─────────────────────────────────── */}
      <aside
        id="app-sidebar"
        inert={sidebarInert || undefined}
        className={`glass-rail fixed inset-y-0 left-0 z-40 flex w-[264px] shrink-0 flex-col transition-transform duration-[380ms] ease-[cubic-bezier(0.2,0.9,0.25,1.04)] max-lg:bg-white lg:static lg:z-auto lg:translate-x-0 ${
          drawerOpen
            ? 'translate-x-0 shadow-pop lg:shadow-none'
            : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="flex items-center justify-between gap-2 px-5 pb-4 pt-5">
          <Brand />
          <button
            type="button"
            onClick={closeDrawer}
            aria-label="Close navigation menu"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-tertiary transition-colors hover:bg-white/70 hover:text-ink lg:hidden"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <LayoutGroup id="sidebar-nav">
          <nav className="flex-1 overflow-y-auto px-3 py-2" aria-label="Main navigation">
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
                label="Roles"
                icon={<BriefcaseIcon className="h-4 w-4" />}
                onNavigate={closeDrawer}
              />
            </NavGroup>

            {/*
              Operations. The GROUP is shown to admins and interviewers, but
              each link keeps its own visibility rule — Mission Control stays
              admin-only exactly as before, because its route is still
              `requireRole="admin"` and offering an interviewer a link that
              redirects to /unauthorized would be a worse experience than not
              showing it. The phone calendar is added for both roles, matching
              the API's "interviewer or above may read" rule.
            */}
            {(role === 'admin' || role === 'interviewer') && (
              <NavGroup label="Operations">
                {role === 'admin' && (
                  <NavLinkItem
                    to="/mission-control"
                    label="Mission Control"
                    icon={<ShieldIcon className="h-4 w-4" />}
                    onNavigate={closeDrawer}
                  />
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
        </LayoutGroup>

        <div className="px-3 pb-4 pt-2">
          <div className="glass-sunken p-3">
            {isAuthenticated && user && (
              <div className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-xs font-semibold text-info shadow-pill"
                >
                  {initialsFor(user.email)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-ink" title={user.email ?? ''}>
                    {user.email ?? 'Signed in'}
                  </p>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-tertiary">
                    {role && <span className="font-medium text-ink-secondary">{ROLE_LABEL[role]}</span>}
                    {role && <span aria-hidden="true">·</span>}
                    <span className="inline-flex items-center gap-1.5">
                      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
                      {STATUS_LABEL[status]}
                    </span>
                  </div>
                </div>
              </div>
            )}
            {!user && (
              <div className="flex items-center gap-2 text-xs text-ink-tertiary">
                <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
                <span>{STATUS_LABEL[status]}</span>
              </div>
            )}

            {isAuthenticated && (
              <button
                onClick={handleLogout}
                className="mt-3 flex h-8 w-full items-center justify-center gap-2 rounded-[10px] bg-white/70 text-xs font-medium text-ink-secondary transition-colors duration-200 hover:bg-white hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-info"
              >
                <LogOutIcon className="h-3.5 w-3.5" />
                Sign out
              </button>
            )}
          </div>
        </div>
      </aside>

      {/* ── Main column ─────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className={`sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-glass-ring bg-[var(--glass-bg-strong)] px-4 backdrop-blur-xl transition-shadow duration-300 sm:px-8 ${
            scrolled ? 'shadow-[0_8px_24px_-16px_rgba(15,23,42,0.22)]' : ''
          }`}
        >
          <MobileMenuButton
            open={drawerOpen}
            onToggle={() => setDrawerOpen((open) => !open)}
            ref={menuButtonRef}
          />
          <div className="lg:hidden">
            <Brand compact />
          </div>
          <p className="hidden truncate text-sm font-medium text-ink-secondary lg:block" aria-live="polite">
            {pageTitle}
          </p>
          <div className="flex-1" />
          <span className="hidden rounded-full bg-white/70 px-3 py-1 text-xs font-medium text-ink-tertiary shadow-[inset_0_0_0_1px_var(--glass-ring)] sm:inline">
            Recruiter workspace
          </span>
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 outline-none"
        >
          <div className="mx-auto max-w-page px-4 py-6 sm:px-8 sm:py-8">
            <ErrorBoundary resetKey={location.pathname}>
              <Suspense fallback={<LoadingPanel />}>
                <PageTransition key={location.pathname}>
                  <Outlet />
                </PageTransition>
              </Suspense>
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}
