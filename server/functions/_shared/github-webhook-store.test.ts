// Deterministic contract tests for the delivery-dedupe rule (Task 6 slice-1
// review fix, the unanimous HIGH). A unique (provider, external_delivery_id) hit
// must NOT blindly short-circuit: only a terminally-good row (`processed`, or
// `ignored`+signature_valid) skips re-processing; a mid-flight (`received`/
// `failed`) or previously-rejected (`ignored`+!signature_valid) row is refreshed
// and re-processed so a GitHub redelivery can finish the work. This fakes the
// PostgREST surface so both branches are covered without a live DB (same approach
// as telemetry-store.test.ts).
import { describe, expect, it, vi } from 'vitest';
import { createGithubWebhookStore, type InboundInsert } from './github-webhook-store';

type Existing = { id: string; processing_status: string; signature_valid: boolean } | null;

function mockAdmin(opts: { insertError?: { code: string } | null; existing?: Existing; onUpdate?: () => void }) {
  function builder() {
    const state: { op?: 'insert' | 'select' | 'update' } = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    b.insert = () => { state.op = 'insert'; return b; };
    b.update = () => { state.op = 'update'; opts.onUpdate?.(); return b; };
    b.select = () => { if (state.op !== 'insert') state.op = 'select'; return b; };
    b.eq = () => b;
    b.limit = () => b;
    b.order = () => b;
    b.maybeSingle = () => b;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    b.then = (resolve: (r: { data: unknown; error: unknown }) => unknown) => {
      if (state.op === 'insert') return resolve({ data: opts.insertError ? null : [{ id: 'new-1' }], error: opts.insertError ?? null });
      if (state.op === 'update') return resolve({ data: null, error: null });
      return resolve({ data: opts.existing ?? null, error: null }); // conflict lookup
    };
    return b;
  }
  return { database: { from: () => builder() } };
}

function rec(over: Partial<InboundInsert> = {}): InboundInsert {
  return {
    workspaceId: 'ws-1', integrationId: null, eventType: 'pull_request', eventAction: 'opened',
    externalDeliveryId: 'd-1', providerCorrelationKey: null, signatureValid: true,
    headersRedacted: {}, payloadRedacted: {}, receivedAt: 't0', processingStatus: 'received', ...over,
  };
}

describe('recordDelivery dedupe', () => {
  it('fresh insert → not a duplicate', async () => {
    const admin = mockAdmin({ insertError: null });
    expect(await createGithubWebhookStore(admin).recordDelivery(rec())).toEqual({ id: 'new-1', duplicate: false });
  });

  it('conflict on a terminally-processed row → short-circuit, no refresh write', async () => {
    const onUpdate = vi.fn();
    const admin = mockAdmin({ insertError: { code: '23505' }, existing: { id: 'old', processing_status: 'processed', signature_valid: true }, onUpdate });
    expect(await createGithubWebhookStore(admin).recordDelivery(rec())).toEqual({ id: 'old', duplicate: true });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('conflict on an ignored+valid row (legitimately ignored) → short-circuit', async () => {
    const onUpdate = vi.fn();
    const admin = mockAdmin({ insertError: { code: '23505' }, existing: { id: 'old', processing_status: 'ignored', signature_valid: true }, onUpdate });
    expect(await createGithubWebhookStore(admin).recordDelivery(rec())).toEqual({ id: 'old', duplicate: true });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('conflict on a previously-REJECTED row (ignored+!valid) → re-process + refresh', async () => {
    const onUpdate = vi.fn();
    const admin = mockAdmin({ insertError: { code: '23505' }, existing: { id: 'old', processing_status: 'ignored', signature_valid: false }, onUpdate });
    expect(await createGithubWebhookStore(admin).recordDelivery(rec())).toEqual({ id: 'old', duplicate: false });
    expect(onUpdate).toHaveBeenCalledTimes(1); // row refreshed so it can complete
  });

  it('conflict on a mid-flight row (received) → re-process + refresh', async () => {
    const onUpdate = vi.fn();
    const admin = mockAdmin({ insertError: { code: '23505' }, existing: { id: 'old', processing_status: 'received', signature_valid: true }, onUpdate });
    expect(await createGithubWebhookStore(admin).recordDelivery(rec())).toEqual({ id: 'old', duplicate: false });
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('conflict on a failed row → re-process + refresh', async () => {
    const onUpdate = vi.fn();
    const admin = mockAdmin({ insertError: { code: '23505' }, existing: { id: 'old', processing_status: 'failed', signature_valid: true }, onUpdate });
    expect(await createGithubWebhookStore(admin).recordDelivery(rec())).toEqual({ id: 'old', duplicate: false });
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});
