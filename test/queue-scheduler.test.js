const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ExtractionScheduler,
  estimateConversationWork
} = require('../server');

function makeJob(scheduler, id, events = []) {
  return scheduler.createJob({
    requestId: id,
    provider: 'claude',
    sendProgress: (stage, extra) => events.push({ id, stage, ...extra })
  });
}

test('quick jobs receive a live queue position and one fast slot', async () => {
  const events = [];
  const scheduler = new ExtractionScheduler({ memoryRatioReader: () => 0.4 });
  const first = makeJob(scheduler, 'first', events);
  const second = makeJob(scheduler, 'second', events);

  await scheduler.enqueueQuick(first);
  const secondTurn = scheduler.enqueueQuick(second);

  assert.equal(scheduler.activeQuick, first);
  assert.equal(scheduler.quickQueue[0], second);
  assert.ok(events.some(event => event.id === 'second' && event.stage === 'queued' && event.position === 2));

  scheduler.finish(first);
  await secondTurn;
  assert.equal(scheduler.activeQuick, second);
  scheduler.finish(second);
});

test('a promoted heavy job yields only at a safe checkpoint', async () => {
  const scheduler = new ExtractionScheduler({ memoryRatioReader: () => 0.4 });
  const heavy = makeJob(scheduler, 'heavy');
  const quick = makeJob(scheduler, 'quick');

  await scheduler.enqueueQuick(heavy);
  assert.equal(scheduler.promoteOrQueue(heavy, 'message-count'), 'promoted');
  assert.equal(scheduler.activeHeavy, heavy);

  let quickStarted = false;
  const quickTurn = scheduler.enqueueQuick(quick).then(() => { quickStarted = true; });
  await Promise.resolve();
  assert.equal(quickStarted, false);

  const heavyCheckpoint = scheduler.checkpoint(heavy, 'claude.capture');
  await quickTurn;
  assert.equal(scheduler.activeQuick, quick);

  scheduler.finish(quick);
  await heavyCheckpoint;
  scheduler.finish(heavy);
});

test('a second long chat queues behind the current heavy job', async () => {
  const scheduler = new ExtractionScheduler({ memoryRatioReader: () => 0.4 });
  const firstHeavy = makeJob(scheduler, 'heavy-a');
  const secondHeavy = makeJob(scheduler, 'heavy-b');

  await scheduler.enqueueQuick(firstHeavy);
  scheduler.promoteOrQueue(firstHeavy, 'message-count');

  const secondQuickTurn = scheduler.enqueueQuick(secondHeavy);
  const checkpoint = scheduler.checkpoint(firstHeavy, 'claude.capture');
  await secondQuickTurn;

  assert.equal(scheduler.promoteOrQueue(secondHeavy, 'time-budget'), 'queued');
  assert.equal(scheduler.heavyQueue[0], secondHeavy);
  await checkpoint;

  scheduler.finish(firstHeavy);
  await scheduler.waitForHeavy(secondHeavy);
  assert.equal(scheduler.activeHeavy, secondHeavy);
  scheduler.finish(secondHeavy);
});

test('work estimator promotes only clearly expensive conversations early', () => {
  assert.equal(estimateConversationWork({ users: 12, assistants: 12, textLength: 8000, scrollHeight: 12000 }, []).heavy, false);
  assert.equal(estimateConversationWork({ users: 150, assistants: 150, textLength: 40000, scrollHeight: 50000 }, []).heavy, true);
});
