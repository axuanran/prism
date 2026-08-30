const WINDOWS_RESERVED_CHARACTER = /[\u0000-\u001f\u007f<>:"|?*]/u;
const WINDOWS_DEVICE_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

/**
 * Provider-portable POSIX-relative path shape.
 *
 * Callers own domain-specific normalization/reservations. Pass an NFC value
 * when canonical identity requires NFC; this predicate rejects only structural
 * filesystem aliases shared by Artifact and Project Source trees.
 */
export function isPortableRelativePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every(isPortableSegment);
}

function isPortableSegment(segment: string): boolean {
  return (
    segment !== "" &&
    segment !== "." &&
    segment !== ".." &&
    !WINDOWS_RESERVED_CHARACTER.test(segment) &&
    !segment.endsWith(".") &&
    !segment.endsWith(" ") &&
    !WINDOWS_DEVICE_BASENAME.test(segment)
  );
}
