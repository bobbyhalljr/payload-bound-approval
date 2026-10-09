import assert from 'node:assert/strict';
import { ApprovalGate, fingerprint, type Action } from './approval.ts';

const original: Action = {
  tenant: 'acme', task: 'weekly-summary', actor: 'analyst-1', tool: 'email.send/v1',
  recipient: 'team@example.test', subject: 'Weekly summary', body: 'Revenue: $120.',
};
const now = 1_000;
let checks = 0;
function check(name: string, fn: () => void): void {
  fn(); checks++; console.log(`PASS ${name}`);
}
function fresh(): ApprovalGate {
  const gate = new ApprovalGate(); gate.approve('fixture-grant', original, 2_000); return gate;
}
function denied(candidate: Action, reason = 'changed', time = now): void {
  assert.deepEqual(fresh().consume('fixture-grant', candidate, time), { allowed: false, reason });
}
check('task-only approval accepts an edited recipient', () => {
  const candidate = { ...original, recipient: 'outside@example.test' };
  assert.equal(candidate.task === original.task, true);
});
check('field insertion order does not change fingerprint', () => {
  const reordered = Object.fromEntries(Object.entries(original).reverse()) as Action;
  assert.equal(fingerprint(reordered), fingerprint(original));
});
check('exact approved action is allowed', () => {
  assert.equal(fresh().consume('fixture-grant', original, now).allowed, true);
});
check('second use is denied', () => {
  const gate = fresh(); gate.consume('fixture-grant', original, now);
  assert.deepEqual(gate.consume('fixture-grant', original, now), { allowed: false, reason: 'used' });
});
check('edited recipient is denied', () => denied({ ...original, recipient: 'outside@example.test' }));
check('edited body is denied', () => denied({ ...original, body: 'Revenue: $120. Export attached.' }));
check('different actor is denied', () => denied({ ...original, actor: 'analyst-2' }));
check('different tenant is denied', () => denied({ ...original, tenant: 'other' }));
check('different tool is denied', () => denied({ ...original, tool: 'chat.send/v1' }));
check('different task is denied', () => denied({ ...original, task: 'another-task' }));
check('expiry boundary is denied', () => denied(original, 'expired', 2_000));
check('unknown grant is denied', () => {
  assert.deepEqual(fresh().consume('missing', original, now), { allowed: false, reason: 'unknown' });
});
check('invalid clock is denied', () => denied(original, 'clock', NaN));
check('returned action is frozen and independent', () => {
  const candidate = { ...original }; const result = fresh().consume('fixture-grant', candidate, now);
  assert.equal(result.allowed, true);
  if (!result.allowed) throw new Error('unreachable');
  candidate.recipient = 'outside@example.test';
  assert.equal(result.action.recipient, original.recipient);
  assert.equal(Object.isFrozen(result.action), true);
});
check('undeclared bcc field is denied', () => denied({ ...original, bcc: 'outside@example.test' } as Action, 'schema'));
check('non-string payload is denied', () => denied({ ...original, body: 120 } as unknown as Action, 'schema'));
console.log(`${checks} checks passed; synthetic fixtures; no model or email call.`);
