import type { WorkboardChange } from "@openclaw/workboard-contract";

export const WORKBOARD_DURABLE_EVENT_MAX_DEPTH = 1024;
const WORKBOARD_DURABLE_EVENT_MAX_ATTEMPTS = 8;
const WORKBOARD_DURABLE_EVENT_BACKOFF_MS = 1_000;

type WorkboardDurableEventState = "pending" | "acked" | "dead_letter";

export type WorkboardDurableEvent = {
  id: string;
  idempotencyKey: string;
  change: WorkboardChange;
  state: WorkboardDurableEventState;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  createdAt: number;
};

export type WorkboardDurableEventPersistence = {
  enqueue(event: WorkboardDurableEvent): Promise<boolean>;
  due(now: number, limit: number): Promise<WorkboardDurableEvent[]>;
  acknowledge(id: string): Promise<void>;
  fail(id: string, error: string, now: number): Promise<void>;
  replayDeadLetters(now: number): Promise<number>;
};

function eventIdentity(change: WorkboardChange): string {
  return `workboard.change:${change.epoch}:${change.revision}`;
}

export class WorkboardDurableEventIntake {
  constructor(
    private readonly persistence: WorkboardDurableEventPersistence,
    private readonly now: () => number = Date.now,
  ) {}

  async enqueue(change: WorkboardChange): Promise<void> {
    const idempotencyKey = eventIdentity(change);
    const accepted = await this.persistence.enqueue({
      id: idempotencyKey,
      idempotencyKey,
      change,
      state: "pending",
      attempts: 0,
      nextAttemptAt: this.now(),
      createdAt: this.now(),
    });
    if (!accepted) {
      throw new Error("workboard durable event intake is full");
    }
  }

  async drain(
    deliver: (change: WorkboardChange) => void | Promise<void>,
    limit = 128,
  ): Promise<{ delivered: number; failed: number }> {
    const events = await this.persistence.due(this.now(), Math.max(1, Math.min(128, limit)));
    let delivered = 0;
    let failed = 0;
    for (const event of events) {
      try {
        await deliver(event.change);
        await this.persistence.acknowledge(event.id);
        delivered += 1;
      } catch (error) {
        failed += 1;
        await this.persistence.fail(event.id, String(error), this.now());
      }
    }
    return { delivered, failed };
  }

  async replayDeadLetters(): Promise<number> {
    return await this.persistence.replayDeadLetters(this.now());
  }

  static retryDelay(attempts: number): number {
    return Math.min(60_000, WORKBOARD_DURABLE_EVENT_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
  }

  static maxAttempts(): number {
    return WORKBOARD_DURABLE_EVENT_MAX_ATTEMPTS;
  }
}
