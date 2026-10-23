import { describe, expect, it } from 'vitest';
import { redactText } from '@/lib/redact';

describe('redactText', () => {
  it('masks JWTs, bearer tokens and key=value secrets', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactText(`token ${jwt}`)).not.toContain('dozjg');
    expect(redactText('Authorization: Bearer abcdefghijklmnop123')).toBe('Authorization: Bearer [redacted]');
    expect(redactText('{"password":"hunter22"}')).toBe('{"password":"[redacted]"}');
    expect(redactText('plain message')).toBe('plain message');
  });
});
