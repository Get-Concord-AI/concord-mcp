export function versionTuple(output: string): number[] | undefined {
  const match = /\bv?(\d+)\.(\d+)\.(\d+)\b/iu.exec(output);
  if (match === null) return undefined;
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

export function atLeast(actual: readonly number[], required: readonly number[]): boolean {
  for (let index = 0; index < required.length; index += 1) {
    const left = actual[index] ?? 0;
    const right = required[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}
