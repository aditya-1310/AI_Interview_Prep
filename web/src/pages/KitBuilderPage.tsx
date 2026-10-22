// The builder. Three regimes:
//   - generating (initial run or retry): step timeline + latest message,
//     partial-failure warnings, live via 1500ms job polling;
//   - failed: the pipeline error + Retry (resumes from checkpoints);
//   - ready: tabs for Brief / Questions / Flashcards / Schedule / Weak spots,
//     with a slim "regenerating…" banner while a section regenerates and a
//     dismissible warnings banner. Inline edits are debounced PATCHes with
//     baseVersion; conflicts resolve through useKit's re-apply logic.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  CalendarDays,
  CircleAlert,
  FileText,
  Layers,
  ListChecks,
  LoaderCircle,
  RotateCcw,
  Target,
} from 'lucide-react';
import { errMessage } from '../api/client';
import { kitsApi } from '../api/kits';
import { useJobPolling } from '../hooks/useJobPolling';
import { useKit } from '../hooks/useKit';
import {
  Button,
  Chip,
  ErrorBanner,
  Skeleton,
  StatusChip,
} from '../components/primitives';
import { ProgressTimeline, isJobRunning, latestProgressMessage } from '../components/ProgressTimeline';
import { Tabs } from '../components/Tabs';
import { WarningsBanner } from '../components/WarningsBanner';
import { BriefTab } from '../components/builder/BriefTab';
import { QuestionsTab } from '../components/builder/QuestionsTab';
import { FlashcardsTab } from '../components/builder/FlashcardsTab';
import { ScheduleTab } from '../components/builder/ScheduleTab';
import { WeakSpotsTab } from '../components/builder/WeakSpotsTab';
import { useToast } from '../components/ToastContext';
import { SECTION_LABELS } from '../lib/labels';
import type { KitMutations } from '../lib/mutations';
import { formatDateTime } from '../lib/dates';

const TAB_IDS = ['brief', 'questions', 'flashcards', 'schedule', 'weak-spots'] as const;
type TabId = (typeof TAB_IDS)[number];

