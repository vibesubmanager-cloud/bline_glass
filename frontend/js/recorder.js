class VoiceRecorder {
  constructor() {
    this.recorder = null;
    this.chunks = [];
    this.stream = null;
    this.recording = false;
  }

  supported() {
    return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }

  pickMime() {
    const types = ["audio/mp4", "audio/aac", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"];
    return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  async start() {
    if (!this.supported()) {
      throw Object.assign(new Error("This phone cannot record a voice note."), { code: "MIC_UNAVAILABLE" });
    }
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    const mime = this.pickMime();
    this.recorder = mime ? new MediaRecorder(this.stream, { mimeType: mime }) : new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (event) => {
      if (event.data?.size) this.chunks.push(event.data);
    };
    try {
      this.recorder.start(250);
    } catch {
      this.recorder.start();
    }
    this.recording = true;
  }

  async stop() {
    if (!this.recorder || !this.recording) return null;
    this.recording = false;
    const recorder = this.recorder;
    const stream = this.stream;
    const file = await new Promise((resolve) => {
      recorder.onstop = () => {
        const type = (recorder.mimeType || "audio/webm").split(";")[0];
        const blob = new Blob(this.chunks, { type });
        const ext = type.includes("mp4") || type.includes("aac") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        resolve(blob.size ? new File([blob], `voice-note.${ext}`, { type }) : null);
      };
      try {
        if (recorder.state === "recording") recorder.requestData();
      } catch {
        /* some browsers throw if idle */
      }
      window.setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, 80);
    });
    stream?.getTracks().forEach((track) => track.stop());
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    return file;
  }

  async cancel() {
    try {
      await this.stop();
    } catch {
      this.stream?.getTracks().forEach((track) => track.stop());
      this.recording = false;
    }
  }
}

export const recorder = new VoiceRecorder();
