// Minimal semver comparator. We only need "is A strictly newer than B?" for
// the upgrade check. Pulling the full `semver` package would bloat the
// compiled binary for one function.

export function parseSemver(
  v: string,
): { major: number; minor: number; patch: number; pre: string } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v);
  if (!m) return null;
  return { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, pre: m[4] ?? '' };
}

// Returns 1 if a > b, -1 if a < b, 0 if equal. Returns 0 if either is
// unparseable (defensive — upgrade will treat that as "already latest").
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  // Treat "no prerelease" as greater than "has prerelease" (1.0.0 > 1.0.0-rc).
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === '') return 1;
  if (pb.pre === '') return -1;
  return pa.pre > pb.pre ? 1 : -1;
}
