/** Reads newline-delimited UTF-8 frames without decoding incomplete byte sequences. */
export class RelayFrameReader {
  private chunks: Buffer[] = [];
  private byteLength = 0;

  get bufferedByteLength(): number {
    return this.byteLength;
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;

    this.chunks.push(chunk);
    this.byteLength += chunk.length;
  }

  readFrames(): string[] {
    const frames: string[] = [];
    const frameChunks: Buffer[] = [];
    let frameLength = 0;

    for (const chunk of this.chunks) {
      let start = 0;
      let newline = chunk.indexOf(0x0a, start);

      while (newline >= 0) {
        const part = chunk.subarray(start, newline);
        frameChunks.push(part);
        frameLength += part.length;

        frames.push(Buffer.concat(frameChunks, frameLength).toString('utf8'));
        frameChunks.length = 0;
        frameLength = 0;
        start = newline + 1;
        newline = chunk.indexOf(0x0a, start);
      }

      if (start < chunk.length) {
        const part = chunk.subarray(start);
        frameChunks.push(part);
        frameLength += part.length;
      }
    }

    this.chunks = frameChunks;
    this.byteLength = frameLength;
    return frames;
  }
}
