// Company site crawler. A ranked iterative frontier instead of a fixed path
// list: fetch the entry page, extract same-host links (relative links resolved
// against the current page URL), score them by keyword hits over path + anchor
// text with hiring words weighted highest, fetch the best-looking pages and
// re-rank until the budget is spent - so a careers page buried behind
// about -> handbook is still discovered.
//
// Security: http/https only, DNS resolution with private/loopback/link-local
// rejection (unless ALLOW_PRIVATE_ADDRESSES=true for local fixtures),
// re-validated on every redirect hop (cross-host redirects are followed to
// their final public host, and crawling then continues from that host);
// content-type allowlist; 500KB body cap; 10s timeout; robots.txt respected
// including Crawl-delay. Failures are recorded, never fatal.

import { PipelineError } from '../core/ports';
import type { Warning } from '../core/types';
import type { Fetcher, Sleep } from './http';
import { defaultSleep } from './http';

// ---------------------------------------------------------------------------
// SSRF guard (pure functions, unit-tested offline)
// ---------------------------------------------------------------------------

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** True for loopback, private, link-local, CGNAT and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = IPV4_RE.exec(ip);
  if (v4) {
    const a = parseInt(v4[1], 10);
    const b = parseInt(v4[2], 10);
    if (a === 0 || a === 10 || a === 127) return true; // unspecified, private, loopback
    if (a === 169 && b === 254) return true; // link-local (169.254.0.0/16)
    if (a === 172 && b >= 16 && b <= 31) return true; // private (172.16.0.0/12)
    if (a === 192 && b === 168) return true; // private (192.168.0.0/16)
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 + TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    return false;
  }
  const v4mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4mapped) return isPrivateAddress(v4mapped[1]);
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  const firstHextet = parseInt(lower.split(':')[0] || '0', 16);
  if (Number.isNaN(firstHextet)) return true; // unparseable -> refuse
  if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/**
 * Pure offline-testable check over already-resolved IPs: returns the first
 * offending (private/loopback/link-local) address, or null when all are
 * public (or the private-range guard is explicitly disabled).
 */
export function offendingAddress(ips: string[], allowPrivate: boolean): string | null {
  if (allowPrivate) return null;
  for (const ip of ips) {
    if (isPrivateAddress(ip)) return ip;
  }
  return null;
}

export function privateAddressesAllowed(explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') return explicit;
  return process.env.ALLOW_PRIVATE_ADDRESSES === 'true';
}

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

/** http/https only, parseable, sane hostname. Throws PipelineError('URL_INVALID'). */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PipelineError('URL_INVALID', `"${raw.slice(0, 200)}" is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PipelineError(
      'URL_INVALID',
      `only http and https URLs are fetched, got "${url.protocol}"`,
    );
  }
  if (!url.hostname || !HOSTNAME_RE.test(url.hostname) || url.hostname.length > 253) {
    throw new PipelineError('URL_INVALID', `"${url.hostname || raw.slice(0, 100)}" is not a valid hostname`);
  }
  return url;
}

export type HostResolver = (hostname: string) => Promise<string[]>;

export const dnsResolver: HostResolver = async (hostname: string): Promise<string[]> => {
  const dns = await import('node:dns/promises');
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

interface HostGuardOptions {
  resolveHost?: HostResolver;
  allowPrivate?: boolean;
  hostCache?: Map<string, Promise<void>>;
}

/** Resolve DNS and refuse private/loopback/link-local targets. Cached per host. */
export async function assertPublicHost(hostname: string, opts: HostGuardOptions = {}): Promise<void> {
  const cache = opts.hostCache ?? new Map<string, Promise<void>>();
  const cached = cache.get(hostname);
  if (cached) {
    await cached;
    return;
  }
  const check = (async () => {
    const resolve = opts.resolveHost ?? dnsResolver;
    let ips: string[];
    try {
      ips = await resolve(hostname);
    } catch (err) {
      throw new PipelineError(
        'SITE_UNREACHABLE',
        `DNS lookup failed for "${hostname}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (ips.length === 0) {
      throw new PipelineError('SITE_UNREACHABLE', `DNS lookup returned no addresses for "${hostname}"`);
    }
    const bad = offendingAddress(ips, privateAddressesAllowed(opts.allowPrivate));
    if (bad) {
      throw new PipelineError(
        'SITE_UNREACHABLE',
        `refusing to fetch private/loopback address ${bad} for "${hostname}" (SSRF guard; set ALLOW_PRIVATE_ADDRESSES=true for local fixtures)`,
      );
    }
  })();
  cache.set(hostname, check);
  try {
    await check;
  } finally {
    // A failed check stays retryable on the next attempt.
    cache.delete(hostname);
  }
}

