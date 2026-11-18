/**
 * Convert the base64 payload returned by the Electron `fs:readFileBinary`
 * bridge back into raw bytes. UTF-8 text decoding must never touch a .xlsx:
 * it is a zip archive and would be corrupted beyond repair.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Reverse of base64ToBytes: raw bytes -> base64 for the Electron write bridge. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
