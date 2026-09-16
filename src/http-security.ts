export type SecurityContentType = 'json' | 'html';

export function securityHeaders(contentType: SecurityContentType = 'json'): Record<string, string> {
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
  if (contentType === 'html') {
    headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
  }
  if (process.env.NODE_ENV === 'production') {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

interface LimitWindow {
  startedAt: number;
  count: number;
}

export class SlidingWindowLimiter {
  private readonly windows = new Map<string, LimitWindow>();

  constructor(
    private readonly maximum: number,
    private readonly windowMs: number,
    private readonly maximumKeys: number,
  ) {
    if (maximum < 1 || windowMs < 1 || maximumKeys < 1) {
      throw new Error('rate limiter values must be positive');
    }
  }

  get size(): number {
    return this.windows.size;
  }

  allow(key: string, now = Date.now()): { allowed: boolean; retryAfter: number } {
    this.prune(now);
    let window = this.windows.get(key);
    if (!window || now - window.startedAt >= this.windowMs) {
      if (!window && this.windows.size >= this.maximumKeys) {
        const oldest = this.windows.keys().next().value as string | undefined;
        if (oldest) this.windows.delete(oldest);
      }
      window = { startedAt: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    const remainingMs = Math.max(1, this.windowMs - (now - window.startedAt));
    return {
      allowed: window.count <= this.maximum,
      retryAfter: Math.ceil(remainingMs / 1000),
    };
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.windows.delete(key);
    }
  }
}

interface RequestLogInput {
  method?: string;
  url?: string;
}

export function requestLog(
  request: RequestLogInput,
  status: number,
  startedAt: number,
  requestId: string,
  endedAt = Date.now(),
): string {
  let path = '/';
  try {
    path = new URL(request.url ?? '/', 'http://localhost').pathname;
  } catch {
    path = '/invalid-url';
  }
  return JSON.stringify({
    requestId,
    method: request.method ?? 'UNKNOWN',
    path,
    status,
    durationMs: Math.max(0, endedAt - startedAt),
  });
}
