import { describe, expect, it } from 'vitest';
import { protectedRouteDecision, signInRouteDecision } from './guard';

const aUser = { id: 'u1', email: 'rae@acme.io' };

describe('protectedRouteDecision', () => {
  it('waits while auth is still resolving', () => {
    expect(protectedRouteDecision({ user: null, loading: true })).toBe('loading');
    expect(protectedRouteDecision({ user: aUser, loading: true })).toBe('loading');
  });

  it('redirects an unauthenticated user once resolved', () => {
    expect(protectedRouteDecision({ user: null, loading: false })).toBe('redirect');
  });

  it('allows an authenticated user', () => {
    expect(protectedRouteDecision({ user: aUser, loading: false })).toBe('allow');
  });
});

describe('signInRouteDecision', () => {
  it('waits while auth is still resolving', () => {
    expect(signInRouteDecision({ user: null, loading: true })).toBe('loading');
  });

  it('redirects an already-signed-in user into the console', () => {
    expect(signInRouteDecision({ user: aUser, loading: false })).toBe('redirect');
  });

  it('shows the form for a signed-out user', () => {
    expect(signInRouteDecision({ user: null, loading: false })).toBe('allow');
  });
});
