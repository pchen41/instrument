// instrument-smoke/checkout.ts
//
// Demo checkout handler used by Instrument's own dogfooding scans. It is
// intentionally un-instrumented — no metrics, no tracing — so it stands in for
// the kind of hot-path code Instrument flags and offers to harden.

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
  const startTime = Date.now();
  let status: 'success' | 'failure' = 'success';

  try {
    if (req.items.length === 0) {
      throw new Error('cart is empty');
    }

    const amount = totalCents(req.items);

    const reservation = await reserveInventory(req.items);
    if (!reservation.ok) {
      status = 'failure';
      return { orderId: '', totalCents: amount, status: 'declined' };
    }

    const charge = await chargePayment(req.paymentToken, amount);
    if (!charge.ok) {
      await releaseInventory(reservation.holdId);
      status = 'failure';
      return { orderId: '', totalCents: amount, status: 'declined' };
    }

    const order = await persistOrder(req.userId, req.items, amount, charge.chargeId);
    return { orderId: order.id, totalCents: amount, status: 'confirmed' };
  } finally {
    const duration = Date.now() - startTime;
    // Increment counter metric with status tag
    console.log(`metric:checkout.attempts:count:1|#status:${status}`);
    // Record histogram metric for checkout latency
    console.log(`metric:checkout.duration:histogram:${duration}|#status:${status}`);
  }
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
