export interface AudioMetrics {
  integrated: number;
  shortTerm: number;
  momentary: number;
  avgVU: number;
}

export async function analyzeAudio(audioBuffer: AudioBuffer): Promise<AudioMetrics> {
  const offlineCtx = new OfflineAudioContext(
    audioBuffer.numberOfChannels,
    audioBuffer.length,
    audioBuffer.sampleRate
  );
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;

  // K-weighting filters for LUFS
  const highShelf = offlineCtx.createBiquadFilter();
  highShelf.type = 'highshelf';
  highShelf.frequency.value = 1500;
  highShelf.gain.value = 4;

  const highPass = offlineCtx.createBiquadFilter();
  highPass.type = 'highpass';
  highPass.frequency.value = 38;
  highPass.Q.value = 0.5;

  source.connect(highShelf);
  highShelf.connect(highPass);
  highPass.connect(offlineCtx.destination);

  source.start();
  const renderedBuffer = await offlineCtx.startRendering();

  const sampleRate = renderedBuffer.sampleRate;
  const blockSize = Math.floor(sampleRate * 0.4); // 400ms for Momentary/Integrated
  const stepSize = Math.floor(sampleRate * 0.1);  // 100ms step (75% overlap)
  
  const numChannels = renderedBuffer.numberOfChannels;
  const channelData: Float32Array[] = [];
  const rawChannelData: Float32Array[] = [];
  
  for (let c = 0; c < numChannels; c++) {
    channelData.push(renderedBuffer.getChannelData(c));
    rawChannelData.push(audioBuffer.getChannelData(c)); // Raw data for VU
  }

  const blocks: number[] = [];
  const numBlocks = Math.floor((renderedBuffer.length - blockSize) / stepSize) + 1;

  // 1. Calculate Momentary blocks (400ms)
  let momentarySum = 0;
  let momentaryCount = 0;
  const momentaryGate = Math.pow(10, (-70 + 0.691) / 10);

  for (let i = 0; i < numBlocks; i++) {
    const start = i * stepSize;
    let sumSquare = 0;
    for (let c = 0; c < numChannels; c++) {
      let channelSumSquare = 0;
      const data = channelData[c];
      for (let j = 0; j < blockSize; j++) {
        channelSumSquare += data[start + j] * data[start + j];
      }
      sumSquare += channelSumSquare / blockSize;
    }
    blocks.push(sumSquare);
    
    if (sumSquare > momentaryGate) {
      momentarySum += sumSquare;
      momentaryCount++;
    }
  }

  let avgMomentary = -70;
  if (momentaryCount > 0) {
    avgMomentary = -0.691 + 10 * Math.log10(momentarySum / momentaryCount);
  }

  // 2. Calculate Short-term (3s window = 30 blocks of 100ms step)
  let shortTermSum = 0;
  let shortTermCount = 0;
  const shortTermWindow = 30;
  const shortTermGate = Math.pow(10, (-70 + 0.691) / 10);

  for (let i = 0; i <= blocks.length - shortTermWindow; i++) {
    let sum = 0;
    for (let j = 0; j < shortTermWindow; j++) {
      sum += blocks[i + j];
    }
    const avg = sum / shortTermWindow;
    
    if (avg > shortTermGate) {
      shortTermSum += avg;
      shortTermCount++;
    }
  }

  let avgShortTerm = -70;
  if (shortTermCount > 0) {
    avgShortTerm = -0.691 + 10 * Math.log10(shortTermSum / shortTermCount);
  }

  // 3. Calculate Integrated LUFS
  const absoluteThreshold = Math.pow(10, (-70 + 0.691) / 10);
  let absoluteGatedSum = 0;
  let absoluteGatedCount = 0;

  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i] > absoluteThreshold) {
      absoluteGatedSum += blocks[i];
      absoluteGatedCount++;
    }
  }

  let integrated = -70;
  if (absoluteGatedCount > 0) {
    const absoluteGatedMean = absoluteGatedSum / absoluteGatedCount;
    const absoluteGatedLUFS = -0.691 + 10 * Math.log10(absoluteGatedMean);
    const relativeThresholdLUFS = absoluteGatedLUFS - 10;
    const relativeThreshold = Math.pow(10, (relativeThresholdLUFS + 0.691) / 10);

    let relativeGatedSum = 0;
    let relativeGatedCount = 0;

    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i] > relativeThreshold) {
        relativeGatedSum += blocks[i];
        relativeGatedCount++;
      }
    }

    if (relativeGatedCount > 0) {
      const relativeGatedMean = relativeGatedSum / relativeGatedCount;
      integrated = -0.691 + 10 * Math.log10(relativeGatedMean);
    } else {
      integrated = absoluteGatedLUFS;
    }
  }

  // 4. Calculate Average VU (300ms RMS window, no K-weighting, AES-17 compensated)
  const vuBlockSize = Math.floor(sampleRate * 0.3);
  const vuNumBlocks = Math.floor((audioBuffer.length - vuBlockSize) / stepSize) + 1;
  
  const vuLevels: number[] = [];

  for (let i = 0; i < vuNumBlocks; i++) {
    const start = i * stepSize;
    let sumSquare = 0;
    for (let c = 0; c < numChannels; c++) {
      let channelSumSquare = 0;
      const data = rawChannelData[c];
      for (let j = 0; j < vuBlockSize; j++) {
        channelSumSquare += data[start + j] * data[start + j];
      }
      sumSquare += channelSumSquare / vuBlockSize;
    }
    
    const power = sumSquare / numChannels;
    const powerAes17 = power * 2; // AES-17 compensation (+3.01 dB)
    
    if (powerAes17 > 1e-10) {
      vuLevels.push(10 * Math.log10(powerAes17));
    }
  }

  let avgVU = -100;
  if (vuLevels.length > 0) {
    // Sort to find the 95th percentile (represents where the needle typically peaks)
    vuLevels.sort((a, b) => a - b);
    const percentile95Index = Math.floor(vuLevels.length * 0.95);
    const typicalPeakDbfs = vuLevels[percentile95Index];
    
    // 0 VU is traditionally aligned to -18 dBFS
    avgVU = typicalPeakDbfs + 18;
  }

  // Apply user-requested calibrations
  const LUFS_OFFSET = -4.5;

  return {
    integrated: integrated + LUFS_OFFSET,
    shortTerm: avgShortTerm + LUFS_OFFSET,
    momentary: avgMomentary + LUFS_OFFSET,
    avgVU: avgVU
  };
}

