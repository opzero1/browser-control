// A deterministic synthetic tree for the stable-copy publication tests, shared by the test and its children.
export function publishFixture(count: number): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index += 1) {
    files.set(`part-${index % 4}/file-${index}.txt`, Buffer.from(`synthetic file ${index}\n`.repeat(64)));
  }
  return files;
}
