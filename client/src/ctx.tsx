import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';

export type Page = 'dashboard' | 'decisions' | 'company' | 'products' | 'projects' | 'operations' | 'finance' | 'world' | 'inbox' | 'history' | 'meeting' | 'saves';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

export interface Nav {
  page: Page;
  param?: string | null;
}

interface Ctx {
  version: number;
  refresh: () => void;
  nav: Nav;
  go: (page: Page, param?: string | null) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  propose: (type: string, payload: unknown, opts?: { rationale?: string; title?: string }) => void;
  reviewAction: (actionId: string) => void;
  status: any;
  openGuide: () => void;
}

const C = createContext<Ctx>(null as unknown as Ctx);
export const useGame = () => useContext(C);

export function GameProvider({ children, value }: { children: ReactNode; value: Ctx }) {
  return <C.Provider value={value}>{children}</C.Provider>;
}

/** Fetch a view; re-fetches whenever the world version changes. */
export function useView<T = any>(url: string | null): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const { version } = useGame();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [n, setN] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!url) return;
    const my = ++seq.current;
    setLoading(true);
    api
      .get<T>(url)
      .then((d) => {
        if (my === seq.current) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => my === seq.current && setError(e.message))
      .finally(() => my === seq.current && setLoading(false));
  }, [url, version, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data, error, loading, reload };
}
