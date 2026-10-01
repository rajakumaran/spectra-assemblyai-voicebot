/**
 * Wraps captured PCM16 mono audio in a WAV container for the Sync STT endpoint, which takes a whole
 * file rather than a stream.
 *
 * Kept free of Angular so the header can be unit-tested on plain buffers.
 */

/** Bytes in a canonical PCM WAV header. */
export const WAV_HEADER_BYTES = 44;

/** Total sample count across the captured chunks. */
export function countSamples(chunks: Int16Array[]): number {
  return chunks.reduce((total, chunk) => total + chunk.length, 0);
}

/**
 * Builds a 16-bit mono PCM WAV file. Returns the bytes, or null when there is nothing to send -
 * Sync STT rejects empty or near-empty clips with `audio_too_short`.
 */
export function encodeWav(chunks: Int16Array[], sampleRate: number): Uint8Array | null {
  const samples = countSamples(chunks);
  if (samples === 0) return null;

  const dataBytes = samples * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // everything after this field
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);            // fmt chunk length
  view.setUint16(20, 1, true);             // 1 = uncompressed PCM
  view.setUint16(22, 1, true);             // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate: 1 channel x 2 bytes
  view.setUint16(32, 2, true);              // block align
  view.setUint16(34, 16, true);             // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++, offset += 2) view.setInt16(offset, chunk[i], true);
  }

  return new Uint8Array(buffer);
}
