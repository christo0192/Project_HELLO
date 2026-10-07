import { bytesToBase64 } from './sha256';

export interface FetchedAudio {
  base64: string;
  /** The response's own content type when it names audio, else null. */
  mime: string | null;
}

/**
 * Download one recording's bytes from its short-lived signed URL and return
 * them as base64.
 *
 * The signed URL points at Supabase Storage, which answers object reads with
 * `Access-Control-Allow-Origin: *`, so the browser may read the bytes. No
 * credentials are sent (`credentials: 'omit'`) and no referrer: the URL itself
 * is the authority and it is never stored, logged or written to the report.
 */
export async function fetchAudioBase64(url: string, signal?: AbortSignal): Promise<FetchedAudio> {
  const res = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`audio download failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('audio download was empty');
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  return { base64: bytesToBase64(bytes), mime: type.startsWith('audio/') ? type : null };
}
