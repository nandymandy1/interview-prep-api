import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { RequestContextService } from '@/common/context/request-context.service';
import { createBaseLogger, LoggerService } from '@/infrastructure/logger/logger.service';
import {
  MAX_RETRIEVAL_BYTES,
  RETRIEVAL_MAX_ATTEMPTS,
  RETRIEVAL_MAX_REDIRECTS,
  RETRIEVAL_TOTAL_TIMEOUT_MS,
} from '@/modules/research/retrieval/retrieval.constants';
import {
  computeRetryDelayMs,
  createRetrievalAxiosInstance,
  parseRetryAfterMs,
  RetrievalClient,
  type HttpGetter,
  type RetrievalHttpResponse,
} from '@/modules/research/retrieval/retrieval-client.service';
import {
  RedirectBlockedError,
  RetrievalException,
} from '@/modules/research/retrieval/retrieval.exception';
import { toRetrievalFailure } from '@/modules/research/retrieval/retrieval.failure';
import type { RetrievalFailureCode } from '@/modules/research/retrieval/retrieval.type';
import {
  isBlockedIpAddress,
  SafeDnsError,
  sanitizeUrlForLogging,
  UrlSafetyService,
  type DnsResolver,
} from '@/modules/research/retrieval/url-safety.service';

const PUBLIC_IPV4 = '93.184.216.34';
const PUBLIC_IPV6 = '2001:4860:4860::8888';

const makeLogger = (): LoggerService =>
  new LoggerService({
    baseLogger: createBaseLogger('silent'),
    requestContext: new RequestContextService(),
  });

const mockDns = (records: Record<string, string[]>, calls: string[] = []): DnsResolver => {
  const resolver: DnsResolver = async (hostname: string) => {
    calls.push(hostname);
    return [...(records[hostname] ?? [])];
  };
  return resolver;
};

const throwingDns = (): DnsResolver => {
  const resolver: DnsResolver = async () => {
    throw new Error('DNS must not be consulted for IP literals');
  };
  return resolver;
};

const okResponse = (overrides: Partial<RetrievalHttpResponse> = {}): RetrievalHttpResponse => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: '<html><body>Acme</body></html>',
  ...overrides,
});

const redirectResponse = (location: string): RetrievalHttpResponse => ({
  status: 302,
  headers: { location },
  body: '',
});

const networkError = (code = 'ECONNRESET'): Error => Object.assign(new Error(code), { code });

const axiosTimeoutError = (): Error =>
  Object.assign(new Error('timeout of 8000ms exceeded'), {
    code: 'ECONNABORTED',
    isAxiosError: true,
  });

const scriptHttp = (steps: Array<RetrievalHttpResponse | Error>, seen: string[]): HttpGetter => {
  const remaining = [...steps];
  return async (url: string) => {
    seen.push(url);
    const step = remaining.shift();

    if (!step) {
      throw new Error('http script exhausted');
    }

    if (step instanceof Error) {
      throw step;
    }

    return step;
  };
};

const makeClient = (options: {
  dns?: DnsResolver;
  http?: HttpGetter;
  sleeps?: number[];
  randomValue?: number;
  timeoutMs?: number;
  now?: () => number;
  advanceOnSleep?: (ms: number) => void;
}): RetrievalClient =>
  new RetrievalClient({
    urlSafety: new UrlSafetyService({ dnsResolver: options.dns ?? mockDns({}) }),
    logger: makeLogger(),
    ...(options.http ? { httpGet: options.http } : {}),
    sleep: async (ms: number) => {
      options.sleeps?.push(ms);
      options.advanceOnSleep?.(ms);
    },
    random: () => options.randomValue ?? 0,
    ...(options.now ? { now: options.now } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });

const productionDns = (calls: string[] = []): DnsResolver =>
  mockDns(
    {
      'public.example': [PUBLIC_IPV4],
      'cdn.example': [PUBLIC_IPV4],
      'v6.example': [PUBLIC_IPV6],
      'private.example': ['10.0.0.9'],
      'multi.example': [PUBLIC_IPV4, '10.0.0.5'],
      localhost: ['127.0.0.1'],
    },
    calls,
  );

const productionSafety = (calls: string[] = []): UrlSafetyService =>
  new UrlSafetyService({ dnsResolver: productionDns(calls) });

const expectRejectCode = async (
  promise: Promise<unknown>,
  code: RetrievalFailureCode,
): Promise<RetrievalException> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RetrievalException);
    expect((error as RetrievalException).code).toBe(code);
    return error as RetrievalException;
  }

  throw new Error(`Expected rejection with ${code}`);
};

