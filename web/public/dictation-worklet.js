// The microphone tap for dictation (web/lib/use-dictation.ts): an AudioWorklet that copies the first input channel
// out to the page in blocks of about 40 ms. Resampling to 16 kHz and the PCM16 conversion happen on the page
// (createResampler in web/lib/dictation.ts), where they are tested. Plain JavaScript: worklets load as their own
// module, outside the bundle.
const BLOCK = 2048;

class DictationCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(BLOCK);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel !== undefined) {
      let offset = 0;
      while (offset < channel.length) {
        const count = Math.min(BLOCK - this.filled, channel.length - offset);
        this.buffer.set(channel.subarray(offset, offset + count), this.filled);
        this.filled += count;
        offset += count;
        if (this.filled === BLOCK) {
          const block = this.buffer;
          this.port.postMessage(block, [block.buffer]);
          this.buffer = new Float32Array(BLOCK);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("dictation-capture", DictationCapture);
