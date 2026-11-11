import { describe, expect, it } from 'vitest';

import { RelayFrameReader } from '../../src/relay/frame-reader.js';

describe('RelayFrameReader', () => {
  it.each([
    { label: '4-byte UTF-8 character', character: '🙂' },
    { label: '3-byte UTF-8 character', character: '東' },
    { label: '2-byte UTF-8 character', character: 'é' },
  ])('keeps a split $label intact', ({ character }) => {
    const reader = new RelayFrameReader();
    const frame = Buffer.from(`hello ${character}\n`, 'utf8');
    const splitAt = frame.indexOf(Buffer.from(character, 'utf8')) + 1;

    reader.append(frame.subarray(0, splitAt));
    expect(reader.readFrames()).toEqual([]);
    expect(reader.bufferedByteLength).toBe(splitAt);

    reader.append(frame.subarray(splitAt));
    expect(reader.readFrames()).toEqual([`hello ${character}`]);
    expect(reader.bufferedByteLength).toBe(0);
  });

  it('reads frames delivered byte by byte', () => {
    const reader = new RelayFrameReader();
    const frame = Buffer.from('namaste  café 東京\n', 'utf8');
    const frames: string[] = [];

    for (let index = 0; index < frame.length; index += 1) {
      reader.append(frame.subarray(index, index + 1));
      frames.push(...reader.readFrames());
    }

    expect(frames).toEqual(['namaste  café 東京']);
    expect(reader.bufferedByteLength).toBe(0);
  });

  it('reads multiple frames and preserves empty lines', () => {
    const reader = new RelayFrameReader();

    reader.append(Buffer.from('first\n\nthird\n', 'utf8'));

    expect(reader.readFrames()).toEqual(['first', '', 'third']);
    expect(reader.bufferedByteLength).toBe(0);
  });

  it('keeps a trailing partial frame for the next chunk', () => {
    const reader = new RelayFrameReader();

    reader.append(Buffer.from('first\ntrailing', 'utf8'));
    expect(reader.readFrames()).toEqual(['first']);
    expect(reader.bufferedByteLength).toBe(Buffer.byteLength('trailing', 'utf8'));

    reader.append(Buffer.from(' tail\nnext', 'utf8'));
    expect(reader.readFrames()).toEqual(['trailing tail']);
    expect(reader.bufferedByteLength).toBe(Buffer.byteLength('next', 'utf8'));
  });

  it('keeps bytes buffered when no newline has arrived', () => {
    const reader = new RelayFrameReader();

    reader.append(Buffer.from('incomplete frame', 'utf8'));

    expect(reader.readFrames()).toEqual([]);
    expect(reader.bufferedByteLength).toBe(Buffer.byteLength('incomplete frame', 'utf8'));
  });
});