describe('URL parsing and normalization', () => {
  it('1. accepts a valid https URL', async () => {
    const parsed = await productionSafety().validateUrl('https://public.example/', 'production');
    expect(parsed.protocol).toBe('https:');
    expect(parsed.hostname).toBe('public.example');
  });

  it('2. accepts a valid http URL', async () => {
    const parsed = await productionSafety().validateUrl('http://public.example/', 'production');
    expect(parsed.protocol).toBe('http:');
  });

  it('3. rejects a malformed URL', async () => {
    await expectRejectCode(
      productionSafety().validateUrl('not a url', 'production'),
      'INVALID_URL',
    );
  });

  it('4. rejects ftp protocol', async () => {
    await expectRejectCode(
      productionSafety().validateUrl('ftp://public.example/file', 'production'),
      'UNSUPPORTED_PROTOCOL',
    );
  });

  it('5. rejects file protocol', async () => {
    await expectRejectCode(
      productionSafety().validateUrl('file:///etc/passwd', 'production'),
      'UNSUPPORTED_PROTOCOL',
    );
  });

  it('6. rejects data URLs', async () => {
    await expectRejectCode(
      productionSafety().validateUrl('data:text/html,<h1>x</h1>', 'production'),
      'UNSUPPORTED_PROTOCOL',
    );
  });

  it('7. rejects embedded credentials', async () => {
    await expectRejectCode(
      productionSafety().validateUrl('http://user:password@public.example/', 'production'),
      'INVALID_URL',
    );
  });

  it('8. strips the fragment before retrieval', () => {
    const safety = new UrlSafetyService({ dnsResolver: mockDns({}) });
    expect(safety.normalizeUrl('https://public.example/page#section').toString()).toBe(
      'https://public.example/page',
    );
  });
});

describe('production SSRF policy', () => {
  it.each([
    ['9. localhost hostname', 'http://localhost/'],
    ['10. 127.0.0.1', 'http://127.0.0.1/'],
    ['11. 127.0.0.53 (/8)', 'http://127.0.0.53/'],
    ['12. 10.x RFC1918', 'http://10.1.2.3/'],
    ['13a. 172.16.0.1', 'http://172.16.0.1/'],
    ['13b. 172.31.255.255', 'http://172.31.255.255/'],
    ['14. 192.168.x', 'http://192.168.0.23/'],
    ['15. 169.254.x link-local', 'http://169.254.169.254/'],
    ['16. 0.0.0.0 unspecified', 'http://0.0.0.0/'],
    ['17. ::1 loopback', 'http://[::1]/'],
    ['18a. fc00::/7 unique-local', 'http://[fc00::1]/'],
    ['18b. fd00::/7 unique-local', 'http://[fd12:3456::1]/'],
    ['19. fe80::/10 link-local', 'http://[fe80::1]/'],
    ['mapped v4 private', 'http://[::ffff:192.168.0.1]/'],
    ['mapped v4 loopback', 'http://[::ffff:127.0.0.1]/'],
    ['multicast v4', 'http://224.0.0.1/'],
    ['broadcast', 'http://255.255.255.255/'],
  ])('%s is blocked', async (_label, url) => {
    const dnsCalls: string[] = [];
    const safety = new UrlSafetyService({ dnsResolver: productionDns(dnsCalls) });
    await expectRejectCode(safety.validateUrl(url, 'production'), 'BLOCKED_ADDRESS');

    if (url.startsWith('http://localhost')) {
      expect(dnsCalls).toContain('localhost');
    }
  });

  it('10b. IP literals never consult DNS', async () => {
    const safety = new UrlSafetyService({ dnsResolver: throwingDns() });
    await expectRejectCode(
      safety.validateUrl('http://127.0.0.1/', 'production'),
      'BLOCKED_ADDRESS',
    );
  });

  it('13c. 172.15/172.32 boundary addresses stay public', () => {
    expect(isBlockedIpAddress('172.15.255.255')).toBe(false);
    expect(isBlockedIpAddress('172.32.0.1')).toBe(false);
  });

  it('20. public IPv4 is accepted', async () => {
    const dnsCalls: string[] = [];
    const safety = new UrlSafetyService({ dnsResolver: productionDns(dnsCalls) });
    const literal = await safety.validateUrl(`http://${PUBLIC_IPV4}/`, 'production');
    expect(literal.hostname).toBe(PUBLIC_IPV4);
    const named = await safety.validateUrl('https://public.example/', 'production');
    expect(named.hostname).toBe('public.example');
  });

  it('21. public IPv6 is accepted', async () => {
    const safety = new UrlSafetyService({ dnsResolver: productionDns() });
    const literal = await safety.validateUrl(`http://[${PUBLIC_IPV6}]/`, 'production');
    expect(literal.hostname).toBe(`[${PUBLIC_IPV6}]`);
    const named = await safety.validateUrl('https://v6.example/', 'production');
    expect(named.hostname).toBe('v6.example');
  });
});

