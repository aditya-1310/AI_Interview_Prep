// Dashboard: new-kit form, upload a file of pairs, and the kit list with
// status chips and delete-with-confirm. Handles loading/empty/error for the
// list, and inline validation for the form and uploaded file.

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarDays, FileUp, Inbox, Sparkles, Trash2 } from 'lucide-react';
import { errMessage } from '../api/client';
import { kitsApi, type KitListItem } from '../api/kits';
import {
  Button,
  Chip,
  ConfirmButton,
  EmptyState,
  ErrorBanner,
  Field,
  SkeletonCard,
  StatusChip,
  TextInput,
  focusRing,
} from '../components/primitives';
import { useToast } from '../components/ToastContext';
import { normalizeCompanyUrl, parseBatchCases, type BatchPair } from '../lib/batchFile';
import { formatDate } from '../lib/dates';

interface NewKitFormState {
  jd: string;
  companyUrl: string;
  days: string;
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [items, setItems] = useState<KitListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setListError(null);
    try {
      setItems(await kitsApi.list());
    } catch (e) {
      setListError(errMessage(e));
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Cards must not go stale while generation runs elsewhere: refresh the list
  // periodically for as long as any kit is pending, then stop.
  const anyPending = (items ?? []).some((k) => k.status === 'pending');
  useEffect(() => {
    if (!anyPending) return;
    const timer = setInterval(() => void load(), 8_000);
    return () => clearInterval(timer);
  }, [anyPending, load]);

  const deleteKit = async (item: KitListItem) => {
    try {
      await kitsApi.remove(item.id);
      toast(`Deleted the kit for ${item.company || 'unknown company'}`, 'success');
      void load();
    } catch (e) {
      toast(errMessage(e), 'error');
    }
  };

  /* ------------------------------------------------------- new kit form */

  const [form, setForm] = useState<NewKitFormState>({ jd: '', companyUrl: '', days: '7' });
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof NewKitFormState, string>>>({});
  const [creating, setCreating] = useState(false);
  const [createFormError, setCreateFormError] = useState<string | null>(null);

  const setField = (key: keyof NewKitFormState, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (formErrors[key]) setFormErrors((e) => ({ ...e, [key]: undefined }));
  };

  const validateForm = (): boolean => {
    const next: Partial<Record<keyof NewKitFormState, string>> = {};
    if (form.jd.trim().length < 20) {
      next.jd = 'Paste the job description (a few lines at least).';
    }
    if (form.companyUrl.trim().length === 0) {
      next.companyUrl = 'Enter the company website, e.g. https://acme.com';
    }
    const days = Number(form.days);
    if (form.days.trim() === '' || !Number.isInteger(days) || days < 1 || days > 60) {
      next.days = 'Days must be a whole number between 1 and 60.';
    }
    setFormErrors(next);
    return Object.values(next).every((v) => v === undefined);
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setCreateFormError(null);
    if (!validateForm()) return;
    setCreating(true);
    try {
      const res = await kitsApi.create({
        jd: form.jd.trim(),
        companyUrl: normalizeCompanyUrl(form.companyUrl),
        days: Number(form.days),
      });
      if (res?.duplicate) {
        toast('You already have a kit for this exact posting — opening it.');
      }
      navigate(`/kits/${res.kitId}`);
    } catch (err) {
      setCreateFormError(errMessage(err));
      setCreating(false);
    }
  };

  /* --------------------------------------------------- upload file form */

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [pairs, setPairs] = useState<BatchPair[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    setFileError(null);
    setPairs(null);
    setFileName(null);
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseBatchCases(text);
      setPairs(parsed);
      setFileName(file.name);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'Could not read this file.');
    }
  };

  const handleUpload = async () => {
    if (!pairs) return;
    setUploading(true);
    try {
      await kitsApi.batchCreate(pairs);
      toast(`Queued ${pairs.length} kit${pairs.length === 1 ? '' : 's'} — watch them generate below.`, 'success');
      setPairs(null);
      setFileName(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      void load();
    } catch (e) {
      setFileError(errMessage(e));
    } finally {
      setUploading(false);
    }
  };

  /* ---------------------------------------------------------- rendering */

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-slate-400">
          Turn a job description into a personalised prep kit — brief, questions, flashcards and a
          day-by-day schedule.
        </p>
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* New kit */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Sparkles className="h-4 w-4 text-indigo-300" aria-hidden />
            New kit
          </h2>
          <form className="mt-4 space-y-4" onSubmit={(e) => void handleCreate(e)} noValidate>
            {createFormError ? <ErrorBanner message={createFormError} /> : null}
            <Field
              id="new-jd"
              label="Job description"
              error={formErrors.jd}
              hint="Paste the full posting as text."
            >
              <textarea
                id="new-jd"
                rows={7}
                value={form.jd}
                onChange={(e) => setField('jd', e.target.value)}
                placeholder="Paste the job description here…"
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <Field id="new-company-url" label="Company website" error={formErrors.companyUrl}>
                <TextInput
                  id="new-company-url"
                  type="text"
                  inputMode="url"
                  value={form.companyUrl}
                  onChange={(e) => setField('companyUrl', e.target.value)}
                  placeholder="https://acme.com"
                />
              </Field>
              <Field id="new-days" label="Days to prepare" error={formErrors.days}>
                <TextInput
                  id="new-days"
                  type="number"
                  min={1}
                  max={60}
                  value={form.days}
                  onChange={(e) => setField('days', e.target.value)}
                  className="w-28"
                />
              </Field>
            </div>
            <Button type="submit" pending={creating} className="w-full sm:w-auto">
              Generate my kit
            </Button>
          </form>
        </section>

        {/* Upload pairs */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <FileUp className="h-4 w-4 text-indigo-300" aria-hidden />
            Prepare several roles at once
          </h2>
          <p className="mt-2 text-xs text-slate-400">
            Upload a JSON file of pairs shaped like{' '}
            <code className="rounded bg-slate-800 px-1 py-0.5">
              {'{ "cases": [{ "jd": "…", "companyUrl": "https://acme.com", "days": 5 }] }'}
            </code>{' '}
            (a bare array also works). Each pair becomes its own kit.
          </p>
          <div className="mt-4 space-y-3">
            {fileError ? <ErrorBanner message={fileError} /> : null}
            <label
              className={`flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-slate-700 px-4 py-3 text-sm text-slate-300 transition-colors hover:border-indigo-400 hover:text-indigo-200 ${focusRing}`}
            >
              <FileUp className="h-4 w-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                {fileName ?? 'Choose a .json file of pairs'}
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={(e) => void handleFile(e)}
                className="sr-only"
              />
            </label>
            {pairs && pairs.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <Chip className="border-emerald-500/50 bg-emerald-500/15 text-emerald-300">
                  {pairs.length} pair{pairs.length === 1 ? '' : 's'} ready
                </Chip>
                <Button onClick={() => void handleUpload()} pending={uploading}>
                  Create {pairs.length} kit{pairs.length === 1 ? '' : 's'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setPairs(null);
                    setFileName(null);
                    if (fileInputRef.current) fileInputRef.current.value = '';
                  }}
                >
                  Clear
                </Button>
              </div>
            ) : null}
          </div>
        </section>
      </div>

      {/* Kit list */}
      <section aria-labelledby="kit-list-heading">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="kit-list-heading" className="text-sm font-semibold text-slate-200">
            Your kits
          </h2>
        </div>

        {items === null ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : listError ? (
          <ErrorBanner message={listError}>
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          </ErrorBanner>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No kits yet"
            description="Paste a job description above to generate your first prep kit."
          />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <li
                key={item.id}
                className="relative rounded-xl border border-slate-800 bg-slate-900/60 p-4 transition-colors hover:border-slate-600"
              >
                <Link
                  to={`/kits/${item.id}`}
                  aria-label={`Open kit: ${item.company || 'Unknown company'}${item.role ? `, ${item.role}` : ''}`}
                  className={`absolute inset-0 rounded-xl ${focusRing}`}
                />
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold text-slate-100">
                      {item.company || 'Unknown company'}
                    </h3>
                    <p className="truncate text-sm text-slate-400">{item.role || 'Role pending'}</p>
                  </div>
                  <div className="relative z-10 shrink-0">
                    <ConfirmButton
                      label="Delete"
                      confirmLabel="Delete kit?"
                      note="Permanently deletes this kit and its practice history."
                      icon={Trash2}
                      variant="danger-ghost"
                      onConfirm={() => void deleteKit(item)}
                      aria-label={`Delete kit for ${item.company || 'unknown company'}`}
                    />
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <StatusChip status={item.status} />
                  <Chip>
                    <CalendarDays className="h-3 w-3" aria-hidden />
                    {item.days}-day plan
                  </Chip>
                  <span>{formatDate(item.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
