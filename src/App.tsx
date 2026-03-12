import React, { useState, useRef, useEffect } from 'react';
import { Upload, Sliders, Play, Download, Trash2, CheckCircle2, Info, Settings2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { analyzeAudio, applyGain, audioBufferToWav, AudioMetrics } from './lib/audioUtils';

type MeasurementType = 'integrated' | 'shortTerm' | 'momentary' | 'vu';
type TargetMode = 'reference' | 'vu18';

interface Track {
  id: string;
  file: File;
  name: string;
  buffer: AudioBuffer;
  metrics: AudioMetrics;
  measurementType: MeasurementType;
  targetOffset: number; // Offset relative to target
  manualGain: number; // Manual gain in dB
  processedUrl?: string;
  processedMetrics?: AudioMetrics;
  isProcessing?: boolean;
}

export default function App() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [targetMode, setTargetMode] = useState<TargetMode>('reference');
  const [referenceTrackId, setReferenceTrackId] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isProcessingAll, setIsProcessingAll] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const getAudioContext = () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    return audioCtxRef.current;
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    setIsAnalyzing(true);
    const ctx = getAudioContext();
    const newTracks: Track[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        const metrics = await analyzeAudio(audioBuffer);
        
        const newTrack: Track = {
          id: Math.random().toString(36).substring(7),
          file,
          name: file.name,
          buffer: audioBuffer,
          metrics,
          measurementType: 'integrated', // Default
          targetOffset: 0,
          manualGain: 0,
        };
        newTracks.push(newTrack);
      } catch (error) {
        console.error(`Error processing ${file.name}:`, error);
        alert(`Failed to analyze ${file.name}. Please ensure it's a valid audio file.`);
      }
    }

    setTracks(prev => {
      const updated = [...prev, ...newTracks];
      if (!referenceTrackId && updated.length > 0) {
        setReferenceTrackId(updated[0].id);
      }
      return updated;
    });
    
    setIsAnalyzing(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeTrack = (id: string) => {
    setTracks(prev => prev.filter(t => t.id !== id));
    if (referenceTrackId === id) {
      setReferenceTrackId(tracks.find(t => t.id !== id)?.id || null);
    }
  };

  const updateTrack = (id: string, updates: Partial<Track>) => {
    setTracks(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
  };

  const getMetricValue = (metrics: AudioMetrics, type: MeasurementType) => {
    switch (type) {
      case 'integrated': return metrics.integrated;
      case 'shortTerm': return metrics.shortTerm;
      case 'momentary': return metrics.momentary;
      case 'vu': return metrics.avgVU;
      default: return metrics.integrated;
    }
  };

  const getExpectedValue = (track: Track) => {
    return getMetricValue(track.metrics, track.measurementType) + track.manualGain;
  };

  const calculateRequiredGain = (track: Track, allTracks: Track[], mode: TargetMode, refId: string | null): number => {
    if (mode === 'reference' && track.id === refId) return track.manualGain;
    
    let targetValue = 0;
    if (mode === 'reference') {
      const refTrack = allTracks.find(t => t.id === refId);
      if (!refTrack) return track.manualGain;
      const refBase = getMetricValue(refTrack.metrics, refTrack.measurementType);
      targetValue = refBase + refTrack.manualGain + track.targetOffset;
    } else {
      targetValue = (track.measurementType === 'vu') ? 0 : -18;
      targetValue += track.targetOffset;
    }
    
    const currentValue = getMetricValue(track.metrics, track.measurementType);
    return targetValue - currentValue;
  };

  const prevDepsRef = useRef<string>('');

  useEffect(() => {
    const refTrack = tracks.find(t => t.id === referenceTrackId);
    const refManualGain = refTrack ? refTrack.manualGain : 0;
    
    const depsString = JSON.stringify({
      targetMode,
      referenceTrackId,
      refManualGain,
      trackSettings: tracks.map(t => ({ id: t.id, type: t.measurementType, offset: t.targetOffset }))
    });
    
    if (depsString !== prevDepsRef.current) {
      prevDepsRef.current = depsString;
      
      setTracks(currentTracks => {
        let changed = false;
        const newTracks = currentTracks.map(track => {
          if (targetMode === 'reference' && track.id === referenceTrackId) return track;
          
          const requiredGain = calculateRequiredGain(track, currentTracks, targetMode, referenceTrackId);
          
          if (Math.abs(track.manualGain - requiredGain) > 0.01) {
            changed = true;
            return { ...track, manualGain: requiredGain, processedUrl: undefined, processedMetrics: undefined };
          }
          return track;
        });
        return changed ? newTracks : currentTracks;
      });
    }
  }, [targetMode, referenceTrackId, tracks]);

  const processTracks = async () => {
    if (targetMode === 'reference' && !referenceTrackId) return;
    
    setIsProcessingAll(true);

    const processedTracks = await Promise.all(tracks.map(async (track) => {
      const totalGainDb = track.manualGain;
      
      if (Math.abs(totalGainDb) < 0.1) {
        const wavBlob = audioBufferToWav(track.buffer);
        return {
          ...track,
          processedUrl: URL.createObjectURL(wavBlob),
          processedMetrics: track.metrics
        };
      }

      const linearGain = Math.pow(10, totalGainDb / 20);
      const newBuffer = await applyGain(track.buffer, linearGain);
      
      // Calculate new metrics mathematically instead of re-analyzing.
      // Re-analyzing heavily attenuated audio causes the quiet parts to fall below 
      // the absolute gates (-70 LUFS / -60 dBFS), artificially inflating the average.
      const newMetrics: AudioMetrics = {
        integrated: track.metrics.integrated + totalGainDb,
        shortTerm: track.metrics.shortTerm + totalGainDb,
        momentary: track.metrics.momentary + totalGainDb,
        avgVU: track.metrics.avgVU + totalGainDb,
      };
      
      const wavBlob = audioBufferToWav(newBuffer);
      
      return {
        ...track,
        processedUrl: URL.createObjectURL(wavBlob),
        processedMetrics: newMetrics
      };
    }));

    setTracks(processedTracks);
    setIsProcessingAll(false);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30 pb-20">
      <div className="max-w-5xl mx-auto px-6 py-12">
        
        {/* Header */}
        <header className="mb-12 text-center">
          <motion.div 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="inline-flex items-center justify-center p-3 bg-zinc-900 rounded-2xl mb-6 shadow-xl shadow-black/50 border border-zinc-800"
          >
            <Sliders className="w-8 h-8 text-emerald-400" />
          </motion.div>
          <motion.h1 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1 }}
            className="text-4xl md:text-5xl font-bold tracking-tight mb-4"
          >
            Auto Gain Staging
          </motion.h1>
          <motion.p 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="text-zinc-400 max-w-2xl mx-auto text-lg"
          >
            Upload multi-tracks, select measurement targets (LUFS/VU), and apply automatic or manual gain matching.
          </motion.p>
        </header>

        {/* Global Settings & Upload Area */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="mb-8 grid md:grid-cols-3 gap-6"
        >
          <div className="md:col-span-2">
            <div 
              onClick={() => fileInputRef.current?.click()}
              className="h-full border-2 border-dashed border-zinc-800 hover:border-emerald-500/50 bg-zinc-900/50 rounded-3xl p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-all duration-300 group"
            >
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileUpload} 
                multiple 
                accept="audio/*" 
                className="hidden" 
              />
              <div className="bg-zinc-800 group-hover:bg-emerald-500/20 w-14 h-14 rounded-full flex items-center justify-center mb-4 transition-colors">
                <Upload className="w-6 h-6 text-zinc-400 group-hover:text-emerald-400 transition-colors" />
              </div>
              <h3 className="text-lg font-semibold mb-1">Drop audio files here</h3>
              <p className="text-sm text-zinc-500">or click to browse</p>
              {isAnalyzing && (
                <div className="mt-4 flex items-center justify-center text-emerald-400 text-sm">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2"></div>
                  Analyzing Audio...
                </div>
              )}
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 flex flex-col justify-center">
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Settings2 className="w-5 h-5 text-emerald-400" />
              Global Target Mode
            </h3>
            <div className="space-y-3">
              <label className="flex items-center gap-3 p-3 rounded-xl border border-zinc-800 bg-zinc-950/50 cursor-pointer hover:border-emerald-500/50 transition-colors">
                <input 
                  type="radio" 
                  name="targetMode" 
                  checked={targetMode === 'reference'}
                  onChange={() => setTargetMode('reference')}
                  className="text-emerald-500 focus:ring-emerald-500 bg-zinc-800 border-zinc-700"
                />
                <div>
                  <div className="font-medium text-sm">Match Reference Track</div>
                  <div className="text-xs text-zinc-500">Align all tracks to a selected reference</div>
                </div>
              </label>
              <label className="flex items-center gap-3 p-3 rounded-xl border border-zinc-800 bg-zinc-950/50 cursor-pointer hover:border-emerald-500/50 transition-colors">
                <input 
                  type="radio" 
                  name="targetMode" 
                  checked={targetMode === 'vu18'}
                  onChange={() => setTargetMode('vu18')}
                  className="text-emerald-500 focus:ring-emerald-500 bg-zinc-800 border-zinc-700"
                />
                <div>
                  <div className="font-medium text-sm">Fixed: 0 VU (-18 dBFS)</div>
                  <div className="text-xs text-zinc-500">Standard 18dB headroom target</div>
                </div>
              </label>
            </div>
          </div>
        </motion.div>

        {/* Track List */}
        {tracks.length > 0 && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="bg-zinc-900 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl"
          >
            <div className="p-6 border-b border-zinc-800 flex justify-between items-center bg-zinc-900/80 backdrop-blur-sm sticky top-0 z-10">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <Play className="w-5 h-5 text-emerald-400" />
                Tracks ({tracks.length})
              </h2>
              <button
                onClick={processTracks}
                disabled={isProcessingAll || (targetMode === 'reference' && !referenceTrackId)}
                className="bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold py-2.5 px-6 rounded-full transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isProcessingAll ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-zinc-950"></div>
                    Processing...
                  </>
                ) : (
                  <>
                    <Sliders className="w-4 h-4" />
                    Process All
                  </>
                )}
              </button>
            </div>

            <div className="divide-y divide-zinc-800/50">
              <AnimatePresence>
                {tracks.map((track) => {
                  const isRef = targetMode === 'reference' && referenceTrackId === track.id;
                  const metricsToDisplay = track.processedMetrics || track.metrics;
                  
                  return (
                    <motion.div 
                      key={track.id}
                      layout
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className={`p-6 transition-colors ${isRef ? 'bg-zinc-800/30' : 'hover:bg-zinc-800/20'}`}
                    >
                      <div className="flex flex-col xl:flex-row gap-6">
                        
                        {/* Track Info & Metrics */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-3 mb-3">
                            <h3 className="font-medium text-lg truncate" title={track.name}>
                              {track.name}
                            </h3>
                            {isRef && (
                              <span className="px-2.5 py-1 bg-emerald-500/10 text-emerald-400 text-xs font-medium rounded-full border border-emerald-500/20">
                                Reference
                              </span>
                            )}
                            {track.processedUrl && (
                              <span className="flex items-center gap-1 text-emerald-400 text-xs font-medium">
                                <CheckCircle2 className="w-3.5 h-3.5" /> Processed
                              </span>
                            )}
                          </div>
                          
                          {/* Metrics Grid */}
                          <div className="grid grid-cols-4 gap-2 text-xs font-mono bg-zinc-950 p-3 rounded-xl border border-zinc-800">
                            <div className="flex flex-col">
                              <span className="text-zinc-500 mb-1">Integrated</span>
                              <span className={track.measurementType === 'integrated' ? 'text-emerald-400' : 'text-zinc-300'}>
                                {metricsToDisplay.integrated.toFixed(1)} LUFS
                              </span>
                            </div>
                            <div className="flex flex-col">
                              <span className="text-zinc-500 mb-1">Short-Term</span>
                              <span className={track.measurementType === 'shortTerm' ? 'text-emerald-400' : 'text-zinc-300'}>
                                {metricsToDisplay.shortTerm.toFixed(1)} LUFS
                              </span>
                            </div>
                            <div className="flex flex-col">
                              <span className="text-zinc-500 mb-1">Momentary</span>
                              <span className={track.measurementType === 'momentary' ? 'text-emerald-400' : 'text-zinc-300'}>
                                {metricsToDisplay.momentary.toFixed(1)} LUFS
                              </span>
                            </div>
                            <div className="flex flex-col">
                              <span className="text-zinc-500 mb-1">Avg VU</span>
                              <span className={track.measurementType === 'vu' ? 'text-emerald-400' : 'text-zinc-300'}>
                                {metricsToDisplay.avgVU.toFixed(1)} dBFS
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Controls */}
                        <div className="flex flex-col gap-3 xl:w-[480px] shrink-0">
                          
                          <div className="flex items-center gap-3 bg-zinc-950 p-2.5 rounded-xl border border-zinc-800">
                            {/* Reference Radio */}
                            {targetMode === 'reference' && (
                              <label className="flex items-center gap-2 text-sm cursor-pointer px-2 border-r border-zinc-800 pr-4">
                                <input
                                  type="radio"
                                  name="referenceTrack"
                                  checked={isRef}
                                  onChange={() => setReferenceTrackId(track.id)}
                                  className="text-emerald-500 focus:ring-emerald-500 bg-zinc-800 border-zinc-700"
                                />
                                Set Ref
                              </label>
                            )}

                            {/* Measurement Type */}
                            <div className="flex items-center gap-2 flex-1">
                              <span className="text-xs text-zinc-500 whitespace-nowrap">Measure:</span>
                              <select 
                                value={track.measurementType}
                                onChange={(e) => updateTrack(track.id, { measurementType: e.target.value as MeasurementType })}
                                className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1 text-sm text-zinc-300 focus:outline-none focus:border-emerald-500 w-full"
                              >
                                <option value="integrated">Integrated LUFS</option>
                                <option value="shortTerm">Short-Term LUFS</option>
                                <option value="momentary">Momentary LUFS</option>
                                <option value="vu">Avg VU</option>
                              </select>
                            </div>

                            {/* Offset */}
                            {!isRef && (
                              <div className="flex items-center gap-2 border-l border-zinc-800 pl-3">
                                <span className="text-xs text-zinc-500">Offset:</span>
                                <input
                                  type="number"
                                  value={track.targetOffset}
                                  onChange={(e) => {
                                    updateTrack(track.id, { 
                                      targetOffset: parseFloat(e.target.value) || 0,
                                      processedUrl: undefined,
                                      processedMetrics: undefined
                                    });
                                  }}
                                  onClick={(e) => {
                                    if (e.altKey) {
                                      updateTrack(track.id, { 
                                        targetOffset: 0,
                                        processedUrl: undefined,
                                        processedMetrics: undefined
                                      });
                                    }
                                  }}
                                  step="0.5"
                                  className="w-16 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1 text-sm text-center focus:outline-none focus:border-emerald-500"
                                  title="Alt/Option + Click to reset to 0"
                                />
                              </div>
                            )}
                          </div>

                          {/* Manual Gain */}
                          <div className="flex flex-col gap-2 bg-zinc-950 p-3 rounded-xl border border-zinc-800">
                            <div className="flex items-center gap-4">
                              <span className="text-xs text-zinc-500 whitespace-nowrap w-20">Manual Gain:</span>
                              <input 
                                type="range" 
                                min="-40" 
                                max="40" 
                                step="0.1" 
                                value={track.manualGain}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  updateTrack(track.id, { 
                                    manualGain: isNaN(val) ? 0 : val,
                                    processedUrl: undefined,
                                    processedMetrics: undefined
                                  });
                                }}
                                onClick={(e) => {
                                  if (e.altKey) {
                                    updateTrack(track.id, { 
                                      manualGain: 0,
                                      processedUrl: undefined,
                                      processedMetrics: undefined
                                    });
                                  }
                                }}
                                className="flex-1 accent-emerald-500"
                                title="Alt/Option + Click to reset to 0"
                              />
                              <div className="w-16 text-right">
                                <span className="text-sm font-mono text-emerald-400">
                                  {track.manualGain > 0 ? '+' : ''}{track.manualGain.toFixed(1)}
                                </span>
                                <span className="text-xs text-zinc-500 ml-1">dB</span>
                              </div>
                            </div>
                            <div className="flex items-center justify-between px-1 pt-1 border-t border-zinc-800/50">
                              <span className="text-xs text-zinc-500">Expected Target:</span>
                              <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded">
                                {getExpectedValue(track).toFixed(1)} {track.measurementType === 'vu' ? 'VU' : 'LUFS'}
                              </span>
                            </div>
                          </div>

                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-2 xl:flex-col justify-center">
                          {track.processedUrl ? (
                            <a
                              href={track.processedUrl}
                              download={`GainStaged_${track.name}`}
                              className="p-3 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-zinc-950 rounded-xl transition-colors"
                              title="Download Processed Track"
                            >
                              <Download className="w-5 h-5" />
                            </a>
                          ) : (
                            <div className="w-11 h-11"></div> // Placeholder
                          )}

                          <button
                            onClick={() => removeTrack(track.id)}
                            className="p-3 text-zinc-500 hover:text-red-400 hover:bg-red-400/10 rounded-xl transition-colors"
                            title="Remove Track"
                          >
                            <Trash2 className="w-5 h-5" />
                          </button>
                        </div>

                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          </motion.div>
        )}

      </div>
    </div>
  );
}
