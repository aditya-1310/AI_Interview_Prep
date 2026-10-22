// Polls GET /api/kits/:id/job every 1500ms while a job is queued/running.
// "Active" comes from the consumer (kit still pending, or a job we just
// triggered), but the loop is self-sustaining: if a fetch observes a job in
// flight (e.g. a reload during a regeneration), polling continues until it
// settles regardless of the flag. A single probe fetch happens on mount even
// when inactive, so a freshly opened failed kit still knows its error.
// onSettled fires only for jobs we actually saw in flight.

import { useEffect, useRef, useState } from 'react';
import { kitsApi, type JobState } from '../api/kits';

export interface JobPolling {
  job: JobState | null;
  setJob: React.Dispatch<React.SetStateAction<JobState | null>>;
}

const POLL_INTERVAL_MS = 1500;

export function useJobPolling(
  kitId: string | undefined,
  active: boolean,
  onSettled: (job: JobState) => void,
): JobPolling {
  const [job, setJob] = useState<JobState | null>(null);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const prevStatusRef = useRef<JobState['status'] | null>(null);

  useEffect(() => {
    if (!kitId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    prevStatusRef.current = null;
    setJob(null);

    const isSettled = (s: JobState['status'] | null | undefined): boolean =>
      s === 'completed' || s === 'failed';
    const inFlight = (s: JobState['status'] | null | undefined): boolean =>
      s === 'queued' || s === 'running';

    const tick = async () => {
      let next: JobState | null = null;
      try {
        next = await kitsApi.getJob(kitId);
      } catch {
        next = null; // transient network error
      }
      if (cancelled) return;

      if (next) {
        const prev = prevStatusRef.current;
        setJob(next);
        prevStatusRef.current = next.status;
        if (isSettled(next.status)) {
          // Announce only what we actually watched settle: either we observed
          // the job in flight, or we landed on it already completed (worth a
          // refresh + success path). A first observation that is ALREADY
          // failed - e.g. the previous job read during a retry handshake -
          // must never toast again.
          if (inFlight(prev) || next.status === 'completed') {
            onSettledRef.current(next);
          }
          return; // settled: stop polling
        }
        if (inFlight(next.status)) {
          // Self-sustaining: a real in-flight job keeps the loop going.
          if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
          return;
        }
      }

      // Unknown/no job state: keep polling only while flagged active.
      if (active && !cancelled) {
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [kitId, active]);

  return { job, setJob };
}
