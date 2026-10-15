import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { InvalidWebhookBodyError, verifyBangoWebhook } from '../src/webhook.ts';
import { WebhookVerificationError } from 'standardwebhooks';
import { replaceUtf8ReplacementCharacterWithInvalidByte } from './fixtures/raw-body-mutations.ts';

type FixtureMessage = {
  name: string;
  purpose: string;
  body: string;
  headers: Record<string, string>;
};

type Fixture = {
  metadata: {
    kind: string;
    source: { commit: string; signerFileSha256: string };
    generation: { referenceTimeSeconds: number; syntheticOnly: boolean; disclaimer: string };
  };
  testSecrets: { previous: string; current: string };
  messages: Record<string, FixtureMessage>;
};

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/standardwebhooks.json', import.meta.url), 'utf8',
)) as Fixture;
const { current, previous } = fixture.testSecrets;
const { messages } = fixture;
const freezeFixtureClock = (context: TestContext) => {
  context.mock.method(Date, 'now', () => fixture.metadata.generation.referenceTimeSeconds * 1000);
};
const verify = (secrets: string | readonly string[], message: FixtureMessage) =>
  verifyBangoWebhook(secrets, Buffer.from(message.body), message.headers);

test('official SDK verifies synthetic signatures from the Bango signer with exact raw bytes', (context) => {
  freezeFixtureClock(context);
  assert.equal(fixture.metadata.kind, 'synthetic_standard_webhooks_compatibility_fixture');
  assert.equal(fixture.metadata.source.commit, '6e70135be02353c518b1409debda431a7fb77116');
  assert.match(fixture.metadata.source.signerFileSha256, /^[a-f0-9]{64}$/);
  assert.equal(fixture.metadata.generation.syntheticOnly, true);
  assert.match(fixture.metadata.generation.disclaimer, /No customer data/);

  assert.equal((verify(previous, messages.preRotationCurrent) as { id: string }).id, 'evt_123e4567-e89b-42d3-a456-426614174001');
  assert.equal((verify([current, previous], messages.gracefulRotationDual) as { id: string }).id, 'evt_123e4567-e89b-42d3-a456-426614174005');
  assert.equal((verify(current, messages.postRotationCurrentOnly) as { id: string }).id, 'evt_123e4567-e89b-42d3-a456-426614174006');
  assert.throws(() => verify(previous, messages.postRotationCurrentOnly), WebhookVerificationError);

  const dualSignatures = messages.gracefulRotationDual.headers['webhook-signature'].split(' ');
  assert.equal(dualSignatures.length, 2);
  assert.notEqual(dualSignatures[0], dualSignatures[1]);
  assert.doesNotThrow(() => verify(current, messages.gracefulRotationDual));
  assert.doesNotThrow(() => verify(previous, messages.gracefulRotationDual));

  const endpointTest = verify(current, messages.endpointTestCurrentOnly) as { id: string; type: string };
  assert.deepEqual(endpointTest, { id: 'whtest_123e4567-e89b-42d3-a456-426614174002', type: 'endpoint.test', created_at: '2026-10-15T00:00:00.000Z', data: { webhook_endpoint_id: 'whep_123e4567-e89b-42d3-a456-426614174003' } });
  assert.throws(() => verify(previous, messages.endpointTestCurrentOnly), WebhookVerificationError);

  const first = messages.retryAttempt1;
  const retry = messages.retryAttempt2;
  assert.equal(first.headers['webhook-id'], retry.headers['webhook-id']);
  assert.equal(first.body, retry.body);
  assert.notEqual(first.headers['webhook-timestamp'], retry.headers['webhook-timestamp']);
  assert.notEqual(first.headers['webhook-signature'], retry.headers['webhook-signature']);
  assert.doesNotThrow(() => verify(current, first));
  assert.doesNotThrow(() => verify(current, retry));

  const reserialized = Buffer.from(JSON.stringify(JSON.parse(messages.preRotationCurrent.body)));
  assert.throws(() => verifyBangoWebhook(previous, reserialized, messages.preRotationCurrent.headers), WebhookVerificationError);
});

test('official SDK accepts exactly 300 seconds and rejects 301 seconds on either side', (context) => {
  freezeFixtureClock(context);
  assert.equal((verify(current, messages.timestampMinus300) as { type: string }).type, 'endpoint.test');
  assert.equal((verify(current, messages.timestampPlus300) as { type: string }).type, 'endpoint.test');
  assert.throws(() => verify(current, messages.timestampMinus301), WebhookVerificationError);
  assert.throws(() => verify(current, messages.timestampPlus301), WebhookVerificationError);
});

test('signature failure, missing headers, malformed configuration, and signed invalid JSON stay distinct', (context) => {
  freezeFixtureClock(context);
  const message = messages.endpointTestCurrentOnly;
  const tampered = Buffer.from(message.body.replace('426614174003', '426614174099'));
  assert.throws(() => verifyBangoWebhook(current, tampered, message.headers), WebhookVerificationError);

  for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
    const missingHeader = { ...message.headers };
    delete missingHeader[name];
    assert.throws(() => verifyBangoWebhook(current, Buffer.from(message.body), missingHeader), WebhookVerificationError);
  }
  assert.throws(() => verifyBangoWebhook('whsec_', Buffer.from(message.body), message.headers), /Secret can't be empty/);
  assert.throws(() => verify(current, messages.signedInvalidJson), InvalidWebhookBodyError);
  assert.throws(() => verifyBangoWebhook(previous, Buffer.from(messages.signedInvalidJson.body), messages.signedInvalidJson.headers), WebhookVerificationError);

  const signedReplacementCharacter = messages.signedReplacementCharacter;
  assert.doesNotThrow(() => verify(current, signedReplacementCharacter));
  const malformedUtf8 = replaceUtf8ReplacementCharacterWithInvalidByte(signedReplacementCharacter.body);
  assert.equal(isUtf8(malformedUtf8), false);
  assert.throws(
    () => verifyBangoWebhook(current, malformedUtf8, signedReplacementCharacter.headers),
    WebhookVerificationError,
  );
});
