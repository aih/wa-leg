/** Format a string array as a Postgres array literal for use as a `::text[]` parameter. */
export function pgTextArray(values: readonly string[]): string {
  return '{' + values.map((v) => '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}';
}
