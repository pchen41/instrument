import { describe, expect, it } from 'vitest';
import { validateSignIn, hasErrors, EMAIL_RE } from './validation';

describe('validateSignIn', () => {
  it('accepts a well-formed email and a non-empty password', () => {
    const errors = validateSignIn({ email: 'rae@acme.io', password: 'hunter2' });
    expect(hasErrors(errors)).toBe(false);
    expect(errors).toEqual({});
  });

  it('flags a missing email', () => {
    const errors = validateSignIn({ email: '', password: 'hunter2' });
    expect(errors.email).toBe('Enter your email address.');
    expect(hasErrors(errors)).toBe(true);
  });

  it('flags a malformed email', () => {
    const errors = validateSignIn({ email: 'not-an-email', password: 'hunter2' });
    expect(errors.email).toMatch(/valid email/i);
  });

  it('trims surrounding whitespace before validating the email', () => {
    const errors = validateSignIn({ email: '  rae@acme.io  ', password: 'hunter2' });
    expect(errors.email).toBeUndefined();
  });

  it('flags a missing password', () => {
    const errors = validateSignIn({ email: 'rae@acme.io', password: '' });
    expect(errors.password).toBe('Enter your password.');
  });

  it('reports both errors when both fields are empty', () => {
    const errors = validateSignIn({ email: '', password: '' });
    expect(errors.email).toBeDefined();
    expect(errors.password).toBeDefined();
    expect(hasErrors(errors)).toBe(true);
  });
});

describe('EMAIL_RE', () => {
  it.each([
    ['a@b.co', true],
    ['first.last@sub.domain.io', true],
    ['no-at-sign', false],
    ['missing@tld', false],
    ['spaces in@email.com', false],
  ])('%s -> %s', (input, expected) => {
    expect(EMAIL_RE.test(input)).toBe(expected);
  });
});
