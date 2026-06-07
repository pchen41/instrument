// instrument-smoke/checkout.ts
//
// Demo checkout handler used by Instrument's own dogfooding scans. It is
// intentionally un-instrumented — no metrics, no tracing — so it stands in for
// the kind of hot-path code Instrument flags and offers to harden.

import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('checkout');

export interface CartItem {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

export interface CheckoutRequest {
  userId: string;
  items: CartItem[];
  paymentToken: string;
}

export interface CheckoutResult {
  orderId: string;
  totalCents: number;
  status: 'confirmed' | 'declined';
}

function totalCents(items: CartItem[]): number {
  return items.reduce((sum, it) => sum + it.unitPriceCents * it.quantity, 0);
}

export async function checkout(req: CheckoutRequest): Promise<CheckoutResult> {
  return tracer.startActiveSpan('checkout', async (span) => {
    try {
      if (req.items.length === 0) {
        throw new Error('cart is empty');
      }

      const amount = totalCents(req.items);

      const reservation = await reserveInventory(req.items);
      if (!reservation.ok) {
        return { orderId: '', totalCents: amount, status: 'declined' };
      }

      const charge = await chargePayment(req.paymentToken, amount);
      if (!charge.ok) {
        await releaseInventory(reservation.holdId);
        return { orderId: '', totalCents: amount, status: 'declined' };
      }

      const order = await persistOrder(req.userId, req.items, amount, charge.chargeId);
      return { orderId: order.id, totalCents: amount, status: 'confirmed' };
    } catch (error) {
      if (error instanceof Error) {
        span.recordException(error);
      }
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

// --- collaborators (stubbed for the smoke module) --------------------------

async function reserveInventory(items: CartItem[]): Promise<{ ok: boolean; holdId: string }> {
  await tick();
  return { ok: items.every((it) => it.quantity > 0), holdId: 'hold_' + rand() };
}

async function chargePayment(token: string, amountCents: number): Promise<{ ok: boolean; chargeId: string }> {
  await tick();
  return { ok: token.startsWith('tok_') && amountCents > 0, chargeId: 'ch_' + rand() };
}

async function releaseInventory(_holdId: string): Promise<void> {
  await tick();
}

async function persistOrder(
  _userId: string,
  _items: CartItem[],
  _amountCents: number,
  _chargeId: string,
): Promise<{ id: string }> {
  await tick();
  return { id: 'order_' + rand() };
}

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}
