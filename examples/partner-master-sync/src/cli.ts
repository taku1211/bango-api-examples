import { once } from 'node:events';
import { openStore, addPartner, acceptBatch, setCheckpoint, applyBaseline, processInbox, currentState } from './core.ts';
import { createReceiver, signDemo } from './webhook.ts';
import { MockBango, DEMO_SECRET, COMPANY_NUMBER, CHANGED, changeEvent } from './mock.ts';
import { pullAndRecover } from './sync.ts';

if (process.argv[2] && process.argv[2] !== 'demo') {
  throw new Error('This first slice only supports the offline "demo" command. No live API calls are made.');
}

const db = openStore();
const api = new MockBango();
try {
  for (const row of api.input) addPartner(db, row.id, row.name);
  const job = api.batchMatch();
  if (job.data.status !== 'queued' || api.batchStatus().data.status !== 'completed') {
    throw new Error('mock batch did not finish');
  }
  acceptBatch(db, api.batchDownload().data);
  api.lookup();
  api.invoiceValid();

  // Bootstrapping: checkpoint first, then watch, then baseline.
  setCheckpoint(db, api.startNow().next_cursor);
  const watch = api.watch(COMPANY_NUMBER);
  applyBaseline(db, watch.subject, watch.current);

  const receiver = createReceiver(db, DEMO_SECRET);
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  try {
    const addr = receiver.address();
    if (!addr || typeof addr === 'string') throw new Error('HTTP receiver not bound');
    const url = `http://127.0.0.1:${addr.port}/webhooks/demo`;
    const test = signDemo(DEMO_SECRET, { id: 'whtest_demo', type: 'endpoint.test' });
    const testResult = await fetch(url, { method: 'POST', headers: test.headers, body: test.body });
    if (testResult.status !== 200) throw new Error('endpoint.test did not verify');

    const event = signDemo(DEMO_SECRET, changeEvent('evt_demo_v2', '2', CHANGED));
    for (let i = 0; i < 2; i++) {
      const received = await fetch(url, { method: 'POST', headers: event.headers, body: event.body });
      if (received.status !== 200) throw new Error('simulated signed event rejected');
    }
  } finally {
    receiver.close();
    await once(receiver, 'close');
  }
  const firstProcess = processInbox(db);
  const pull = pullAndRecover(db, api); // v2 event is a duplicate of the webhook.
  processInbox(db);
  api.enableGap();
  const recovered = pullAndRecover(db, api);
  console.log(JSON.stringify({
    simulation: true,
    warning: 'Synthetic companies and locally signed events; no BANGO production call or delivery.',
    trace: api.trace,
    firstProcess, pull, recovered,
    finalState: currentState(db),
  }, null, 2));
} finally {
  db.close();
}
