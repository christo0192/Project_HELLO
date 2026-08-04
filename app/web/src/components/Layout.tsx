/**
 * HELLO app shell — rebranded Layout (integration lane).
 *
 * - Brand: authorized IK logo on a neutral plate (never CSS-inverted) +
 *   "HELLO" wordmark.
 * - Navigation: TA/HR daily items (Dashboard · Candidates · Roles) under
 *   "Workspace"; admin-only Mission Control under "Operations" — visually
 *   separated and only rendered for admins.
 * - Responsive: desktop fixed sidebar (lg+); mobile off-canvas drawer with
 *   backdrop, Escape-to-close, `inert` when closed (out of tab order and
 *   the accessibility tree), focus moved into the drawer on open and
 *   returned to the toggle on close.
 * - Topbar: mobile menu toggle, theme toggle (design barrel), status.
 * - Skip link + `#main-content` target (WCAG 2.4.1).
 * - Restrained route fade via lib/motion `usePageVariants()`; collapses to
 *   static values under `prefers-reduced-motion`.
 * - Lazy route chunks suspend inside `<Suspense>` with a small loading
 *   fallback (route components are React.lazy in App.tsx).
 */

import { Suspense, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { api } from '../api';
import { useAuth, type MembershipRole } from '../lib/auth';
import { usePageVariants } from '../lib/motion';
import { Spinner } from './ui';
import { ThemeToggle } from './design';
import { ErrorBoundary } from './ErrorBoundary';
import {
  Brand,
  BriefcaseIcon,
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
  checking: 'bg-slate-300 dark:bg-slate-600',
  online: 'bg-emerald-500',
  maintenance: 'bg-amber-500',
  offline: 'bg-red-500',
};

const ROLE_LABEL: Record<MembershipRole, string> = {
  admin: 'Admin',
  interviewer: 'Interviewer',
  viewer: 'Viewer',
};

export function Layout() {
  const { user, signOut, isAuthenticated, role } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const pageVariants = usePageVariants();

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

  return (
    <div className="flex min-h-screen bg-surface text-ink">
      <SkipLink />

      {/* Backdrop (mobile drawer only) — programmatic-focus-only button so
          axe never sees a focusable element with aria-hidden. */}
      {drawerOpen && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Close navigation menu"
          onClick={closeDrawer}
          className="fixed inset-0 z-30 cursor-default bg-ink/40 backdrop-blur-[2px] lg:hidden"
        />
      )}

      {/* ── Sidebar / mobile drawer ─────────────────────────────────── */}
      <aside
        id="app-sidebar"
        inert={sidebarInert || undefined}
        className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-line bg-surface-secondary transition-transform duration-200 ease-out lg:static lg:z-auto lg:translate-x-0 lg:border-r lg:bg-surface-secondary ${
          drawerOpen
            ? 'translate-x-0 shadow-card-hover lg:shadow-none'
            : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-4">
          <Brand />
          <button
            type="button"
            onClick={closeDrawer}
            aria-label="Close navigation menu"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-tertiary transition-colors hover:bg-surface-tertiary hover:text-ink lg:hidden"
          >
            ✕
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Main navigation">
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

          {role === 'admin' && (
            <NavGroup label="Operations">
              <NavLinkItem
                to="/mission-control"
                label="Mission Control"
                icon={<ShieldIcon className="h-4 w-4" />}
                onNavigate={closeDrawer}
              />
            </NavGroup>
          )}
        </nav>

        <div className="border-t border-line p-4">
          {isAuthenticated && user && (
            <div className="mb-3 flex items-center justify-between gap-2">
              <p
                className="truncate text-xs text-ink-secondary"
                title={user.email ?? ''}
              >
                {user.email ?? 'Signed in'}
              </p>
              {role && (
                <span className="shrink-0 rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
                  {ROLE_LABEL[role]}
                </span>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${STATUS_DOT[status]}`}
            />
            <span className="text-xs text-ink-tertiary">{STATUS_LABEL[status]}</span>
          </div>

          {isAuthenticated && (
            <button
              onClick={handleLogout}
              className="mt-3 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-medium text-ink-secondary transition-colors hover:bg-surface-tertiary hover:text-ink"
            >
              <LogOutIcon className="h-3.5 w-3.5" />
              Sign out
            </button>
          )}
        </div>
      </aside>

      {/* ── Main column ─────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur-sm sm:px-6">
          <MobileMenuButton
            open={drawerOpen}
            onToggle={() => setDrawerOpen((open) => !open)}
            ref={menuButtonRef}
          />
          <div className="lg:hidden">
            <Brand compact />
          </div>
          <div className="flex-1" />
          <ThemeToggle />
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 outline-none"
        >
          <div className="mx-auto max-w-page px-4 py-6 sm:px-6 sm:py-8">
            <ErrorBoundary resetKey={location.pathname}>
              <Suspense
                fallback={
                  <div
                    role="status"
                    className="flex min-h-64 items-center justify-center"
                  >
                    <div className="flex flex-col items-center gap-3">
                      <Spinner className="h-6 w-6 text-brand-500" />
                      <p className="text-sm text-ink-tertiary">Loading…</p>
                    </div>
                  </div>
                }
              >
                {/* Restrained route fade; static under reduced motion. */}
                <motion.div
                  key={location.pathname}
                  variants={pageVariants}
                  initial="initial"
                  animate="enter"
                >
                  <Outlet />
                </motion.div>
              </Suspense>
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}
