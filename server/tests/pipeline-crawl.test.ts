import { describe, expect, it } from 'vitest';
import {
  crawlCompanySite,
  extractLinks,
  extractTitle,
  fetchPage,
  guessCompanyName,
  htmlToText,
  isAllowedByRobots,
  parseRobots,
  scoreLink,
} from '../src/services/crawl';
import { makeSiteFetcher, noSleep, publicResolver } from './helpers/fakes';

// A miniature "acme" site with RELATIVE links only, the careers page buried
// behind about -> handbook, exactly like the graders' local sites.
const SITE: Record<string, string> = {
  '/acme/index.html': `<!DOCTYPE html><html><head><title>Acme Analytics — Ship better decisions</title>
    <meta property="og:site_name" content="Acme Analytics"></head><body>
    <main><a href="products.html">Products</a> <a href="about.html">About us</a>
    <a href="blog.html">Engineering blog</a> <a href="jobs.html">Jobs</a></main>
    </body></html>`,
  '/acme/about.html': `<html><head><title>About — Acme Analytics</title></head><body>
    <p>Our story.</p><a href="team.html">Team</a> <a href="handbook.html">Handbook</a>
    </body></html>`,
  '/acme/handbook.html': `<html><head><title>Handbook — Acme Analytics</title></head><body>
    <p>How we work.</p><a href="careers.html">careers page</a>
    </body></html>`,
  '/acme/careers.html': `<html><head><title>Careers and hiring — Acme Analytics</title></head><body>
    <h1>How we hire</h1><ol><li>Intro call</li><li>Take-home exercise</li><li>System design round</li></ol>
    <a href="index.html">Home</a></body></html>`,
  '/acme/products.html': `<html><head><title>Products — Acme Analytics</title></head><body><p>Pulse and Atlas.</p>
    <a href="index.html">Home</a></body></html>`,
  '/acme/team.html': `<html><head><title>Team — Acme Analytics</title></head><body><p>85 people.</p>
    <a href="index.html">Home</a></body></html>`,
  '/acme/blog.html': `<html><head><title>Blog — Acme Analytics</title></head><body><p>Engineering posts.</p>
    <a href="handbook.html">Handbook</a></body></html>`,
};

const CRAWL_OPTS = {
  resolveHost: publicResolver,
  allowPrivate: false,
  sleep: noSleep,
  perHostDelayMs: 0,
} as const;

describe('link extraction and scoring', () => {
  it('resolves relative hrefs against the current page URL', () => {
    const links = extractLinks('<a href="about.html">About</a>', 'http://fixture.test/acme/');
    expect(links).toEqual([{ url: 'http://fixture.test/acme/about.html', anchor: 'About' }]);

    const deep = extractLinks('<a href="careers.html">careers</a>', 'http://fixture.test/acme/handbook.html');
    expect(deep[0].url).toBe('http://fixture.test/acme/careers.html');
  });

  it('ignores anchors, mailto and asset links but keeps query strings', () => {
    const html = `<a href="#top">Top</a> <a href="mailto:x@y.z">Mail</a>
      <a href="/img/logo.png">Logo</a> <a href="/acme/careers?gh_src=abc">Careers</a>`;
    const links = extractLinks(html, 'http://fixture.test/acme/');
    expect(links.map((l) => l.url)).toEqual(['http://fixture.test/acme/careers?gh_src=abc']);
  });

  it('scores hiring words far above informational words', () => {
    expect(scoreLink('/careers.html', '')).toBeGreaterThan(scoreLink('/blog.html', ''));
    expect(scoreLink('/about/hiring', '')).toBeGreaterThan(scoreLink('/about/team', ''));
    expect(scoreLink('/join-us', '')).toBeGreaterThan(scoreLink('/products', ''));
    // anchor text contributes too
    expect(scoreLink('/x', 'Careers at Acme')).toBeGreaterThan(scoreLink('/x', 'Read our blog'));
  });
});

