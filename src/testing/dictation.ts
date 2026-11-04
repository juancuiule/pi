// Synthetic audio for dictation tests: a loud voiced tone stands in for speech, faint noise for a quiet room. Both are
// 16 kHz mono PCM16, what the dictation socket carries.
const RATE = 16_000;

const samplesOf = (ms: number) => Math.round((RATE * ms) / 1000);

/** `ms` of a 180 Hz tone with harmonics at about a third of full scale: loud enough to read as speech. */
export const speech = (ms: number): Int16Array => {
  const samples = new Int16Array(samplesOf(ms));
  for (let index = 0; index < samples.length; index += 1) {
    const t = index / RATE;
    const wave =
      Math.sin(2 * Math.PI * 180 * t) +
      0.5 * Math.sin(2 * Math.PI * 360 * t) +
      0.25 * Math.sin(2 * Math.PI * 540 * t);
    samples[index] = Math.round(wave * 0.2 * 32_767);
  }
  return samples;
};

/** `ms` of faint deterministic noise, far under the speech threshold. */
export const silence = (ms: number): Int16Array => {
  const samples = new Int16Array(samplesOf(ms));
  let seed = 7;
  for (let index = 0; index < samples.length; index += 1) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    samples[index] = Math.round((seed / 2_147_483_648 - 0.5) * 40);
  }
  return samples;
};

/** The socket's binary frame for `samples`: little-endian PCM16. */
export const pcmBytes = (samples: Int16Array): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index] ?? 0, true);
  }
  return bytes;
};

/** `samples` cut into the 100 ms frames a browser sends. */
export const framesOf = (samples: Int16Array): Uint8Array<ArrayBuffer>[] => {
  const frames: Uint8Array<ArrayBuffer>[] = [];
  const step = samplesOf(100);
  for (let at = 0; at < samples.length; at += step) {
    frames.push(pcmBytes(samples.slice(at, at + step)));
  }
  return frames;
};