describe('evaluation mode compatibility', () => {
  const evaluationSafety = (): UrlSafetyService =>
    new UrlSafetyService({ dnsResolver: mockDns({ localhost: ['127.0.0.1'] }) });

  it('22. localhost is allowed in evaluation mode', async () => {
    const dnsCalls: string[] = [];
    const safety = new UrlSafetyService({
      dnsResolver: mockDns({ localhost: ['127.0.0.1'] }, dnsCalls),
    });
    const parsed = await safety.validateUrl('http://localhost:8099/acme/', 'evaluation');
    expect(parsed.hostname).toBe('localhost');
    expect(dnsCalls).toContain('localhost');
  });

  it('23. 127.0.0.1 is allowed in evaluation mode', async () => {
    const parsed = await evaluationSafety().validateUrl(
      'http://127.0.0.1:8099/acme/',
      'evaluation',
    );
    expect(parsed.hostname).toBe('127.0.0.1');
  });

  it('24. private RFC1918 evaluator URLs retrieve successfully', async () => {
    const seen: string[] = [];
    const client = makeClient({
      dns: throwingDns(),
      http: scriptHttp([okResponse()], seen),
    });
    const result = await client.retrieve({
      url: 'http://192.168.1.10:3000/acme/',
      mode: 'evaluation',
    });

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.resource.finalUrl).toBe('http://192.168.1.10:3000/acme/');
    }

    expect(seen).toEqual(['http://192.168.1.10:3000/acme/']);
  });

  it('25. unsupported protocol is still rejected in evaluation mode', async () => {
    await expectRejectCode(
      evaluationSafety().validateUrl('ftp://localhost/file', 'evaluation'),
      'UNSUPPORTED_PROTOCOL',
    );
  });

  it('26. URL credentials are still rejected in evaluation mode', async () => {
    await expectRejectCode(
      evaluationSafety().validateUrl('http://user:pass@localhost/', 'evaluation'),
      'INVALID_URL',
    );
  });

  it('27. response-size limits remain active in evaluation mode', async () => {
    const seen: string[] = [];
    const client = makeClient({
      dns: throwingDns(),
      http: scriptHttp([okResponse({ body: 'a'.repeat(MAX_RETRIEVAL_BYTES + 1) })], seen),
    });
    const result = await client.retrieve({
      url: 'http://127.0.0.1:8099/acme/',
      mode: 'evaluation',
    });

    expect(result).toEqual({
      ok: false,
      failure: {
        code: 'RESPONSE_TOO_LARGE',
        url: 'http://127.0.0.1:8099/acme/',
        message: 'The response exceeded the maximum allowed size.',
      },
    });
  });
});