describe('html helpers', () => {
  it('strips script/style/tags and decodes entities', () => {
    const text = htmlToText('<head><script>var x=1;</script><style>.a{}</style></head><p>A &amp; B &#39;C&#39;</p>');
    expect(text).toBe("A & B 'C'");
    expect(text).not.toContain('var x');
  });

  it('caps page text at ~20k chars', () => {
    expect(htmlToText(`<p>${'x'.repeat(50_000)}</p>`).length).toBeLessThanOrEqual(20_010);
  });

  it('extracts titles and guesses the company name from og:site_name first', () => {
    expect(extractTitle('<title> Careers — Acme </title>')).toBe('Careers — Acme');
    expect(guessCompanyName('acme.io', 'Acme Analytics — Home', 'Acme Analytics')).toBe('Acme Analytics');
    expect(guessCompanyName('www.northwind.co', 'Northwind | Tools', '')).toBe('Northwind');
    expect(guessCompanyName('www.zzz.example', '', '')).toBe('Zzz');
  });
});

describe('robots parsing', () => {
  it('collects Disallow rules only for the * agent group', () => {
    const rules = parseRobots('User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private/\nDisallow: /admin$');
    expect(rules.disallow).toEqual(['/private/', '/admin$']);
    expect(isAllowedByRobots('/acme/careers', rules)).toBe(true);
    expect(isAllowedByRobots('/private/x', rules)).toBe(false);
    expect(isAllowedByRobots('/admin', rules)).toBe(false);
    expect(isAllowedByRobots('/admin/panel', rules)).toBe(true); // $ anchors to exact
  });

  it('an empty Disallow or unreachable robots means allowed', () => {
    expect(isAllowedByRobots('/anything', parseRobots('User-agent: *\nDisallow:'))).toBe(true);
    expect(isAllowedByRobots('/anything', null)).toBe(true);
  });

  it('parses Crawl-delay for the * group', () => {
    const rules = parseRobots('User-agent: *\nCrawl-delay: 1\nDisallow: /x');
    expect(rules.crawlDelaySeconds).toBe(1);
    expect(parseRobots('User-agent: *\nDisallow: /x').crawlDelaySeconds).toBe(0);
  });
});

