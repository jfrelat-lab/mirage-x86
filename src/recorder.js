// recorder.js — the page's Record button: what the screen shows and what the speakers play, as one
// video file the visitor keeps. The canvas's own stream (every frame the page draws) and the sound
// worklet's output, joined in a MediaRecorder; MP4 (H.264 + AAC) where the browser writes it (Chrome
// 126+, Safari), WebM otherwise. Real time: the recording is what the visitor saw, at the host's speed.
// For a frame-exact video in guest time, tools/record.mjs films a DOS title headless.

const TYPES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];

export const canRecord = () => typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;

/**
 * Starts recording `canvas` (and `audioOut`'s sound, if it is playing). Returns { stop() }: stop()
 * resolves to { blob, ext } once the file is complete.
 */
export function startRecording(canvas, audioOut, fps = 30) {
  const stream = canvas.captureStream(fps);
  let tap = null;
  if (audioOut && audioOut.ctx && audioOut.node) {
    tap = audioOut.ctx.createMediaStreamDestination();
    audioOut.node.connect(tap);
    for (const t of tap.stream.getAudioTracks()) stream.addTrack(t);
  }
  const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8e6, audioBitsPerSecond: 192e3 });
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  rec.start(1000);
  return {
    stop: () => new Promise((res) => {
      rec.onstop = () => {
        for (const t of stream.getTracks()) t.stop();
        if (tap) try { audioOut.node.disconnect(tap); } catch { /* already gone */ }
        const type = rec.mimeType || mimeType || 'video/webm';
        res({ blob: new Blob(parts, { type }), ext: type.startsWith('video/mp4') ? 'mp4' : 'webm' });
      };
      rec.stop();
    }),
  };
}

/** Hands the visitor the file, named after what was running and when. */
export function saveRecording({ blob, ext }, name) {
  const a = document.createElement('a'), stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = URL.createObjectURL(blob);
  a.download = `mirage-${String(name || 'screen').replace(/[^\w.-]+/g, '-')}-${stamp}.${ext}`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
