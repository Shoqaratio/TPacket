/** REST client: cookie session + double-submit CSRF header. */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

function csrf(): string {
  return document.cookie.split('; ').find((c) => c.startsWith('nl_csrf='))?.slice(8) ?? '';
}

export async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': csrf() } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { detail?: unknown };
  if (!res.ok) {
    const code = typeof data.detail === 'string' ? data.detail : res.status === 422 ? 'invalid_input' : 'error';
    throw new ApiError(res.status, code);
  }
  return data as T;
}

export interface Me {
  id: string;
  email: string;
  display_name: string;
  locale: string;
  is_superadmin: boolean;
  memberships: { org_id: string; org_name: string; role: 'student' | 'teacher' | 'org_admin' }[];
}

export interface CloudProject {
  id: string;
  name: string;
  version: number;
  updated_at: string;
  data?: unknown;
}

export async function fetchMe(): Promise<Me | null> {
  try {
    return await api<Me>('GET', '/auth/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    // API unreachable (offline / standalone deployment): the simulator keeps working locally.
    return null;
  }
}