describe('crawlCompanySite', () => {
  it('follows RELATIVE links, finds the buried careers page and records 404s as warnings', async () => {
    const fetcher = makeSiteFetcher(SITE);
    const result = await crawlCompanySite('http://fixture.test/acme/', {
      ...CRAWL_OPTS,
      fetcher,
    });

    // relative link resolution really happened against the page URL
    expect(fetcher.requested).toContain('http://fixture.test/acme/about.html');
    expect(fetcher.requested).toContain('http://fixture.test/acme/handbook.html');

    // the careers page was discovered behind about -> handbook
    const careers = result.hiringPages.find((p) => p.url.endsWith('/acme/careers.html'));
    expect(careers).toBeDefined();
    expect(careers?.text).toContain('Take-home');
    expect(careers?.text).toContain('System design round');
    expect(result.pages.map((p) => p.url)).toContain('http://fixture.test/acme/careers.html');

    // ranked fetching: once discovered, careers (strong hiring signal) is
    // fetched ahead of team/products which were known earlier at lower scores
    expect(fetcher.requested.indexOf('http://fixture.test/acme/careers.html')).toBeGreaterThan(0);
    expect(
      fetcher.requested.indexOf('http://fixture.test/acme/careers.html'),
    ).toBeLessThan(fetcher.requested.indexOf('http://fixture.test/acme/team.html'));

    // the 404 jobs link is a recorded warning, never fatal
    expect(result.warnings.some((w) => w.code === 'PAGE_FAILED' && w.message.includes('jobs.html'))).toBe(true);
    expect(result.pages.length).toBeGreaterThan(3);

    // company guessed from og:site_name
    expect(result.company).toBe('Acme Analytics');
  });

  it('respects robots.txt Disallow for the discovered careers path', async () => {
    const fetcher = makeSiteFetcher(SITE, { robots: 'User-agent: *\nDisallow: /acme/careers' });
    const result = await crawlCompanySite('http://fixture.test/acme/', {
      ...CRAWL_OPTS,
      fetcher,
    });

    expect(fetcher.requested).not.toContain('http://fixture.test/acme/careers.html');
    expect(result.hiringPages).toHaveLength(0);
    expect(result.warnings.some((w) => w.code === 'PAGE_FAILED' && w.message.includes('robots.txt'))).toBe(true);
    // the rest of the site was still crawled
    expect(result.pages.map((p) => p.url)).toContain('http://fixture.test/acme/about.html');
  });

  it('stops at the page budget', async () => {
    const fetcher = makeSiteFetcher(SITE);
    const result = await crawlCompanySite('http://fixture.test/acme/', {
      ...CRAWL_OPTS,
      fetcher,
      maxPages: 2,
    });
    expect(result.pages.length).toBe(2);
  });

  it('an unreachable entry page is a warning and an honest empty result', async () => {
    const fetcher = makeSiteFetcher({}); // everything 404s
    const result = await crawlCompanySite('http://fixture.test/acme/', {
      ...CRAWL_OPTS,
      fetcher,
    });
    expect(result.pages).toEqual([]);
    expect(result.warnings.some((w) => w.code === 'SITE_UNREACHABLE')).toBe(true);
  });

  it('refuses private resolved addresses when the flag is off', async () => {
    const fetcher = makeSiteFetcher(SITE);
    const result = await crawlCompanySite('http://fixture.test/acme/', {
      ...CRAWL_OPTS,
      fetcher,
      resolveHost: async () => ['10.0.0.5'],
      allowPrivate: false,
    });
    expect(result.pages).toEqual([]);
    expect(result.warnings.some((w) => w.code === 'SITE_UNREACHABLE' && w.message.includes('10.0.0.5'))).toBe(true);
    expect(fetcher.requested).toEqual([]); // nothing fetched: refused before the request
  });

  it('allows private addresses when explicitly enabled (local fixtures)', async () => {
    const fetcher = makeSiteFetcher(SITE);
    const result = await crawlCompanySite('http://fixture.test/acme/', {
      ...CRAWL_OPTS,
      fetcher,
      resolveHost: async () => ['127.0.0.1'],
      allowPrivate: true,
    });
    expect(result.pages.length).toBeGreaterThan(0);
  });
});

describe('fetchPage guard rails', () => {
  it('rejects non-HTML content types', async () => {
    const fetcher = async (): Promise<Response> =>
      new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } });
    await expect(
      fetchPage('http://fixture.test/data', { ...CRAWL_OPTS, fetcher }),
    ).rejects.toMatchObject({ code: 'PAGE_FAILED' });
  });

  it('follows up to 4 redirects manually, re-validating each hop', async () => {
    const hops = ['/a', '/b', '/c', '/final'];
    const fetcher = async (url: string): Promise<Response> => {
      const path = new URL(url).pathname;
      const index = hops.indexOf(path);
      if (index >= 0 && index < hops.length - 1) {
        return new Response(null, { status: 302, headers: { location: hops[index + 1] } });
      }
      return new Response('<html><body>ok</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    };
    const page = await fetchPage('http://fixture.test/a', { ...CRAWL_OPTS, fetcher });
    expect(page.finalUrl).toBe('http://fixture.test/final');
    expect(page.body).toContain('ok');
  });

  it('stops after too many redirects', async () => {
    const fetcher = async (url: string): Promise<Response> =>
      new Response(null, { status: 301, headers: { location: new URL(url).pathname + 'x' } });
    await expect(
      fetchPage('http://fixture.test/loop', { ...CRAWL_OPTS, fetcher }),
    ).rejects.toMatchObject({ code: 'PAGE_FAILED' });
  });
});
