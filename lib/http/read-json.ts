export type BoundedJsonResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 413; error: string };

/** Read and parse a JSON request while enforcing a hard byte limit. */
export async function readBoundedJson<T>(request: Request, maxBytes: number): Promise<BoundedJsonResult<T>> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, status: 413, error: 'Request body is too large.' };
  }
  if (!request.body) return { ok: false, status: 400, error: 'A JSON request body is required.' };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413, error: 'Request body is too large.' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: 'Could not read request body.' };
  } finally {
    reader.releaseLock();
  }

  try {
    const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
    if (value === null || typeof value !== 'object') {
      return { ok: false, status: 400, error: 'JSON body must be an object or array.' };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, status: 400, error: 'Invalid JSON request body.' };
  }
}
