import { createHash } from 'node:crypto';

export type Action = Readonly<{
  tenant: string; task: string; actor: string; tool: string;
  recipient: string; subject: string; body: string;
}>;
type Grant = Readonly<{ fingerprint: string; expiresAt: number }>;
export type Decision =
  | { allowed: true; action: Action }
  | { allowed: false; reason: 'unknown' | 'used' | 'expired' | 'changed' | 'clock' | 'schema' };

// An explicit versioned tuple gives our narrow schema a deterministic encoding.
// Add every effect-bearing field here when the action schema changes.
export function fingerprint(a: Action): string {
  return createHash('sha256').update(JSON.stringify([
    'email-action/v1', a.tenant, a.task, a.actor, a.tool,
    a.recipient, a.subject, a.body,
  ])).digest('hex');
}

function snapshot(candidate: Action): Action | undefined {
  const fields = ['tenant', 'task', 'actor', 'tool', 'recipient', 'subject', 'body'] as const;
  if (!candidate || typeof candidate !== 'object' || Object.keys(candidate).length !== fields.length) return;
  if (fields.some(field => !Object.hasOwn(candidate, field) || typeof candidate[field] !== 'string')) return;
  const { tenant, task, actor, tool, recipient, subject, body } = candidate;
  return Object.freeze({ tenant, task, actor, tool, recipient, subject, body });
}

export class ApprovalGate {
  #grants = new Map<string, Grant>();
  #used = new Set<string>();

  // Trusted approval-service operation. The toy has no authentication layer.
  approve(id: string, action: Action, expiresAt: number): void {
    if (this.#grants.has(id) || !Number.isFinite(expiresAt)) {
      throw new Error('duplicate grant or invalid deadline');
    }
    const frozen = snapshot(action);
    if (!frozen) throw new Error('invalid action schema');
    this.#grants.set(id, Object.freeze({ fingerprint: fingerprint(frozen), expiresAt }));
  }

  consume(id: string, candidate: Action, now: number): Decision {
    if (!Number.isFinite(now)) return { allowed: false, reason: 'clock' };
    const grant = this.#grants.get(id);
    if (!grant) return { allowed: false, reason: 'unknown' };
    if (this.#used.has(id)) return { allowed: false, reason: 'used' };
    if (now >= grant.expiresAt) return { allowed: false, reason: 'expired' };
    // Copy before checking. The caller cannot mutate the checked dispatch object.
    const action = snapshot(candidate);
    if (!action) return { allowed: false, reason: 'schema' };
    if (fingerprint(action) !== grant.fingerprint) {
      return { allowed: false, reason: 'changed' };
    }
    // No await between validation and consumption: atomic in this one process.
    this.#used.add(id);
    return { allowed: true, action };
  }
}