export async function applyGain(buffer: AudioBuffer, gain: number): Promise<AudioBuffer> {
  const offlineCtx = new OfflineAudioContext(
    buffer.numberOfChannels,
    buffer.length,
    buffer.sampleRate
  );
  
  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;
  
  const gainNode = offlineCtx.createGain();
  gainNode.gain.value = gain;
  
  source.connect(gainNode);
  gainNode.connect(offlineCtx.destination);
  
  source.start();
  return await offlineCtx.startRendering();
}

export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  
  let result: Float32Array;
  if (numChannels === 2) {
    result = interleave(buffer.getChannelData(0), buffer.getChannelData(1));
  } else {
    result = buffer.getChannelData(0);
  }
  
  const wavBuffer = encodeWAV(result, format, sampleRate, numChannels, bitDepth);
  return new Blob([wavBuffer], { type: 'audio/wav' });
}

function interleave(inputL: Float32Array, inputR: Float32Array): Float32Array {
  const length = inputL.length + inputR.length;
  const result = new Float32Array(length);
  
  let index = 0;
  let inputIndex = 0;
  
  while (index < length) {
    result[index++] = inputL[inputIndex];
    result[index++] = inputR[inputIndex];
    inputIndex++;
  }
  return result;
}

function encodeWAV(samples: Float32Array, format: number, sampleRate: number, numChannels: number, bitDepth: number): ArrayBuffer {
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);
  
  floatTo16BitPCM(view, 44, samples);
  
  return buffer;
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function floatTo16BitPCM(output: DataView, offset: number, input: Float32Array) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
}
