/**
 * WHEP-style WebRTC player for the AiROS media pipeline (MediaMTX behind
 * the backend proxy at POST /api/v1/va/webrtc).
 *
 * The browser POSTs its SDP offer to the backend with the short-lived
 * stream token in `Authorization` — the backend validates it, forwards the
 * offer to MediaMTX's WHEP endpoint, and returns the SDP answer plus the
 * WHEP session resource (X-WHEP-Resource) which this player DELETES on
 * teardown so MediaMTX (and upstream go2rtc, and the camera pull) frees
 * the reader immediately.
 *
 * Lifecycle safety: every async stage checks a generation counter so a
 * stale start()/stop() can never touch the video element, set state, or
 * leak a peer connection. Incoming tracks land in a pending MediaStream
 * that attaches whenever the video element is actually available — which
 * fixes the "Cannot read properties of null (reading 'srcObject')" crash
 * when ontrack fires before/without a mounted element.
 */

export interface PlayerCallbacks {
  /** ICE moved to 'failed' mid-play — player is dead, caller may retry. */
  onIceFailed?: () => void;
  /** First decoded/rendered frame (loadeddata / requestVideoFrameCallback). */
  onFirstFrame?: () => void;
  /** Per-stage timing marks: 'offer' | 'sdp' | 'ice' | 'first_frame' (ms since start). */
  onStage?: (stage: string, ms: number) => void;
}

const ICE_GATHER_BUDGET_MS = 1000;

export class Go2rtcPlayer {
  private pc: RTCPeerConnection | null = null;
  private whepUrl: string | null = null;
  private whepResource: string | null = null;
  private token: string | null = null;
  private stream = new MediaStream();
  private getVideo: (() => HTMLVideoElement | null) | null = null;
  private abort: AbortController | null = null;
  private generation = 0;
  private t0 = 0;
  private iceFailedFired = false;
  private firstFrameFired = false;
  private iceReported = false;
  private cb: PlayerCallbacks = {};
  private boundAttach = () => this.attach();
  private boundFirstFrame = () => this.markFirstFrame();

  /**
   * Connect and attach the remote stream to the element returned by
   * `getVideo` (evaluated lazily — the element may mount after start).
   * Resolves when the SDP exchange completes; rejects on failure.
   */
  async start(
    webrtcUrl: string,
    getVideo: () => HTMLVideoElement | null,
    token: string,
    cb: PlayerCallbacks = {}
  ): Promise<void> {
    this.stop();
    const gen = ++this.generation;
    this.t0 = performance.now();
    this.cb = cb;
    this.whepUrl = webrtcUrl;
    this.token = token;
    this.getVideo = getVideo;
    this.stream = new MediaStream();

    const pc = new RTCPeerConnection({
      iceServers: [], // LAN/direct — camera networks typically need no STUN
    });
    this.pc = pc;

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = (ev) => {
      if (gen !== this.generation) return;
      const tracks = ev.streams?.[0]?.getTracks() ?? (ev.track ? [ev.track] : []);
      for (const t of tracks) {
        if (!this.stream.getTracks().includes(t)) this.stream.addTrack(t);
      }
      this.attach();
    };
    pc.oniceconnectionstatechange = () => {
      if (gen !== this.generation) return;
      const s = pc.iceConnectionState;
      if ((s === 'connected' || s === 'completed') && !this.iceReported) {
        this.iceReported = true;
        this.mark('ice');
      }
      if (s === 'failed' && !this.iceFailedFired) {
        this.iceFailedFired = true;
        this.cb.onIceFailed?.();
      }
    };

    const offer = await pc.createOffer();
    if (gen !== this.generation) return;
    await pc.setLocalDescription(offer);
    this.mark('offer');

    // Wait briefly for ICE candidates to gather into the offer SDP —
    // host-only candidates complete fast; the budget just bounds the wait.
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const timer = setTimeout(resolve, ICE_GATHER_BUDGET_MS);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    if (gen !== this.generation) return;

    this.abort = new AbortController();
    const res = await fetch(webrtcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sdp',
        Authorization: `Bearer ${token}`,
      },
      body: pc.localDescription?.sdp ?? '',
      signal: this.abort.signal,
    });
    if (gen !== this.generation) return;
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 160);
      throw new Error(
        `WebRTC negotiate failed (${res.status})${detail ? ` — ${detail}` : ''}`
      );
    }
    this.whepResource = res.headers.get('X-WHEP-Resource');
    const answer = await res.text();
    if (gen !== this.generation) return;
    this.mark('sdp');
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    if (gen !== this.generation) return;
    this.attach();
  }

  /** Attach the pending stream to the video element when it exists. */
  private attach(): void {
    const v = this.getVideo?.();
    if (!v || this.stream.getTracks().length === 0) return;
    if (v.srcObject !== this.stream) {
      v.srcObject = this.stream;
      v.play().catch(() => undefined);
    }
    v.removeEventListener('loadeddata', this.boundFirstFrame);
    v.addEventListener('loadeddata', this.boundFirstFrame, { once: true });
    const anyVideo = v as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    anyVideo.requestVideoFrameCallback?.(this.boundFirstFrame);
  }

  private mark(stage: string): void {
    this.cb.onStage?.(stage, Math.round(performance.now() - this.t0));
  }

  private markFirstFrame(): void {
    if (this.firstFrameFired) return;
    this.firstFrameFired = true;
    this.mark('first_frame');
    this.cb.onFirstFrame?.();
  }

  /** Re-evaluate the video element — call after the element (re)mounts. */
  reattach(): void {
    this.attach();
  }

  stop(): void {
    this.generation++; // every pending async stage no-ops
    if (this.whepUrl && this.whepResource && this.token) {
      const url = `${this.whepUrl}?resource=${encodeURIComponent(this.whepResource)}`;
      fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.token}` },
        keepalive: true, // survives page unload
      }).catch(() => undefined);
    }
    this.whepUrl = null;
    this.whepResource = null;
    this.token = null;
    this.getVideo = null;
    this.abort?.abort();
    this.abort = null;
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }
    for (const t of this.stream.getTracks()) {
      t.stop();
      this.stream.removeTrack(t);
    }
  }
}

/**
 * Attach an HLS stream to a video element. Uses native HLS where supported
 * (Safari), hls.js elsewhere. Returns a cleanup function.
 */
export async function attachHls(
  hlsUrl: string,
  video: HTMLVideoElement
): Promise<() => void> {
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = hlsUrl;
    await video.play().catch(() => undefined);
    return () => {
      video.src = '';
    };
  }
  const { default: Hls } = await import('hls.js');
  if (!Hls.isSupported()) throw new Error('HLS is not supported in this browser');
  const hls = new Hls({
    lowLatencyMode: true,
    // MediaMTX's HLS uses a cookie-check redirect — the playlist fetch must
    // carry cookies cross-origin or it redirects forever.
    xhrSetup: (xhr) => {
      xhr.withCredentials = true;
    },
  });
  hls.loadSource(hlsUrl);
  hls.attachMedia(video);
  await video.play().catch(() => undefined);
  return () => hls.destroy();
}
