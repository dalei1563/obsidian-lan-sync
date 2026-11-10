import test from 'node:test';
import assert from 'node:assert/strict';
import { planOverwrite } from '../src/sync/overwrite-plan';
import { isExcluded, normalizeExclusions } from '../shared/exclusions';
import { hash, id, type Revision, type Snapshot } from '../shared/protocol';

function head(path: string, text: string): Revision {
  return {id: id(), fileId: id(), parents: [], path, deleted: false, hash: hash(text), size: Buffer.byteLength(text), clientId: id()};
}
function snapshot(...heads: Revision[]): Snapshot {
  return {protocol: 2, serverId: id(), epoch: id(), cursor: 'cursor', files: heads.map(h => ({fileId: h.fileId, heads: [h]}))};
}
const excluded = (path: string) => isExcluded(path, normalizeExclusions(['private/']));
function summary(plan: ReturnType<typeof planOverwrite>) { return plan.actions.map(a => [a.type, a.path]).sort(); }

test('cloud overwrite removes local-only notes, downloads cloud-only notes and replaces differing shared notes', () => {
  const local = new Map([['日记.md', Buffer.from('only local')], ['工作.md', Buffer.from('local')], ['private/a.md', Buffer.from('private')]]);
  const remote = snapshot(head('工作.md', 'cloud'), head('计划.md', 'only cloud'), head('private/a.md', 'private cloud'));
  const plan = planOverwrite('cloud-to-local', local, remote, excluded);
  assert.deepEqual(summary(plan), [['delete-local', '日记.md'], ['download', '工作.md'], ['download', '计划.md']].sort());
  assert.equal(plan.local, 2); assert.equal(plan.cloud, 2);
});
test('local overwrite creates uploads and cloud deletions without touching excluded paths', () => {
  const local = new Map([['日记.md', Buffer.from('only local')], ['工作.md', Buffer.from('local')], ['private/a.md', Buffer.from('private')]]);
  const remote = snapshot(head('工作.md', 'cloud'), head('计划.md', 'only cloud'), head('private/a.md', 'private cloud'));
  const plan = planOverwrite('local-to-cloud', local, remote, excluded);
  assert.deepEqual(summary(plan), [['upload', '日记.md'], ['upload', '工作.md'], ['delete-cloud', '计划.md']].sort());
  assert.equal(plan.actions[0].type, 'delete-cloud');
});
test('the confirmation fingerprint changes if either side changes, including unchanged notes', () => {
  const h = head('same.md', 'same'), remote = snapshot(h), local = new Map([['same.md', Buffer.from('same')]]);
  const plan = planOverwrite('local-to-cloud', local, remote, excluded);
  assert.equal(plan.unchanged, 1); assert.equal(plan.actions.length, 0);
  local.set('same.md', Buffer.from('changed'));
  assert.notEqual(planOverwrite('local-to-cloud', local, remote, excluded).fingerprint, plan.fingerprint);
  local.set('same.md', Buffer.from('same'));
  assert.notEqual(planOverwrite('local-to-cloud', local, {...remote, cursor: 'later'}, excluded).fingerprint, plan.fingerprint);
});
test('ambiguous cloud conflicts and case collisions are not silently resolved', () => {
  const a = head('one.md', 'one'), b = {...head('one.md', 'two'), fileId: a.fileId};
  const conflict = snapshot(a); conflict.files[0].heads.push(b);
  assert.throws(() => planOverwrite('cloud-to-local', new Map(), conflict, excluded), /冲突/);
  assert.throws(() => planOverwrite('local-to-cloud', new Map([['One.md', Buffer.from('one')]]), snapshot(a), excluded), /大小写/);
});