describe('P2.1 hardening', () => {
  it('Axios implicit environment proxying is disabled', () => {
    const instance = createRetrievalAxiosInstance(8000);
    expect(instance.defaults.proxy).toBe(false);
    expect(instance.defaults.maxRedirects).toBe(0);
  });

  it('evaluation mode still resolves DNS and reports unknown hosts', async () => {
    const safety = new UrlSafetyService({ dnsResolver: mockDns({}) });
    const error = await expectRejectCode(
      safety.validateUrl('http://nonexistent.example/', 'evaluation'),
      'DNS_RESOLUTION_FAILED',
    );
    expect(error.url).toBe('http://nonexistent.example/');
  });

  it('blocked literals keep the full URL for provenance', async () => {
    const error = await expectRejectCode(
      productionSafety().validateUrl('http://127.0.0.1/private-page', 'production'),
      'BLOCKED_ADDRESS',
    );
    expect(error.url).toBe('http://127.0.0.1/private-page');
  });

  it('connection-time lookup hands the vetted address to the socket', async () => {
    const safety = new UrlSafetyService({ dnsResolver: productionDns() });
    const lookup = safety.createConnectionLookup('production', 'http://public.example/');

    const { address, family } = await new Promise<{ address: string; family?: number }>(
      (resolve, reject) => {
        lookup('public.example', {}, (error, result, resultFamily) => {
          if (error) {
            reject(error);
            return;
          }

          resolve({ address: result as string, family: resultFamily });
        });
      },
    );

    expect(address).toBe(PUBLIC_IPV4);
    expect(family).toBe(4);
  });

  it('connection-time lookup rejects blocked addresses with full target provenance', async () => {
    const safety = new UrlSafetyService({ dnsResolver: productionDns() });
    const lookup = safety.createConnectionLookup('production', 'http://private.example/secret');

    const error = await new Promise<SafeDnsError | null>((resolve) => {
      lookup('private.example', {}, (lookupError) => {
        resolve(lookupError instanceof SafeDnsError ? lookupError : null);
      });
    });

    expect(error).toBeInstanceOf(SafeDnsError);
    expect(error?.reason).toBe('blocked');
    expect(error?.targetUrl).toBe('http://private.example/secret');
  });

  it('connection-time lookup reports unresolvable hosts with full target provenance', async () => {
    const safety = new UrlSafetyService({ dnsResolver: mockDns({}) });
    const lookup = safety.createConnectionLookup('evaluation', 'http://ghost.example/');

    const error = await new Promise<SafeDnsError | null>((resolve) => {
      lookup('ghost.example', {}, (lookupError) => {
        resolve(lookupError instanceof SafeDnsError ? lookupError : null);
      });
    });

    expect(error?.reason).toBe('unresolved');
    expect(error?.targetUrl).toBe('http://ghost.example/');
  });

  it('rebinding between validation and connect is blocked before any socket opens', async () => {
    let hits = 0;
    const server = createServer((_, response) => {
      hits += 1;
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html/>');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    try {
      if (typeof address !== 'object' || address === null) {
        throw new Error('rebind server did not bind');
      }

      const answers: string[][] = [[PUBLIC_IPV4], [PUBLIC_IPV4], ['127.0.0.1']];
      const resolver: DnsResolver = async () => answers.shift() ?? [PUBLIC_IPV4];
      const client = new RetrievalClient({
        urlSafety: new UrlSafetyService({ dnsResolver: resolver }),
        logger: makeLogger(),
        sleep: async () => {},
        random: () => 0,
      });
      const target = `http://localhost:${address.port}/`;
      const result = await client.retrieve({ url: target, mode: 'production' });

      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.failure.code).toBe('BLOCKED_ADDRESS');
        expect(result.failure.url).toBe(target);
      }

      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it('evaluation localhost connects through the controlled lookup', async () => {
    let hits = 0;
    const seenHosts: string[] = [];
    const server = createServer((_, response) => {
      hits += 1;
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html>eval</html>');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();

    try {
      if (typeof address !== 'object' || address === null) {
        throw new Error('eval server did not bind');
      }

      const client = new RetrievalClient({
        urlSafety: new UrlSafetyService({
          dnsResolver: mockDns({ localhost: ['127.0.0.1'] }, seenHosts),
        }),
        logger: makeLogger(),
        sleep: async () => {},
        random: () => 0,
      });
      const result = await client.retrieve({
        url: `http://localhost:${address.port}/`,
        mode: 'evaluation',
      });

      expect(result.ok).toBe(true);
      expect(hits).toBe(1);
      expect(seenHosts).toContain('localhost');
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it('slow redirect chains cannot exceed the total logical budget', async () => {
    let now = 0;
    const seen: string[] = [];
    const advancingHttp: HttpGetter = async (url: string) => {
      seen.push(url);
      now += 6000;
      return redirectResponse('http://public.example/next');
    };
    const client = makeClient({
      dns: productionDns(),
      http: advancingHttp,
      sleeps: [],
      now: () => now,
      advanceOnSleep: (ms) => {
        now += ms;
      },
    });
    const result = await client.retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('TIMEOUT');
      expect(result.failure.url).toBe('http://public.example/next');
    }

    expect(seen).toHaveLength(3);
  });

  it('retries cannot exceed the total logical budget', async () => {
    let now = 0;
    const seen: string[] = [];
    const sleeps: number[] = [];
    const slowFailingHttp: HttpGetter = async (url: string) => {
      seen.push(url);
      now += 6000;
      return { ...okResponse(), status: 500 };
    };
    const client = makeClient({
      dns: productionDns(),
      http: slowFailingHttp,
      sleeps,
      now: () => now,
      advanceOnSleep: (ms) => {
        now += ms;
      },
    });
    const result = await client.retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('TIMEOUT');
    }

    expect(seen).toHaveLength(3);
    expect(sleeps).toEqual([250, 500]);
  });

  it('Retry-After waits cannot push a retrieval beyond the total deadline', async () => {
    let now = 0;
    const seen: string[] = [];
    const sleeps: number[] = [];
    const slowLimitedHttp: HttpGetter = async (url: string) => {
      seen.push(url);
      now += 6000;
      return { ...okResponse(), status: 429, headers: { 'retry-after': '3600' } };
    };
    const client = makeClient({
      dns: productionDns(),
      http: slowLimitedHttp,
      sleeps,
      now: () => now,
      advanceOnSleep: (ms) => {
        now += ms;
      },
    });
    const result = await client.retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('TIMEOUT');
    }

    expect(seen).toHaveLength(2);
    expect(sleeps).toEqual([5000]);
  });

  it('total budget matches the documented constant', () => {
    expect(RETRIEVAL_TOTAL_TIMEOUT_MS).toBe(15_000);
  });
});

describe('log URL redaction', () => {
  it.each([
    ['query stripped', 'https://company.com/page?token=abc', 'https://company.com/page'],
    [
      'query and fragment stripped',
      'https://company.com/page?token=abc#foo',
      'https://company.com/page',
    ],
    ['credentials stripped', 'https://user:pass@company.com/page', 'https://company.com/page'],
    ['port and path preserved', 'http://localhost:8099/acme/?x=1', 'http://localhost:8099/acme/'],
    ['bare host kept', 'https://company.com/', 'https://company.com/'],
    ['unparseable input guarded', 'not a url', '[unparseable-url]'],
  ])('%s', (_label, raw, expected) => {
    expect(sanitizeUrlForLogging(raw)).toBe(expected);
  });
});

describe('DNS and redirect safety', () => {
  it('28. hostname resolving to a private IP is rejected without fetching', async () => {
    const seen: string[] = [];
    const client = makeClient({ dns: productionDns(), http: scriptHttp([okResponse()], seen) });
    const result = await client.retrieve({ url: 'http://private.example/', mode: 'production' });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('BLOCKED_ADDRESS');
      expect(result.failure.url).toBe('http://private.example/');
    }

    expect(seen).toEqual([]);
  });

  it('29. mixed public/private resolutions are rejected conservatively', async () => {
    const seen: string[] = [];
    const client = makeClient({ dns: productionDns(), http: scriptHttp([okResponse()], seen) });
    const result = await client.retrieve({ url: 'http://multi.example/', mode: 'production' });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('BLOCKED_ADDRESS');
      expect(result.failure.url).toBe('http://multi.example/');
    }

    expect(seen).toEqual([]);
  });

  it('30. public URL redirecting to localhost is rejected', async () => {
    const seen: string[] = [];
    const client = makeClient({
      dns: productionDns(),
      http: scriptHttp([redirectResponse('http://127.0.0.1/admin'), okResponse()], seen),
    });
    const result = await client.retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('BLOCKED_ADDRESS');
      expect(result.failure.url).toBe('http://127.0.0.1/admin');
    }

    expect(seen).toEqual(['http://public.example/']);
  });

  it('31. public to RFC1918 redirect is rejected', async () => {
    const seen: string[] = [];
    const client = makeClient({
      dns: productionDns(),
      http: scriptHttp([redirectResponse('http://192.168.0.5/'), okResponse()], seen),
    });
    const result = await client.retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('BLOCKED_ADDRESS');
    }
  });

  it('32. redirect to an unsupported protocol is rejected', async () => {
    const seen: string[] = [];
    const client = makeClient({
      dns: productionDns(),
      http: scriptHttp([redirectResponse('ftp://public.example/file')], seen),
    });
    const result = await client.retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('UNSUPPORTED_PROTOCOL');
    }
  });

  it('33. redirect count limit is enforced', async () => {
    const seen: string[] = [];
    const chain = Array.from({ length: RETRIEVAL_MAX_REDIRECTS + 1 }, (_, index) =>
      redirectResponse(`http://public.example/r${index + 1}`),
    );
    const client = makeClient({ dns: productionDns(), http: scriptHttp(chain, seen) });
    const result = await client.retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('TOO_MANY_REDIRECTS');
    }

    expect(seen).toHaveLength(RETRIEVAL_MAX_REDIRECTS + 1);
  });

  it('34. safe public redirect succeeds with finalUrl tracked', async () => {
    const seen: string[] = [];
    const client = makeClient({
      dns: productionDns(),
      http: scriptHttp(
        [redirectResponse('https://cdn.example/page'), okResponse({ status: 200 })],
        seen,
      ),
    });
    const result = await client.retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.resource.requestedUrl).toBe('http://public.example/');
      expect(result.resource.finalUrl).toBe('https://cdn.example/page');
      expect(result.resource.status).toBe(200);
    }

    expect(seen).toEqual(['http://public.example/', 'https://cdn.example/page']);
  });
});