// ---------------------------------------------------------------------------
// Page fetching (manual redirects, content-type allowlist, size cap)
// ---------------------------------------------------------------------------

export interface FetchedPage {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
}

export interface FetchPageOptions extends HostGuardOptions {
  fetcher?: Fetcher;
  timeoutMs?: number;
  maxBytes?: number;
}

const MAX_REDIRECTS = 4;
const ALLOWED_CONTENT_TYPES = new Set(['text/html', 'text/plain']);

async function readCapped(res: Response, capBytes: number): Promise<string> {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let out = '';
    let seen = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (seen >= capBytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    out += decoder.decode();
    return out.slice(0, capBytes);
  }
  const text = await res.text();
  return text.slice(0, capBytes);
}

/**
 * Fetch one document, following up to 4 redirects MANUALLY so that every hop's
 * URL and resolved IP are re-validated (cross-host redirects included).
 */
export async function fetchPage(rawUrl: string, opts: FetchPageOptions = {}): Promise<FetchedPage> {
  const fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 512_000;
  const hostCache = opts.hostCache ?? new Map<string, Promise<void>>();

  let current = assertFetchableUrl(rawUrl);
  await assertPublicHost(current.hostname, { ...opts, hostCache });

  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await fetcher(current.href, { redirect: 'manual', signal: controller.signal });
    } catch (err) {
      throw new PipelineError(
        'SITE_UNREACHABLE',
        `request to ${current.href} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      await res.arrayBuffer().catch(() => undefined);
      if (!location) {
        throw new PipelineError('PAGE_FAILED', `redirect without a Location header at ${current.href}`);
      }
      let next: URL;
      try {
        next = new URL(location, current.href);
      } catch {
        throw new PipelineError('PAGE_FAILED', `invalid redirect target "${location.slice(0, 100)}" at ${current.href}`);
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new PipelineError('PAGE_FAILED', `redirect to disallowed protocol ${next.protocol} at ${current.href}`);
      }
      if (hop === MAX_REDIRECTS) {
        throw new PipelineError('PAGE_FAILED', `too many redirects (limit ${MAX_REDIRECTS}) starting at ${rawUrl}`);
      }
      await assertPublicHost(next.hostname, { ...opts, hostCache });
      current = next;
      continue;
    }
    break;
  }

  if (!res) throw new PipelineError('PAGE_FAILED', `no response for ${rawUrl}`);
  if (res.status < 200 || res.status >= 300) {
    await res.arrayBuffer().catch(() => undefined);
    throw new PipelineError('PAGE_FAILED', `HTTP ${res.status} at ${current.href}`);
  }
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    await res.arrayBuffer().catch(() => undefined);
    throw new PipelineError(
      'PAGE_FAILED',
      `unsupported content type "${contentType || 'unknown'}" at ${current.href}`,
    );
  }
  const body = await readCapped(res, maxBytes);
  return { finalUrl: current.href, status: res.status, contentType, body };
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00b7',
  rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c',
  copy: '\u00a9', trade: '\u2122', reg: '\u00ae', eacute: '\u00e9', deg: '\u00b0',
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/** Strip script/style/markup and collapse whitespace; cap at ~20k chars. */
export function htmlToText(html: string, maxChars = 20_000): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|nav|blockquote)\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v\u00a0]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim().slice(0, maxChars);
}

export function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return '';
  return decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function extractMetaProperty(html: string, property: string): string {
  const p = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${p}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${p}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${p}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${p}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1].trim()) return decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 150);
  }
  return '';
}

const ANCHOR_RE = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
const SKIP_URL_PREFIXES = ['#', 'mailto:', 'tel:', 'javascript:', 'data:'];
const ASSET_RE = /\.(png|jpe?g|gif|svg|ico|css|js|mjs|map|pdf|zip|gz|tgz|tar|mp4|webm|mov|mp3|wav|woff2?|ttf|otf|eot|xml|json|csv|xlsx?|docx?|pptx?)(\?|$)/i;

export interface ExtractedLink {
  url: string;
  anchor: string;
}

/** Pull links out of a page, resolving RELATIVE hrefs against the page URL. */
export function extractLinks(html: string, pageUrl: string): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  ANCHOR_RE.lastIndex = 0;
  while ((m = ANCHOR_RE.exec(html)) !== null) {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!href) continue;
    const lower = href.toLowerCase();
    if (SKIP_URL_PREFIXES.some((p) => lower.startsWith(p))) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, pageUrl); // relative links must work (local fixtures)
    } catch {
      continue;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    if (ASSET_RE.test(resolved.pathname)) continue;
    resolved.hash = '';
    if (seen.has(resolved.href)) continue;
    seen.add(resolved.href);
    const anchor = decodeEntities(m[4].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 120);
    out.push({ url: resolved.href, anchor });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Link scoring (pure, unit-tested: careers must outrank blog)
// ---------------------------------------------------------------------------

const STRONG_TOKENS: Array<[RegExp, number]> = [
  [/^careers?$/, 10],
  [/^jobs?$/, 10],
  [/^vacanc|^opening/, 9],
  [/hiring/, 10],
  [/recruit/, 9],
  [/interview/, 9],
  [/^join/, 8],
  [/apply|application/, 7],
  [/handbook/, 5],
];

const SOFT_TOKENS: Array<[RegExp, number]> = [
  [/^about$/, 4],
  [/team/, 4],
  [/engineer/, 4],
  [/culture/, 4],
  [/process/, 4],
  [/value/, 4],
  [/people/, 3],
  [/^blog$/, 3],
  [/news/, 2],
  [/product/, 2],
  [/compan/, 3],
  [/tech/, 2],
  [/work/, 3],
];

function keywordScore(text: string, table: Array<[RegExp, number]>): number {
  if (!text) return 0;
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let score = 0;
  for (const token of tokens) {
    for (const [re, weight] of table) {
      if (re.test(token)) {
        score += weight;
        break; // one weight per token
      }
    }
  }
  return score;
}

/**
 * Rank a discovered link by keyword hits over path + anchor text.
 * Hiring words (careers, hiring, interview, jobs, join-us...) weigh far more
 * than informational words (about, team, blog, handbook...).
 */
export function scoreLink(pathname: string, anchorText: string): number {
  const path = keywordScore(pathname, STRONG_TOKENS) * 1.0 + keywordScore(pathname, SOFT_TOKENS) * 0.5;
  const anchor = keywordScore(anchorText, STRONG_TOKENS) * 0.8 + keywordScore(anchorText, SOFT_TOKENS) * 0.4;
  return path + anchor;
}

// ---------------------------------------------------------------------------
// robots.txt (best-effort; fetch failures never crash a crawl)
// ---------------------------------------------------------------------------

export interface RobotsRules {
  disallow: string[];
  /** Crawl-delay seconds declared for User-agent: * (0 when absent). */
  crawlDelaySeconds: number;
}

export function parseRobots(txt: string): RobotsRules {
  const disallow: string[] = [];
  let crawlDelaySeconds = 0;
  let appliesToUs = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      appliesToUs = value === '*';
    } else if (appliesToUs && key === 'disallow') {
      if (value) disallow.push(value);
    } else if (appliesToUs && key === 'crawl-delay') {
      const parsed = parseFloat(value);
      if (Number.isFinite(parsed) && parsed > 0) crawlDelaySeconds = parsed;
    }
  }
  return { disallow, crawlDelaySeconds };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isAllowedByRobots(pathWithQuery: string, rules: RobotsRules | null): boolean {
  if (!rules || rules.disallow.length === 0) return true;
  const path = (pathWithQuery.split('?')[0] || '/').replace(/;.*$/, '');
  for (const rawPattern of rules.disallow) {
    const anchored = rawPattern.endsWith('$');
    const pattern = anchored ? rawPattern.slice(0, -1) : rawPattern;
    if (!pattern) continue;
    const source = '^' + pattern.split('*').map(escapeRegExp).join('.*') + (anchored ? '$' : '');
    try {
      if (new RegExp(source).test(path)) return false;
    } catch {
      // malformed rule - ignore it
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Hiring-page classification + company-name guess
// ---------------------------------------------------------------------------

const HIRING_PATH_RE = /(career|job|hiring|vacanc|opening|join|apply|recruit)/i;
const HIRING_TEXT_RE =
  /(we(?:'re| are)? hiring|our hiring process|how we hire|interview process|apply now|open positions|current openings|application process|take[- ]home|system design round|technical interview|cover letter|resum\u00e9|resume)/i;

export function isHiringPage(url: string, title: string, text: string): boolean {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // keep raw string
  }
  if (HIRING_PATH_RE.test(pathname)) return true;
  if (HIRING_TEXT_RE.test(title)) return true;
  return HIRING_TEXT_RE.test(text.slice(0, 4_000));
}

export function guessCompanyName(hostname: string, title: string, ogSiteName: string): string {
  const fromOg = ogSiteName.trim();
  if (fromOg) return fromOg;
  const firstSegment = title.split(/[|\u2014\u2013\u00b7:]/)[0]?.trim() ?? '';
  if (firstSegment && /[a-z]/i.test(firstSegment) && firstSegment.length <= 60) return firstSegment;
  const host = hostname.replace(/^www\./, '');
  const base = host.split('.')[0] || host || 'Unknown';
  return base.charAt(0).toUpperCase() + base.slice(1);
}

// ---------------------------------------------------------------------------
// The crawler itself
// ---------------------------------------------------------------------------

export interface CrawlPage {
  url: string;
  title: string;
  text: string;
}

export interface CrawlResult {
  pages: CrawlPage[];
  hiringPages: CrawlPage[];
  infoPages: CrawlPage[];
  company: string;
  warnings: Warning[];
}

export interface CrawlOptions extends FetchPageOptions {
  maxPages?: number;
  maxDepth?: number;
  perHostDelayMs?: number;
  sleep?: Sleep;
}

interface FetchedRecord {
  page: CrawlPage;
  html: string;
}

interface FrontierEntry {
  href: string;
  depth: number;
  score: number;
  foundOrder: number;
  origin: string;
}

function normalizeHref(href: string): string {
  try {
    const u = new URL(href);
    u.hash = '';
    return u.href;
  } catch {
    return href;
  }
}

/**
 * Ranked iterative crawl of one company site.
 * Never throws for per-page problems: everything unreachable/skipped becomes a
 * recorded warning and the case continues on JD-only research.
 */
export async function crawlCompanySite(entryUrl: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const maxPages = Math.max(1, opts.maxPages ?? 15);
  const maxDepth = Math.max(1, opts.maxDepth ?? 3);
  const perHostDelayMs = opts.perHostDelayMs ?? 750;
  const sleep = opts.sleep ?? defaultSleep;
  const warnings: Warning[] = [];
  const pages: CrawlPage[] = [];
  const hiringPages: CrawlPage[] = [];
  const hostCache = opts.hostCache ?? new Map<string, Promise<void>>();
  const fetchOpts: FetchPageOptions = { ...opts, hostCache };
  const robotsByOrigin = new Map<string, RobotsRules | null>();
  const hostDelayMs = new Map<string, number>();
  const lastFetchByHost = new Map<string, number>();

  async function robotsFor(origin: string): Promise<RobotsRules | null> {
    if (robotsByOrigin.has(origin)) return robotsByOrigin.get(origin) ?? null;
    let rules: RobotsRules | null = null;
    try {
      const page = await fetchPage(`${origin}/robots.txt`, { ...fetchOpts, maxBytes: 64_000 });
      rules = parseRobots(page.body);
    } catch {
      rules = null; // missing/broken robots -> assume allowed, never crash
    }
    robotsByOrigin.set(origin, rules);
    return rules;
  }

  async function respectHostDelay(origin: string, robots: RobotsRules | null): Promise<void> {
    const declared = (robots?.crawlDelaySeconds ?? 0) * 1000;
    const delay = Math.max(perHostDelayMs, declared);
    hostDelayMs.set(origin, delay);
    const last = lastFetchByHost.get(origin);
    if (last === undefined) return;
    const wait = last + delay - Date.now();
    if (wait > 0) await sleep(wait);
  }

  function markFetched(origin: string): void {
    lastFetchByHost.set(origin, Date.now());
  }

  async function fetchAndRecord(href: string, isEntry = false): Promise<FetchedRecord | null> {
    try {
      const fetched = await fetchPage(href, fetchOpts);
      const title = extractTitle(fetched.body);
      const text = htmlToText(fetched.body);
      const page: CrawlPage = { url: fetched.finalUrl, title, text };
      pages.push(page);
      visited.add(normalizeHref(fetched.finalUrl));
      if (isHiringPage(page.url, title, text)) hiringPages.push(page);
      return { page, html: fetched.body };
    } catch (err) {
      const code =
        isEntry || (err instanceof PipelineError && err.code === 'SITE_UNREACHABLE')
          ? 'SITE_UNREACHABLE'
          : 'PAGE_FAILED';
      const message = err instanceof Error ? err.message : String(err);
      warnings.push({
        code,
        message: isEntry ? `company site entry page unreachable: ${message}` : `${href}: ${message}`,
      });
      return null;
    }
  }

  const visited = new Set<string>();
  const frontier = new Map<string, FrontierEntry>();
  let order = 0;
  let ogSiteName = '';
  let titleForName = '';
  let entryHost = '';
  let companyHost = '';

  try {
    const entry = assertFetchableUrl(entryUrl);
    entryHost = entry.hostname;
    companyHost = entry.hostname;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      pages,
      hiringPages,
      infoPages: [],
      company: 'Unknown',
      warnings: [
        {
          code: 'SITE_UNREACHABLE',
          message: `The company website address couldn't be used (${message}), so research was skipped and the kit was built from the job description alone.`,
        },
      ],
    };
  }

  function offer(href: string, depth: number, anchor: string, origin: string): void {
    const key = normalizeHref(href);
    if (visited.has(key)) return;
    let url: URL;
    try {
      url = new URL(key);
    } catch {
      return;
    }
    if (url.hostname !== companyHost) return; // same-host expansion only
    if (url.pathname === '/robots.txt') return;
    const score = scoreLink(url.pathname, anchor) - depth * 0.5;
    const existing = frontier.get(key);
    if (existing && existing.score >= score) return;
    frontier.set(key, {
      href: key,
      depth,
      score,
      foundOrder: existing?.foundOrder ?? order++,
      origin,
    });
  }

  let firstHtml: string | null = null;
  try {
    const entry = new URL(entryUrl);
    const entryRobots = await robotsFor(entry.origin);
    if (!isAllowedByRobots(entry.pathname + entry.search, entryRobots)) {
      return {
        pages,
        hiringPages,
        infoPages: [],
        company: guessCompanyName(entryHost, '', ''),
        warnings: [
          {
            code: 'SITE_UNREACHABLE',
            message: `The company website (${entry.origin}) disallows automated access, so research was skipped and the kit was built from the job description alone.`,
          },
        ],
      };
    }

    markFetched(entry.origin);
    await respectHostDelay(entry.origin, entryRobots);
    const first = await fetchAndRecord(entry.href, true);
    if (!first) {
      return { pages, hiringPages, infoPages: [], company: guessCompanyName(entryHost, '', ''), warnings };
    }
    firstHtml = first.html;
    ogSiteName = extractMetaProperty(first.html, 'og:site_name');
    titleForName = first.page.title;
    // A cross-host redirect moves the crawl to the FINAL host (e.g. a bare
    // domain that 301s to www or about.): link expansion continues from there.
    companyHost = new URL(first.page.url).hostname;
    for (const { url, anchor } of extractLinks(first.html, first.page.url)) {
      offer(url, 1, anchor, new URL(first.page.url).origin);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[crawl] entry fetch failed for ${entryUrl}:`, message);
    warnings.push({
      code: 'SITE_UNREACHABLE',
      message: `The company website (${entryUrl}) could not be reached, so research was skipped and the kit was built from the job description alone.`,
    });
  }

  void firstHtml; // kept for debugging; text extraction already consumed the page

  // Ranked frontier walk: best-scoring unvisited page next, re-rank after
  // every fetch, respect the depth and page budgets and per-host politeness.
  while (pages.length < maxPages && frontier.size > 0) {
    let best: FrontierEntry | null = null;
    for (const candidate of frontier.values()) {
      if (
        !best ||
        candidate.score > best.score ||
        (candidate.score === best.score &&
          (candidate.depth < best.depth ||
            (candidate.depth === best.depth && candidate.foundOrder < best.foundOrder)))
      ) {
        best = candidate;
      }
    }
    if (!best) break;
    frontier.delete(best.href);

    let target: URL;
    try {
      target = new URL(best.href);
    } catch {
      continue;
    }
    const robots = await robotsFor(target.origin);
    if (!isAllowedByRobots(target.pathname + target.search, robots)) {
      warnings.push({ code: 'PAGE_FAILED', message: `${best.href}: skipped (disallowed by robots.txt)` });
      continue;
    }

    markFetched(target.origin);
    await respectHostDelay(target.origin, robots);
    const record = await fetchAndRecord(best.href);
    if (!record || pages.length >= maxPages || best.depth >= maxDepth) continue;

    for (const { url, anchor } of extractLinks(record.html, record.page.url)) {
      offer(url, best.depth + 1, anchor, target.origin);
    }
  }

  const infoPages = pages.filter((p) => !hiringPages.includes(p));
  const company = guessCompanyName(companyHost || entryHost, titleForName, ogSiteName);
  return { pages, hiringPages, infoPages, company, warnings };
}
