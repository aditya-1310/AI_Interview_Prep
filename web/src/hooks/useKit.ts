// Single kit fetch + optimistic-concurrency mutation helper.
//
// Every mutation is sent with baseVersion = the latest version we know. On
// 409 VERSION_CONFLICT we adopt the server's currentKit, tell the user via a
// toast, and re-apply the same mutation exactly once against the fresh
// version — matching the interaction contract in docs/03-api-contract.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, errMessage } from '../api/client';
import { isKitRecord, kitsApi, type KitRecordDoc } from '../api/kits';
import { useToast } from '../components/ToastContext';

export type MutateMethod = 'POST' | 'PATCH' | 'DELETE';

export interface MutateOptions {
  /** Refresh the kit after a response that is not a kit document (default true). */
  refreshUnlessKit?: boolean;
}

export interface KitState {
  kit: KitRecordDoc | null;
  setKit: React.Dispatch<React.SetStateAction<KitRecordDoc | null>>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<KitRecordDoc | null>;
  mutate: <T = unknown>(
    method: MutateMethod,
    path: string,
    body?: Record<string, unknown>,
    options?: MutateOptions,
  ) => Promise<T | undefined>;
}

export function useKit(id: string | undefined): KitState {
  const [kit, setKitState] = useState<KitRecordDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const kitRef = useRef<KitRecordDoc | null>(null);
  const { toast } = useToast();

  const setKit = useCallback<React.Dispatch<React.SetStateAction<KitRecordDoc | null>>>(
    (next) => {
      setKitState((prev) => {
        const value = typeof next === 'function' ? next(prev) : next;
        kitRef.current = value;
        return value;
      });
    },
    [],
  );

  const refresh = useCallback(async (): Promise<KitRecordDoc | null> => {
    if (!id) return null;
    try {
      setError(null);
      const next = await kitsApi.get(id);
      setKit(next);
      return next;
    } catch (e) {
      setError(errMessage(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, [id, setKit]);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setKit(null);
    void refresh();
  }, [id, refresh, setKit]);

  const mutate = useCallback(
    async <T = unknown,>(
      method: MutateMethod,
      path: string,
      body?: Record<string, unknown>,
      options?: MutateOptions,
    ): Promise<T | undefined> => {
      if (!id) return undefined;

      const withBaseVersion = (
        b: Record<string, unknown> | undefined,
        version: number | undefined,
      ): Record<string, unknown> | undefined => {
        if (!b || version === undefined || b.baseVersion !== undefined) return b;
        return { ...b, baseVersion: version };
      };

      const attempt = (version?: number) =>
        api.request<T>(method, path, withBaseVersion(body, version));

      const apply = (res: T | undefined): boolean => {
        if (isKitRecord(res)) {
          setKit(res);
          return true;
        }
        return false;
      };

      const finish = async (res: T | undefined): Promise<T | undefined> => {
        if (!apply(res) && options?.refreshUnlessKit !== false) {
          void refresh();
        }
        return res;
      };

      try {
        return await finish(await attempt(kitRef.current?.version));
      } catch (e) {
        if (e instanceof ApiError && e.code === 'VERSION_CONFLICT' && isKitRecord(e.currentKit)) {
          setKit(e.currentKit);
          toast('This kit changed elsewhere — your edit will re-apply on the fresh copy');
          const retried = await attempt(e.currentKit.version);
          return finish(retried);
        }
        throw e;
      }
    },
    [id, refresh, setKit, toast],
  );

  return { kit, setKit, loading, error, refresh, mutate };
}