describe('retry policy', () => {
  const productionClient = (
    steps: Array<RetrievalHttpResponse | Error>,
    seen: string[],
    sleeps: number[] = [],
  ): RetrievalClient => makeClient({ dns: productionDns(), http: scriptHttp(steps, seen), sleeps });

  it('35. 429 retries', async () => {
    const seen: string[] = [];
    const result = await productionClient(
      [{ ...okResponse(), status: 429 }, okResponse()],
      seen,
    ).retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it('36. 503 retries', async () => {
    const seen: string[] = [];
    const result = await productionClient(
      [{ ...okResponse(), status: 503 }, okResponse()],
      seen,
    ).retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it('37. 500 retries per policy', async () => {
    const seen: string[] = [];
    const result = await productionClient(
      [{ ...okResponse(), status: 500 }, okResponse()],
      seen,
    ).retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it('38. 404 does NOT retry', async () => {
    const seen: string[] = [];
    const result = await productionClient(
      [{ ...okResponse(), status: 404 }, okResponse()],
      seen,
    ).retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('HTTP_ERROR');
      expect(result.failure.status).toBe(404);
    }

    expect(seen).toHaveLength(1);
  });

  it('39. blocked address does NOT retry', async () => {
    const seen: string[] = [];
    const sleeps: number[] = [];
    const result = await productionClient([], seen, sleeps).retrieve({
      url: 'http://10.9.9.9/',
      mode: 'production',
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('BLOCKED_ADDRESS');
    }

    expect(seen).toEqual([]);
    expect(sleeps).toEqual([]);
  });

  it('40. invalid URL does NOT retry', async () => {
    const seen: string[] = [];
    const sleeps: number[] = [];
    const result = await productionClient([], seen, sleeps).retrieve({
      url: 'not a url',
      mode: 'production',
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('INVALID_URL');
    }

    expect(seen).toEqual([]);
    expect(sleeps).toEqual([]);
  });

  it('41. max attempts are enforced', async () => {
    const seen: string[] = [];
    const result = await productionClient(
      [
        { ...okResponse(), status: 500 },
        { ...okResponse(), status: 502 },
        { ...okResponse(), status: 503 },
        okResponse(),
      ],
      seen,
    ).retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('HTTP_ERROR');
      expect(result.failure.status).toBe(503);
    }

    expect(seen).toHaveLength(RETRIEVAL_MAX_ATTEMPTS);
  });

  it('42. exponential delay increases', () => {
    expect(computeRetryDelayMs(0, 0)).toBe(250);
    expect(computeRetryDelayMs(1, 0)).toBe(500);
    expect(computeRetryDelayMs(2, 0)).toBe(1000);
    expect(computeRetryDelayMs(10, 0)).toBe(2000);
  });

  it('43. jitter stays within expected bound', () => {
    expect(computeRetryDelayMs(0, 0)).toBe(250);
    expect(computeRetryDelayMs(0, 0.5)).toBe(300);
    expect(computeRetryDelayMs(0, 0.999999)).toBe(349);

    for (const randomValue of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const delay = computeRetryDelayMs(1, randomValue);
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThan(600);
    }
  });

  it('44. Retry-After seconds are respected within the cap', async () => {
    const seen: string[] = [];
    const sleeps: number[] = [];
    const result = await productionClient(
      [{ ...okResponse(), status: 429, headers: { 'retry-after': '2' } }, okResponse()],
      seen,
      sleeps,
    ).retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([2000]);
  });

  it('45. oversized Retry-After is capped', async () => {
    const seen: string[] = [];
    const sleeps: number[] = [];
    const result = await productionClient(
      [{ ...okResponse(), status: 503, headers: { 'retry-after': '3600' } }, okResponse()],
      seen,
      sleeps,
    ).retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([5000]);
  });

  it('46. eventual success after a transient failure returns success', async () => {
    const seen: string[] = [];
    const result = await productionClient(
      [networkError('ECONNRESET'), okResponse()],
      seen,
    ).retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.resource.status).toBe(200);
    }

    expect(seen).toHaveLength(2);
  });

  it('47. all attempts failing returns a structured failure', async () => {
    const seen: string[] = [];
    const result = await productionClient(
      [
        { ...okResponse(), status: 500 },
        { ...okResponse(), status: 502 },
        { ...okResponse(), status: 500 },
      ],
      seen,
    ).retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result).toEqual({
      ok: false,
      failure: {
        code: 'HTTP_ERROR',
        url: 'http://public.example/',
        status: 500,
        message: 'The remote server returned an error.',
      },
    });
    expect(seen).toHaveLength(3);
  });

  it('axios timeout errors map to TIMEOUT and retry', async () => {
    const seen: string[] = [];
    const result = await productionClient([axiosTimeoutError(), okResponse()], seen).retrieve({
      url: 'http://public.example/',
      mode: 'production',
    });

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(2);
  });
});

describe('Retry-After parsing', () => {
  it('supports integer seconds, HTTP dates, and rejects garbage', () => {
    const nowMs = Date.parse('2026-09-08T00:00:00.000Z');
    expect(parseRetryAfterMs(undefined, nowMs)).toBeNull();
    expect(parseRetryAfterMs('2', nowMs)).toBe(2000);
    expect(parseRetryAfterMs('3600', nowMs)).toBe(5000);
    expect(parseRetryAfterMs('not-a-date', nowMs)).toBeNull();
    expect(parseRetryAfterMs(new Date(nowMs + 3000).toUTCString(), nowMs)).toBe(3000);
    expect(parseRetryAfterMs(new Date(nowMs - 60000).toUTCString(), nowMs)).toBe(0);
  });
});

describe('injected clock consistency', () => {
  it('A3. preflight DNS consumes the logical deadline: slow DNS times out before any HTTP attempt', async () => {
    let now = 0;
    const seen: string[] = [];
    const slowDns: DnsResolver = async () => {
      now += 20_000;
      return [PUBLIC_IPV4];
    };
    const client = makeClient({
      dns: slowDns,
      http: scriptHttp([okResponse()], seen),
      now: () => now,
    });
    const result = await client.retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('TIMEOUT');
      expect(result.failure.url).toBe('http://public.example/');
    }

    expect(seen).toEqual([]);
  });

  it('A10. Retry-After HTTP dates use the injected clock, not wall time', async () => {
    const fixedNow = 1_000_000;
    const seen: string[] = [];
    const sleeps: number[] = [];
    const client = makeClient({
      dns: productionDns(),
      http: scriptHttp(
        [
          {
            ...okResponse(),
            status: 429,
            headers: { 'retry-after': new Date(fixedNow + 3000).toUTCString() },
          },
          okResponse(),
        ],
        seen,
      ),
      sleeps,
      now: () => fixedNow,
    });
    const result = await client.retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
  });
});

describe('response bounds', () => {
  const boundedClient = (response: RetrievalHttpResponse): RetrievalClient =>
    makeClient({ dns: productionDns(), http: scriptHttp([response], []) });

  it.each([
    ['48. text/html', 'text/html'],
    ['49. text/html with charset', 'text/html; charset=utf-8'],
    ['50. text/plain', 'text/plain; charset=utf-8'],
    ['51. application/xhtml+xml', 'application/xhtml+xml; charset=utf-8'],
  ])('%s is accepted', async (_label, contentType) => {
    const client = boundedClient(okResponse({ headers: { 'content-type': contentType } }));
    const result = await client.retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.resource.contentType).toBe(contentType.split(';')[0]);
    }
  });

  it.each([
    ['52. image/png', 'image/png'],
    ['53. application/pdf', 'application/pdf'],
    ['54. application/octet-stream', 'application/octet-stream'],
  ])('%s is rejected', async (_label, contentType) => {
    const client = boundedClient(okResponse({ headers: { 'content-type': contentType } }));
    const result = await client.retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('UNSUPPORTED_CONTENT_TYPE');
    }
  });

  it('missing content type is rejected conservatively', async () => {
    const client = boundedClient(okResponse({ headers: {} }));
    const result = await client.retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('UNSUPPORTED_CONTENT_TYPE');
    }
  });

  it('55. oversized body is rejected', async () => {
    const client = boundedClient(okResponse({ body: 'a'.repeat(MAX_RETRIEVAL_BYTES + 1) }));
    const result = await client.retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('RESPONSE_TOO_LARGE');
    }
  });

  it('56. normal bounded body succeeds', async () => {
    const client = boundedClient(okResponse({ body: '<html>bounded</html>' }));
    const result = await client.retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(true);
  });

  it('57. body bytes are reported correctly', async () => {
    const client = boundedClient(okResponse({ body: 'héllo' }));
    const result = await client.retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.resource.bytes).toBe(Buffer.byteLength('héllo', 'utf8'));
      expect(result.resource.body).toBe('héllo');
    }
  });
});