export default function KitBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const { kit, loading, error, refresh, mutate } = useKit(id);

  const [jobTriggered, setJobTriggered] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('brief');
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const status = kit?.status;

  // Poll while the kit itself is generating, or while a job we triggered is
  // queued. The hook additionally self-sustains for any observed in-flight
  // job (e.g. a reload during a regeneration) and probes once on mount.
  const pollActive = !!id && !!kit && (status === 'pending' || jobTriggered || retrying);

  const { job, setJob } = useJobPolling(id, pollActive, (settled) => {
    setJobTriggered(false);
    setRetrying(false);
    void refresh();
    if (settled.status === 'failed') {
      toast(`Job failed: ${settled.error?.message ?? 'unknown error'}`, 'error');
    }
  });

  useEffect(
    () => () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    },
    [],
  );

  /* ------------------------------------------------------------ mutations */

  const mutations = useMemo<KitMutations>(() => {
    const guard = (p: Promise<unknown>) => {
      void p.catch((e: unknown) => toast(errMessage(e), 'error'));
    };
    return {
      patchBrief: async (patch) => {
        await mutate('PATCH', `/kits/${id}/brief`, patch);
      },
      patchQuestion: async (qid, patch) => {
        await mutate('PATCH', `/kits/${id}/questions/${qid}`, patch as Record<string, unknown>);
      },
      patchFlashcard: async (fid, patch) => {
        await mutate('PATCH', `/kits/${id}/flashcards/${fid}`, patch as Record<string, unknown>);
      },
      patchScheduleDay: async (day, patch) => {
        const days = (kit?.kit?.schedule?.days ?? []).map((d) =>
          d.day === day ? { ...d, ...patch } : d,
        );
        if (days.length === 0) return;
        await mutate('PATCH', `/kits/${id}/schedule`, { days });
      },
      addQuestion: async (fields) => {
        await mutate('POST', `/kits/${id}/questions`, { ...fields });
      },
      addFlashcard: async (fields) => {
        await mutate('POST', `/kits/${id}/flashcards`, { ...fields });
      },
      deleteQuestion: (qid) => guard(mutate('DELETE', `/kits/${id}/questions/${qid}`)),
      deleteFlashcard: (fid) => guard(mutate('DELETE', `/kits/${id}/flashcards/${fid}`)),
      reorderQuestions: (orderedIds) =>
        guard(mutate('POST', `/kits/${id}/questions/reorder`, { orderedIds })),
      toggleQuestionPin: (qid) => guard(mutate('POST', `/kits/${id}/questions/${qid}/pin`)),
      toggleFlashcardPin: (fid) => guard(mutate('POST', `/kits/${id}/flashcards/${fid}/pin`)),
      regenerate: (section, days) => {
        void (async () => {
          try {
            await mutate(
              'POST',
              `/kits/${id}/regenerate`,
              days !== undefined ? { section, days } : { section },
            );
            setJobTriggered(true);
            setJob({ status: 'queued', progress: [] });
            toast(`${SECTION_LABELS[section] ?? section} regeneration queued`);
          } catch (e) {
            toast(errMessage(e), 'error');
          }
        })();
      },
      refresh: () => {
        void refresh();
      },
    };
  }, [mutate, id, kit, toast, refresh, setJob]);

  /* --------------------------------------------------------------- actions */

  const triggerJobOptimistically = () => {
    setJobTriggered(true);
    setJob({ status: 'queued', progress: [] });
  };

  const handleRetry = async () => {
    if (!id) return;
    setRetrying(true);
    try {
      await kitsApi.retryJob(id);
      triggerJobOptimistically();
      void refresh();
    } catch (e) {
      setRetrying(false);
      toast(errMessage(e), 'error');
    }
  };

  const jumpToQuestion = useCallback((qid: string) => {
    setActiveTab('questions');
    setHighlightId(qid);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightId(null), 2400);
    setTimeout(() => {
      document.getElementById(`question-${qid}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
  }, []);

  /* --------------------------------------------------------------- regimes */

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!kit) {
    return (
      <div className="space-y-4">
        <BackToDashboard />
        {error ? (
          <ErrorBanner message={error}>
            <Button size="sm" variant="secondary" onClick={() => void refresh()}>
              Try again
            </Button>
          </ErrorBanner>
        ) : (
          <ErrorBanner title="Kit not found" message="This kit does not exist or is not yours." />
        )}
      </div>
    );
  }

  const k = kit.kit;
  const running = isJobRunning(job);
  const generating =
    status === 'pending' || (retrying && running) || (jobTriggered && running && status !== 'ready');

  if (generating) {
    return (
      <div className="space-y-5">
        <BackToDashboard />
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">
              {k?.source?.company || kit.input.companyUrl || 'Your kit'}
            </h1>
            <StatusChip status={status ?? 'pending'} />
          </div>
          <p className="text-sm text-slate-400">
            {k?.role?.title ? `${k.role.title} · ` : ''}
            {kit.input.days}-day plan · started {formatDateTime(kit.createdAt)}
          </p>
          <p className="text-xs text-slate-500">
            Generation usually takes one to three minutes. You can leave this page — work continues
            on the server.
          </p>
        </header>
        {(k?.warnings?.length ?? 0) > 0 ? <WarningsBanner warnings={k?.warnings ?? []} /> : null}
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <ProgressTimeline job={job} />
        </section>
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className="space-y-5">
        <BackToDashboard />
        <ErrorBanner
          title="Generation failed"
          message={
            job?.error?.message ??
            'The pipeline could not finish this kit. Retrying resumes from the last checkpoint.'
          }
        >
          <span className="text-xs opacity-80">
            {job?.error?.code ? `Error code: ${job.error.code}` : undefined}
          </span>
          <Button size="sm" icon={RotateCcw} onClick={() => void handleRetry()} pending={retrying && !running}>
            Retry generation
          </Button>
        </ErrorBanner>
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <ProgressTimeline job={job} />
        </section>
      </div>
    );
  }

  /* ------------------------------------------------------------ ready view */

  const tabs = [
    { id: 'brief' as TabId, label: 'Brief', icon: FileText },
    { id: 'questions' as TabId, label: 'Questions', icon: ListChecks, badge: k?.questions?.length },
    { id: 'flashcards' as TabId, label: 'Flashcards', icon: Layers, badge: k?.flashcards?.length },
    { id: 'schedule' as TabId, label: 'Schedule', icon: CalendarDays },
    { id: 'weak-spots' as TabId, label: 'Weak spots', icon: Target },
  ];

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <BackToDashboard />
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">
            {k?.source?.company || kit.input.companyUrl || 'Your kit'}
          </h1>
          <StatusChip status={status ?? 'ready'} />
          <Chip title={`Optimistic-concurrency version ${kit.version}`}>v{kit.version}</Chip>
          <span className="text-xs text-slate-500">created {formatDateTime(kit.createdAt)}</span>
        </div>
        {k?.role?.title ? (
          <p className="text-sm text-slate-400">
            {k.role.title}
            {k.role.seniority ? ` · ${k.role.seniority}` : ''}
            {k.source?.location ? ` · ${k.source.location}` : ''}
            {' · '}
            {kit.input.days}-day plan
          </p>
        ) : (
          <p className="text-sm text-slate-400">{kit.input.days}-day plan</p>
        )}
      </header>

      <WarningsBanner warnings={k?.warnings ?? []} />

      {running || jobTriggered ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-3 rounded-xl border border-indigo-500/40 bg-indigo-500/10 px-4 py-3"
        >
          {running ? (
            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-indigo-300" aria-hidden />
          ) : (
            <CircleAlert className="h-4 w-4 shrink-0 text-indigo-300" aria-hidden />
          )}
          <p className="min-w-0 flex-1 text-sm text-indigo-100">
            <span className="font-medium">
              {running ? 'Regenerating a section…' : 'Finishing up…'}
            </span>{' '}
            <span className="break-words opacity-80">{latestProgressMessage(job)}</span>
          </p>
        </div>
      ) : null}

      <Tabs
        tabs={tabs}
        active={activeTab}
        onChange={(t) => setActiveTab(t as TabId)}
        ariaLabel="Kit sections"
      />

      <div
        role="tabpanel"
        id={`panel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
        className="pb-8"
      >
        {activeTab === 'brief' ? <BriefTab record={kit} m={mutations} regenBusy={running} /> : null}
        {activeTab === 'questions' ? (
          <QuestionsTab
            record={kit}
            m={mutations}
            regenBusy={running}
            highlightedId={highlightId}
          />
        ) : null}
        {activeTab === 'flashcards' ? <FlashcardsTab record={kit} m={mutations} /> : null}
        {activeTab === 'schedule' ? (
          <ScheduleTab
            record={kit}
            m={mutations}
            regenBusy={running}
            onJumpToQuestion={jumpToQuestion}
          />
        ) : null}
        {activeTab === 'weak-spots' ? <WeakSpotsTab record={kit} kitId={id ?? ''} /> : null}
      </div>
    </div>
  );
}

function BackToDashboard() {
  return (
    <div>
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 rounded-lg text-sm text-slate-400 transition-colors hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All kits
      </Link>
    </div>
  );
}
