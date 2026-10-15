export function replaceUtf8ReplacementCharacterWithInvalidByte(body: string): Buffer {
  const bytes = Buffer.from(body);
  const replacement = Buffer.from('\uFFFD');
  const index = bytes.indexOf(replacement);
  if (index < 0) throw new Error('body does not contain the replacement character');
  return Buffer.concat([
    bytes.subarray(0, index),
    Buffer.from([0xff]),
    bytes.subarray(index + replacement.length),
  ]);
}
