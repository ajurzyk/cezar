'use client';

import { useMemo } from 'react';
import { BellIcon } from './icons';

interface TopBarProps {
  user: { id: string; email: string; name: string; avatarUrl: string };
}

export function TopBar({ user }: TopBarProps) {
  const initials = useMemo(
    () =>
      (user.name || user.email || '?')
        .split(/\s+/)
        .map((p) => p[0])
        .filter(Boolean)
        .slice(0, 2)
        .join('')
        .toUpperCase(),
    [user.name, user.email],
  );

  return (
    <header className="sticky top-0 z-10 flex h-topbar items-center justify-end gap-4 border-b border-outline-variant bg-surface px-6 backdrop-blur">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
          aria-label="Notifications"
        >
          <BellIcon className="h-5 w-5" />
        </button>

        <div className="mx-2 h-6 w-px bg-outline-variant" aria-hidden />

        <div className="flex items-center gap-2 pr-1">
          <div className="text-sm font-medium text-on-surface">{user.name || 'Cezar'}</div>
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-md object-cover" />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary-container text-xs font-semibold text-primary-on-container">
              {initials || 'CZ'}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
