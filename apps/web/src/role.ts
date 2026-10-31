import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';

export type Role = 'viewer' | 'admin' | 'owner';

/** The signed-in token: its org, role and who it acts as (`user:<id>` or `token:<id>`). */
export interface Session {
  orgId: string;
  role: Role;
  actor: string;
}

export function useSession() {
  return useQuery({
    queryKey: ['auth-session'],
    queryFn: () => api<Session>('/v1/auth/session'),
    staleTime: Infinity,
    retry: false,
  });
}

const RANK: Record<Role, number> = { viewer: 0, admin: 1, owner: 2 };

/**
 * The signed-in token's role, so pages show only the controls it can use. Until it is known (or
 * if the API cannot say), no control shows: the API refuses what the role cannot do anyway.
 */
export function useRole(): { role: Role | null; can: (need: Role) => boolean } {
  const role = useSession().data?.role ?? null;
  return { role, can: (need) => role !== null && RANK[role] >= RANK[need] };
}
