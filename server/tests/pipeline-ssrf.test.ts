import { describe, expect, it } from 'vitest';
import { PipelineError } from '../src/core/ports';
import {
  assertFetchableUrl,
  assertPublicHost,
  isPrivateAddress,
  offendingAddress,
} from '../src/services/crawl';

describe('SSRF guard (pure, offline)', () => {
  it('recognises loopback, private, link-local and CGNAT IPv4 ranges', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('127.8.8.8')).toBe(true); // whole 127/8 is loopback
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('192.168.0.5')).toBe(true);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('172.31.255.255')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true); // cloud metadata
    expect(isPrivateAddress('0.0.0.0')).toBe(true);
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
  });

  it('allows public IPv4', () => {
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('172.32.0.1')).toBe(false); // just outside 172.16/12
  });

  it('recognises IPv6 loopback, link-local, unique-local and v4-mapped', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('::')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('fc00::abcd')).toBe(true);
    expect(isPrivateAddress('fd12:3456::1')).toBe(true);
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
  });

  it('offendingAddress refuses private IPs when the flag is off and allows them when on', () => {
    expect(offendingAddress(['93.184.216.34'], false)).toBeNull();
    expect(offendingAddress(['93.184.216.34', '127.0.0.1'], false)).toBe('127.0.0.1');
    expect(offendingAddress(['10.0.0.1'], false)).toBe('10.0.0.1');
    // the documented local-fixture escape hatch
    expect(offendingAddress(['10.0.0.1'], true)).toBeNull();
    expect(offendingAddress(['127.0.0.1'], true)).toBeNull();
  });

  it('assertFetchableUrl accepts only well-formed http/https URLs', () => {
    expect(assertFetchableUrl('https://example.com/path?q=1').hostname).toBe('example.com');
    expect(assertFetchableUrl('http://localhost:8099/acme/').port).toBe('8099');
    for (const bad of ['ftp://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url', 'http://']) {
      expect(() => assertFetchableUrl(bad)).toThrowError(PipelineError);
      try {
        assertFetchableUrl(bad);
      } catch (err) {
        expect((err as PipelineError).code).toBe('URL_INVALID');
      }
    }
  });

  it('assertPublicHost rejects resolved private addresses unless explicitly allowed', async () => {
    const resolvesPrivate = async (): Promise<string[]> => ['93.184.216.34', '10.0.0.7'];
    await expect(assertPublicHost('evil.example', { resolveHost: resolvesPrivate, allowPrivate: false })).rejects.toMatchObject({
      code: 'SITE_UNREACHABLE',
    });
    await expect(
      assertPublicHost('fixture.test', { resolveHost: resolvesPrivate, allowPrivate: true }),
    ).resolves.toBeUndefined();

    const resolvesLoopback = async (): Promise<string[]> => ['::1'];
    await expect(
      assertPublicHost('localhost', { resolveHost: resolvesLoopback, allowPrivate: false }),
    ).rejects.toMatchObject({ code: 'SITE_UNREACHABLE' });
  });

  it('assertPublicHost reports DNS failure as SITE_UNREACHABLE, not a crash', async () => {
    const fails: () => Promise<string[]> = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(assertPublicHost('nope.test', { resolveHost: fails })).rejects.toMatchObject({
      code: 'SITE_UNREACHABLE',
    });
  });
});
