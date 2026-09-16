/**
 * Own-property lookup for agent glyphs so prototype keys never index MARKS.
 * `Object.hasOwn` is ES2022; the app tsconfig lib is ES2020.
 */
const objectHasOwn = (
  Object as ObjectConstructor & { hasOwn: (object: object, key: PropertyKey) => boolean }
).hasOwn.bind(Object);

export function markFor<T>(
  marks: Record<string, T>,
  agentId: string | null | undefined,
): T | undefined {
  const key = agentId ?? "shell";
  return objectHasOwn(marks, key) ? marks[key] : undefined;
}
