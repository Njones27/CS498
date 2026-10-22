/** Hex SHA-256 of a file via Web Crypto. */
export async function sha256Hex(blob: Blob): Promise<string> {
  // Wrap in a typed array: under jsdom on Node 20 the Blob's ArrayBuffer comes from another
  // realm and WebCrypto rejects it as "not an ArrayBuffer". A view is accepted everywhere.
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
