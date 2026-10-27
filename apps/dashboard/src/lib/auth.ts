import { useEffect, useState } from "react";
import type { AuthStatus } from "@mybase/shared";
import { api, onSignedOut } from "./api";

export type AuthState = { status: "loading" } | { status: "offline" } | ({ status: "ready" } & AuthStatus);

// One shared copy: the app gate and Settings read the same sign-in state.
let state: AuthState = { status: "loading" };
const listeners = new Set<(s: AuthState) => void>();

function set(next: AuthState) {
  state = next;
  for (const l of listeners) l(state);
}

export async function refreshAuth() {
  try {
    set({ status: "ready", ...(await api.authStatus()) });
  } catch {
    set({ status: "offline" });
  }
}

// Any request that comes back 401 (an expired session, a sign-out in another tab) drops to the sign-in page.
onSignedOut(() => {
  if (state.status === "ready" && state.authenticated) set({ ...state, authenticated: false, username: null });
});

export function useAuth() {
  const [current, setCurrent] = useState(state);
  useEffect(() => {
    listeners.add(setCurrent);
    setCurrent(state);
    if (state.status === "loading") void refreshAuth();
    return () => void listeners.delete(setCurrent);
  }, []);
  return current;
}

export async function signOut() {
  try {
    await api.logout();
  } finally {
    await refreshAuth();
  }
}
