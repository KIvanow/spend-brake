/**
 * Whether a dependency answers within `timeoutMs`: for readiness probes, which must not hang on a
 * store that accepts the connection but never replies.
 */
export async function answers(check: () => Promise<unknown>, timeoutMs = 2_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([check().then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
