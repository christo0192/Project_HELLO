import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth, type MembershipRole } from '../lib/auth';

const baseNavItems = [
  { to: '/roles', label: 'Roles', icon: BriefcaseIcon },
  { to: '/candidates', label: 'Candidates', icon: UsersIcon },
];

function navItemsForRole(role: MembershipRole | null) {
  const items = [...baseNavItems];
  if (role === 'admin') {
    items.push({ to: '/admin', label: 'Admin', icon: ShieldIcon });
  }
  return items;
}

export function Layout() {
  const { user, signOut, isAuthenticated, role } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'checking' | 'online' | 'maintenance' | 'offline'>('checking');

  // Phase 9 L4: bounded /api/status only — no model/provider display, no fake
  // alert/provider sync.
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

  async function handleLogout() {
    await signOut();
    navigate('/login', { replace: true });
  }

  const navItems = navItemsForRole(role);

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-gray-200 bg-white">
        <div className="flex items-center gap-2 px-5 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-600 text-sm font-bold text-white">
            M
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Gopu Screen</p>
            <p className="text-xs text-gray-400">AI HR Screening</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3" aria-label="Main navigation">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-accent-50 text-accent-700'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-gray-200 p-4">
          {isAuthenticated && user && (
            <div className="mb-3 truncate text-xs text-gray-500" title={user.email ?? ''}>
              {user.email}
            </div>
          )}

          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                status === 'checking'
                  ? 'bg-gray-300'
                  : status === 'online'
                    ? 'bg-emerald-500'
                    : status === 'maintenance'
                      ? 'bg-amber-500'
                      : 'bg-red-500'
              }`}
            />
            <span className="text-xs text-gray-500">
              {status === 'checking'
                ? 'Checking…'
                : status === 'online'
                  ? 'API online'
                  : status === 'maintenance'
                    ? 'Maintenance'
                    : 'API offline'}
            </span>
          </div>

          {isAuthenticated && (
            <button
              onClick={handleLogout}
              className="mt-3 w-full rounded-lg px-3 py-1.5 text-left text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              Sign out
            </button>
          )}
        </div>
      </aside>

      <main className="flex-1 overflow-x-hidden">
        <div className="mx-auto max-w-5xl px-6 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function BriefcaseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
