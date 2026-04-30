const dropZone = document.querySelector("#drop-zone");
const fileInput = document.querySelector("#file-input");
const statusEl = document.querySelector("#status");
const resultEl = document.querySelector("#result");
const metaEl = document.querySelector("#meta");

const allowedExtensions = [".stp", ".step"];

function setStatus(message, tone = "neutral") {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function isStepFile(file) {
  const name = file.name.toLowerCase();
  return allowedExtensions.some((ext) => name.endsWith(ext));
}

async function analyzeFile(file) {
  if (!file || !isStepFile(file)) {
    setStatus("Choose a .stp or .step file.", "error");
    return;
  }

  const form = new FormData();
  form.append("file", file);

  setStatus(`Analyzing ${file.name}...`);
  resultEl.textContent = "Working";
  metaEl.textContent = "Evaluating geometry.";

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      body: form,
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "Unable to analyze this STEP file.");
    }

    resultEl.textContent = payload.format;
    setStatus("Analysis complete.", "success");

    if (payload.classification === "cylindrical") {
      metaEl.textContent = "Rounded up to 0.001 in. No machining allowance added.";
    } else {
      metaEl.textContent = "Rounded up to 0.001 in. No machining allowance added.";
    }
  } catch (error) {
    resultEl.textContent = "-.--- X -.--- X -.---";
    metaEl.textContent = "No result.";
    setStatus(error.message, "error");
  }
}

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.dataset.active = "true";
});

dropZone.addEventListener("dragleave", () => {
  dropZone.dataset.active = "false";
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.dataset.active = "false";
  analyzeFile(event.dataTransfer.files[0]);
});

fileInput.addEventListener("change", () => {
  analyzeFile(fileInput.files[0]);
});
