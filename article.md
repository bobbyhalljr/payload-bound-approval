You approve an email to your internal team. Routine work. Nothing exciting should happen.

Before dispatch, the agent changes the recipient to someone outside the company. The task is still called `weekly-summary`, so your approval check waves it through.

Congratulations. You approved a task name. The email went sightseeing.

On October 8, 2026, Google [announced the Gemini agent](https://cloud.google.com/blog/products/ai-machine-learning/welcome-to-gemini-at-work-2026): a universal work agent across applications, with persistent cloud execution, tools and subagents. The announcement also describes identity, authorization, sandboxing and network controls.

That is the launch. The little email disaster above is a synthetic example of an application boundary I would build under any agent that can act across apps.

An approval should mean **send this exact action**, with these recipients and this content. Change the action, ask again.

Let's build that boundary in TypeScript. No API key. No model call. No actual email, which is excellent news for our imaginary legal department.

This is an application-side pattern inspired by the announcement. I have not tested Google's approval implementation.

## The checkbox that approved too much

Imagine your harness stores this:

```ts
approvedTasks.add('weekly-summary');
```

Then every later action carrying that task name can pass. Editing the recipient does not change the lookup. Neither does adding a different body. The lookup has one job, and that job is remembering the label on the folder.

This is a gap between review and use. The agent may have permission to work on the assignment, while the specific outbound action still needs approval.

![The same task name survives an edit from an internal recipient to an external recipient. The task-only baseline allows it; the payload-bound gate denies it.](https://raw.githubusercontent.com/bobbyhalljr/payload-bound-approval/main/images/01-edited-request.png)

The fix starts with a narrow action schema. Every field that can change the external effect belongs in the approved representation.

For this toy email action, that means tenant, task, actor, tool version, recipient, subject and body. The recipient is rather important when the tool's main feature is sending things to recipients. A real email schema would also need attachments, CC, BCC and any other fields the adapter can send. This demo rejects undeclared fields, including BCC.

## Run the build

The source, fixtures, exact output and diagrams are in [bobbyhalljr/payload-bound-approval](https://github.com/bobbyhalljr/payload-bound-approval).

Prerequisites: Node.js 22.18 or later and Git. Tested here with Node.js 22.20.0. No packages or API key are required.

```bash
git clone https://github.com/bobbyhalljr/payload-bound-approval.git
cd payload-bound-approval
node demo.ts
```

`node demo.ts` runs the synthetic cases. `approval.ts` contains the gate. Node executes the TypeScript through native type stripping; this command does not run a TypeScript type checker.

## Give the yes an exact address

I use a versioned tuple rather than serializing whichever object the caller hands me. Its field order is explicit, so property insertion order cannot accidentally invalidate an otherwise identical request.

The hash uses Node's [built-in crypto module](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptocreatehashalgorithm-options). It gives the approval service a compact fingerprint of this exact representation.

The hash does not establish who approved it. An agent can hash its own bad idea perfectly well. That authority comes from the trusted service that stores the grant.

![A trusted approval service stores the action fingerprint and expiry. The dispatcher recomputes the fingerprint, compares it, consumes one use, and receives a frozen action.](https://raw.githubusercontent.com/bobbyhalljr/payload-bound-approval/main/images/02-payload-binding.png)

Here is the complete gate:

```ts
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
```

The interesting part is what happens after the hash. Three details keep the approval attached to the action:

**Unknown fields fail.** TypeScript types disappear at runtime. The email provider does not care how reassuring your editor looked. The gate checks the declared fields before it copies them. Passing an extra `bcc` field cannot quietly extend the action that leaves the gate.

**The returned object is the dispatch object.** The gate copies and freezes the fields before hashing them. A caller editing its original object after validation cannot alter that returned action. The tool adapter must use `decision.action` directly and must not rebuild the payload from mutable input.

**Acceptance consumes the grant.** There is no `await` between validation and marking it used. That makes this check-and-consume sequence atomic within this single JavaScript process. It does not provide atomicity across workers or process restarts.

If the recipient or body changes, the agent needs another review of the new exact action. A previous yes remains attached to the old payload. "But you said yes earlier" is not a dispatch protocol.

## Exact tested output

```text
PASS task-only approval accepts an edited recipient
PASS field insertion order does not change fingerprint
PASS exact approved action is allowed
PASS second use is denied
PASS edited recipient is denied
PASS edited body is denied
PASS different actor is denied
PASS different tenant is denied
PASS different tool is denied
PASS different task is denied
PASS expiry boundary is denied
PASS unknown grant is denied
PASS invalid clock is denied
PASS returned action is frozen and independent
PASS undeclared bcc field is denied
PASS non-string payload is denied
16 checks passed; synthetic fixtures; no model or email call.
```

These are assertions over local fixtures. The first check deliberately demonstrates the weak task-only baseline. The other checks exercise the stricter gate and its encoding and object-copy behavior. Sixteen passes describe this fixture suite, not a security success rate. Please do not put "100% secure" on a slide because sixteen local assertions had a good afternoon.

![The sixteen local checks allow the exact request and reject changed fields, expired or reused grants, unknown grants, extra fields and invalid clock values. The diagram explicitly names the single-process limitation.](https://raw.githubusercontent.com/bobbyhalljr/payload-bound-approval/main/images/03-fixture-results.png)

## The part that does not fit in the demo

There is no approval UI, authenticated user, durable grant database, revocation service, email provider or model here. Fixture grant IDs are predictable. Production IDs should be unguessable, and agents should never be able to mint their own grants. Letting the agent approve itself would save a lot of clicks. So would removing the brakes.

The application should derive tenant and actor from authenticated execution context, validate the tool's full runtime schema, and show the exact fields to the reviewer. Treat untrusted JSON as data. This narrow validator is not designed for arbitrary executable JavaScript objects, getters or proxies.

The clock comes from the caller in the fixture. Production needs a trusted server clock and a short policy-defined lifetime. It also needs a durable transaction or conditional update for one-use claims, plus audit records and revocation checks.

Consuming a grant does not make a remote write happen exactly once. A crash after consumption can lose work. A lost provider response can leave the effect unknown. Pair the approval claim with an idempotency key, durable dispatch state and reconciliation. The retry should recover the same approved intent rather than manufacture a fresh one.

Finally, a hash comparison says nothing about whether the content is safe or correct. SHA-256 can faithfully identify an awful email. Review and policy decide whether it should leave the building. The fingerprint keeps their decision attached to the bytes they evaluated.

## What I would ship next

An agent that works across apps needs an approval boundary that survives the trip.

Freeze the action. Bind the grant. Consume it at dispatch. Preserve the receipt when the network becomes uncertain.

That is also how I think about Roster: AI employees with responsibilities, tools and clear boundaries around real work. The useful unit is an assignment with an outcome and evidence you can inspect.

[Try Roster](https://get-roster.com).