describe('failure surfacing', () => {
  it('public failure text never leaks upstream details', async () => {
    const seen: string[] = [];
    const client = makeClient({
      dns: productionDns(),
      http: scriptHttp(
        [
          { ...okResponse(), status: 429 },
          { ...okResponse(), status: 429 },
          { ...okResponse(), status: 429 },
        ],
        seen,
      ),
    });
    const result = await client.retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('RATE_LIMITED');
      expect(result.failure.message).toBe('The remote server rate-limited the request.');
    }
  });

  it('every failure code maps to a fixed safe message', () => {
    const codes: RetrievalFailureCode[] = [
      'INVALID_URL',
      'UNSUPPORTED_PROTOCOL',
      'BLOCKED_ADDRESS',
      'DNS_RESOLUTION_FAILED',
      'TIMEOUT',
      'TOO_MANY_REDIRECTS',
      'UNSUPPORTED_CONTENT_TYPE',
      'RESPONSE_TOO_LARGE',
      'HTTP_ERROR',
      'NETWORK_ERROR',
      'RATE_LIMITED',
    ];

    for (const code of codes) {
      const failure = toRetrievalFailure(
        new RetrievalException(code, 'upstream says something secret', { url: 'http://x/' }),
      );

      expect(failure.code).toBe(code);
      expect(failure.message).not.toContain('upstream says something secret');
      expect(failure.message.length).toBeGreaterThan(0);
    }
  });
});

