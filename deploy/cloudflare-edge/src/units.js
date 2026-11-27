// audioMs: milliseconds of 24 kHz PCM16 (48 bytes per ms). Reservations use meter.js LIMITS.
export const audioMs = pcm => Math.ceil((pcm?.length || 0) / 48);
