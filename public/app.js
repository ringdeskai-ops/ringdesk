// ── CloneVoice front-end demo ─────────────────────────────────────────────
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ── Hero waveform (decorative) ──────────────────────────────────────────
  (function buildWave() {
    const host = document.getElementById("waveBars");
    if (!host) return;
    const N = 56;
    for (let i = 0; i < N; i++) {
      const s = document.createElement("span");
      s.style.animationDelay = (i * 35) + "ms";
      s.style.height = (15 + Math.random() * 70) + "%";
      host.appendChild(s);
    }
  })();

  // Footer year
  const yr = document.getElementById("year");
  if (yr) yr.textContent = new Date().getFullYear();

  // ── Demo state ──────────────────────────────────────────────────────────
  const state = {
    step: 1,
    file: null,
    recording: null,
    mediaRecorder: null,
    chunks: [],
  };

  function gotoStep(n) {
    state.step = n;
    $$(".step").forEach((el) => el.classList.toggle("step--active", Number(el.dataset.step) === n));
    $$(".panel").forEach((el) => el.classList.toggle("panel--active", Number(el.dataset.panel) === n));
  }

  // ── Step 1: upload / drop / record ──────────────────────────────────────
  const drop = $("#drop");
  const fileInput = $("#audioFile");
  const dropFile = $("#dropFile");
  const toStep2 = $("#toStep2");
  const recordBtn = $("#recordBtn");

  function setSample(fileOrBlob, name) {
    state.file = fileOrBlob;
    dropFile.hidden = false;
    const size = (fileOrBlob.size / 1024 / 1024).toFixed(2);
    dropFile.textContent = `${name} · ${size} MB — ready`;
    toStep2.disabled = false;
  }

  drop.addEventListener("click", () => fileInput.click());
  ["dragenter", "dragover"].forEach((evt) =>
    drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.add("drop--active"); })
  );
  ["dragleave", "drop"].forEach((evt) =>
    drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.remove("drop--active"); })
  );
  drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files?.[0];
    if (f && f.type.startsWith("audio")) setSample(f, f.name);
  });
  fileInput.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) setSample(f, f.name);
  });

  recordBtn.addEventListener("click", async () => {
    if (state.mediaRecorder && state.mediaRecorder.state === "recording") {
      state.mediaRecorder.stop();
      recordBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="6" fill="#ef4444"/></svg> Record with microphone`;
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      state.chunks = [];
      mr.ondataavailable = (e) => state.chunks.push(e.data);
      mr.onstop = () => {
        const blob = new Blob(state.chunks, { type: "audio/webm" });
        setSample(blob, "microphone-recording.webm");
        stream.getTracks().forEach((t) => t.stop());
      };
      mr.start();
      state.mediaRecorder = mr;
      recordBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18"><rect x="6" y="6" width="12" height="12" fill="#ef4444"/></svg> Stop recording`;
    } catch (err) {
      alert("Microphone access denied: " + err.message);
    }
  });

  toStep2.addEventListener("click", () => gotoStep(2));

  // ── Step 2: text input ──────────────────────────────────────────────────
  const textInput = $("#textInput");
  const charCount = $("#charCount");
  const MAX = 600;
  textInput.addEventListener("input", () => {
    if (textInput.value.length > MAX) textInput.value = textInput.value.slice(0, MAX);
    charCount.textContent = `${textInput.value.length} / ${MAX} characters`;
  });

  $$(".preset").forEach((btn) => {
    const samples = {
      "Podcast intro": "Welcome back to the show. I'm your host, and today we're diving into something extraordinary — how AI is reshaping the way we create, communicate, and connect.",
      "Audiobook narration": "It was the best of times, it was the worst of times. The air was thick with the scent of lilac, and the distant hum of the city drifted through the open window like a lullaby.",
      "YouTube voiceover": "What if I told you that everything you think you know about productivity is wrong? Stick around — because in the next three minutes, I'm going to change how you work forever.",
      "Birthday message": "Happy birthday! I can't believe another year has flown by. I hope today is filled with laughter, cake, and every good thing you deserve. Love you always.",
    };
    btn.addEventListener("click", () => {
      textInput.value = samples[btn.textContent] || "";
      textInput.dispatchEvent(new Event("input"));
    });
  });

  $$("[data-back]").forEach((b) =>
    b.addEventListener("click", () => gotoStep(Number(b.dataset.back)))
  );

  // ── Step 3: generate ────────────────────────────────────────────────────
  const generateBtn = $("#generate");
  const resultStatus = $("#resultStatus");
  const resultWave = $("#resultWave");
  const resultAudio = $("#resultAudio");
  const resultActions = $("#resultActions");
  const downloadBtn = $("#downloadBtn");
  const againBtn = $("#againBtn");

  function buildResultWave() {
    resultWave.innerHTML = "";
    for (let i = 0; i < 64; i++) {
      const s = document.createElement("span");
      s.style.animationDelay = (i * 25) + "ms";
      s.style.height = (20 + Math.random() * 70) + "%";
      resultWave.appendChild(s);
    }
  }

  generateBtn.addEventListener("click", async () => {
    if (!state.file) { alert("Please upload a voice sample first."); return; }
    const text = textInput.value.trim();
    if (!text) { alert("Please enter some text."); return; }

    gotoStep(3);
    resultStatus.textContent = "Uploading sample and adapting the voice…";
    buildResultWave();
    resultAudio.hidden = true;
    resultActions.hidden = true;

    try {
      const fd = new FormData();
      fd.append("sample", state.file, state.file.name || "sample.webm");
      fd.append("text", text);
      fd.append("language", $("#language").value);

      const res = await fetch("/api/voice/clone", { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Request failed (${res.status})`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      resultAudio.src = url;
      downloadBtn.href = url;
      resultAudio.hidden = false;
      resultActions.hidden = false;
      resultStatus.textContent = "✓ Your cloned voice is ready";
    } catch (err) {
      resultStatus.textContent = "Error: " + err.message;
    }
  });

  againBtn.addEventListener("click", () => {
    state.file = null;
    dropFile.hidden = true;
    toStep2.disabled = true;
    textInput.value = "";
    charCount.textContent = `0 / ${MAX} characters`;
    gotoStep(1);
  });
})();