describe('local HTTP integration (evaluation mode)', () => {
  let server: Server | null = null;
  let baseUrl = '';
  let handler:
    ((url: string) => { status: number; headers: Record<string, string>; body: string }) | null =
    null;
  let requestCount = 0;

  const startServer = async (): Promise<void> => {
    requestCount = 0;
    server = createServer((request, response) => {
      requestCount += 1;
      const current = handler;

      if (!current) {
        response.writeHead(500).end();
        return;
      }

      const { status, headers, body } = current(request.url ?? '/');

      if (request.url === '/hang') {
        return;
      }

      response.writeHead(status, headers);
      response.end(body);
    });

    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server?.address();

    if (typeof address !== 'object' || address === null) {
      throw new Error('integration server did not bind');
    }

    baseUrl = `http://127.0.0.1:${address.port}`;
  };

  const stopServer = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }

      server.close(() => resolve());
    });
    server = null;
  };

  const integrationClient = (timeoutMs = 2000): RetrievalClient =>
    new RetrievalClient({
      urlSafety: new UrlSafetyService({ dnsResolver: throwingDns() }),
      logger: makeLogger(),
      sleep: async () => {},
      random: () => 0,
      timeoutMs,
    });

  it('serves HTML success end to end', async () => {
    await startServer();

    try {
      handler = () => ({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<html>local acme</html>',
      });
      const result = await integrationClient().retrieve({ url: `${baseUrl}/`, mode: 'evaluation' });

      expect(result.ok).toBe(true);

      if (result.ok) {
        expect(result.resource.body).toBe('<html>local acme</html>');
        expect(result.resource.contentType).toBe('text/html');
      }
    } finally {
      await stopServer();
    }
  });

  it('follows relative redirects end to end', async () => {
    await startServer();

    try {
      handler = (url: string): { status: number; headers: Record<string, string>; body: string } =>
        url === '/final'
          ? { status: 200, headers: { 'content-type': 'text/plain' }, body: 'arrived' }
          : { status: 302, headers: { location: '/final' }, body: '' };
      const result = await integrationClient().retrieve({
        url: `${baseUrl}/start`,
        mode: 'evaluation',
      });

      expect(result.ok).toBe(true);

      if (result.ok) {
        expect(result.resource.finalUrl).toBe(`${baseUrl}/final`);
        expect(result.resource.body).toBe('arrived');
      }
    } finally {
      await stopServer();
    }
  });

  it('recovers after a 429 then success', async () => {
    await startServer();

    try {
      handler = (): { status: number; headers: Record<string, string>; body: string } =>
        requestCount === 1
          ? { status: 429, headers: { 'retry-after': '0' }, body: 'slow down' }
          : { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>ok</html>' };
      const result = await integrationClient().retrieve({ url: `${baseUrl}/`, mode: 'evaluation' });

      expect(result.ok).toBe(true);
      expect(requestCount).toBe(2);
    } finally {
      await stopServer();
    }
  });

  it('rejects too-large bodies end to end', async () => {
    await startServer();

    try {
      handler = () => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: 'b'.repeat(MAX_RETRIEVAL_BYTES + 100),
      });
      const result = await integrationClient().retrieve({ url: `${baseUrl}/`, mode: 'evaluation' });

      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.failure.code).toBe('RESPONSE_TOO_LARGE');
      }
    } finally {
      await stopServer();
    }
  });

  it('rejects unsupported content types end to end', async () => {
    await startServer();

    try {
      handler = () => ({
        status: 200,
        headers: { 'content-type': 'application/pdf' },
        body: '%PDF-1.4',
      });
      const result = await integrationClient().retrieve({ url: `${baseUrl}/`, mode: 'evaluation' });

      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.failure.code).toBe('UNSUPPORTED_CONTENT_TYPE');
      }
    } finally {
      await stopServer();
    }
  });

  it('maps a hanging server to TIMEOUT', async () => {
    await startServer();

    try {
      handler = () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: 'never' });
      const result = await integrationClient(150).retrieve({
        url: `${baseUrl}/hang`,
        mode: 'evaluation',
      });

      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.failure.code).toBe('TIMEOUT');
      }
    } finally {
      await stopServer();
    }
  }, 15000);
});

