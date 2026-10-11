export * as Mime from "./mime.js"

export function detect(bytes: Uint8Array) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x49, 0x44, 0x33])) return "audio/mpeg"
  if (isMpegFrameSync(bytes)) return "audio/mpeg"
  if (startsWith(bytes, [0x66, 0x4c, 0x61, 0x43])) return "audio/flac"
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) return "audio/ogg"
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm"
  // RIFF is shared by WEBP, WAVE and AVI; the four bytes at offset 8 disambiguate.
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46])) {
    if (startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) return "image/webp"
    if (startsWith(bytes.subarray(8), [0x57, 0x41, 0x56, 0x45])) return "audio/wav"
    if (startsWith(bytes.subarray(8), [0x41, 0x56, 0x49, 0x20])) return "video/x-msvideo"
  }
  // ftyp is shared by AVIF, M4A, MOV and MP4; the major brand at offset 8 disambiguates.
  if (startsWith(bytes.subarray(4), [0x66, 0x74, 0x79, 0x70])) {
    const brand = ascii(bytes.subarray(8, 12))
    if (brand === "avif" || brand === "avis") return "image/avif"
    if (brand === "M4A ") return "audio/mp4"
    if (brand === "qt  ") return "video/quicktime"
    if (FTYP_VIDEO_BRANDS.has(brand)) return "video/mp4"
  }
  return isText(bytes) ? "text/plain" : "application/octet-stream"
}

// MPEG audio frame sync: the leading 0xFF is followed by 11 set bits.
function isMpegFrameSync(bytes: Uint8Array) {
  return bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xe0) === 0xe0
}

const FTYP_VIDEO_BRANDS = new Set(["isom", "iso2", "mp41", "mp42", "avc1", "dash", "M4V ", "3gp4", "3gp5", "MSNV", "NDAS"])

function ascii(bytes: Uint8Array) {
  return String.fromCharCode(...bytes)
}

function startsWith(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value)
}

function isText(bytes: Uint8Array) {
  if (bytes.length === 0) return true
  if (bytes.includes(0)) return false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true })
  } catch {
    return false
  }
  const controls = bytes.reduce((count, byte) => count + Number(byte < 9 || (byte > 13 && byte < 32)), 0)
  return controls / bytes.length <= 0.3
}
