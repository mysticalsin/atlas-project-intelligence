// Voice provider settings: v2.2 V1's stub of the V2 contract (V2's settings.js replaces this file at the merge).
// voiceConfig(env, library) -> { provider: 'aura' | 'elevenlabs', elevenlabs?: { apiKey, voiceId, modelId }, source: 'settings' | 'env' | 'none' }.
// This stub reads the environment only: ElevenLabs when ELEVENLABS_API_KEY is set, else Workers AI Aura. `library` (the LibraryStore stub, where V2 keeps the
// encrypted admin choice) is accepted and ignored here.
export async function voiceConfig(env, library) { // eslint-disable-line no-unused-vars
  const apiKey = String(env?.ELEVENLABS_API_KEY || '');
  return apiKey ? { provider: 'elevenlabs', elevenlabs: { apiKey, voiceId: env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM', modelId: env.ELEVENLABS_MODEL || 'eleven_flash_v2_5' }, source: 'env' } : { provider: 'aura', source: 'none' };
}