describe('redirect guard (A1)', () => {
  it('a guard rejection aborts the redirect before the target is fetched', async () => {
    const seen: string[] = [];
    const guardCalls: string[] = [];
    const client = makeClient({
      dns: productionDns(),
      http: scriptHttp([redirectResponse('/private'), okResponse()], seen),
    });

    const outcome = await client
      .retrieve({
        url: 'http://public.example/go',
        mode: 'production',
        onBeforeRedirect: async (next) => {
          guardCalls.push(next.toString());
          throw new RedirectBlockedError('ROBOTS_DISALLOWED', next.toString());
        },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(outcome).toBeInstanceOf(RedirectBlockedError);
    expect((outcome as RedirectBlockedError).url).toBe('http://public.example/private');
    expect(guardCalls).toEqual(['http://public.example/private']);
    expect(seen).toEqual(['http://public.example/go']);
  });

  it('an allowing guard lets the redirect proceed normally', async () => {
    const seen: string[] = [];
    const guardCalls: string[] = [];
    const client = makeClient({
      dns: productionDns(),
      http: scriptHttp([redirectResponse('/next'), okResponse({ body: 'arrived' })], seen),
    });

    const result = await client.retrieve({
      url: 'http://public.example/go',
      mode: 'production',
      onBeforeRedirect: async (next) => {
        guardCalls.push(next.toString());
      },
    });

    expect(guardCalls).toEqual(['http://public.example/next']);
    expect(seen).toEqual(['http://public.example/go', 'http://public.example/next']);
    expect(result.ok).toBe(true);
  });

  it('shape validation runs before the guard is invoked', async () => {
    const seen: string[] = [];
    let guardCalls = 0;
    const client = makeClient({
      dns: productionDns(),
      http: scriptHttp([redirectResponse('ftp://public.example/file')], seen),
    });

    const result = await client.retrieve({
      url: 'http://public.example/go',
      mode: 'production',
      onBeforeRedirect: async () => {
        guardCalls += 1;
      },
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('UNSUPPORTED_PROTOCOL');
    }

    expect(guardCalls).toBe(0);
    expect(seen).toEqual(['http://public.example/go']);
  });
});

describe('post-DNS deadline check (A2)', () => {
  it('DNS consuming the deadline never starts an HTTP request', async () => {
    const seen: string[] = [];
    const calls: string[] = [];
    let now = 1_000_000;
    const slowDns: DnsResolver = async (hostname: string) => {
      calls.push(hostname);
      now += RETRIEVAL_TOTAL_TIMEOUT_MS + 1;
      return [PUBLIC_IPV4];
    };
    const client = makeClient({
      dns: slowDns,
      http: scriptHttp([okResponse()], seen),
      now: () => now,
    });

    const result = await client.retrieve({ url: 'http://public.example/', mode: 'production' });

    expect(calls).toEqual(['public.example']);
    expect(seen).toEqual([]);
    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.code).toBe('TIMEOUT');
    }
  });
});
