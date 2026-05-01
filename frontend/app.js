const dropZone = document.querySelector("#drop-zone");
const fileInput = document.querySelector("#file-input");
const statusEl = document.querySelector("#status");
const resultEl = document.querySelector("#result");
const metaEl = document.querySelector("#meta");
const unitToggle = document.querySelector("#unit-toggle");
const resultUnitEl = document.querySelector("#result-unit");
const detectedMaterialEl = document.querySelector("#detected-material");
const materialBetaNoticeEl = document.querySelector(".material-beta-notice");

const allowedExtensions = [".stp", ".step"];

let currentUnit = "in";
let lastPayload = null;

function ceilTo(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.ceil(value * factor) / factor;
}

function formatResult(payload) {
  if (currentUnit === "mm") {
    if (payload.classification === "cylindrical") {
      const dia = ceilTo(payload.diameter_mm, 2).toFixed(2);
      const len = ceilTo(payload.length_mm, 2).toFixed(2);
      return `DIA ${dia} X ${len}`;
    }
    const l = ceilTo(payload.length_mm, 2).toFixed(2);
    const w = ceilTo(payload.width_mm, 2).toFixed(2);
    const h = ceilTo(payload.height_mm, 2).toFixed(2);
    return `${l} X ${w} X ${h}`;
  }
  return payload.format;
}

function setUnit(unit) {
  currentUnit = unit;
  const label = unit === "mm" ? "MM" : "IN";
  unitToggle.textContent = label;
  resultUnitEl.textContent = label;
  metaEl.textContent = unit === "mm"
    ? "Rounded up to 0.01 mm. No machining allowance added."
    : "Rounded up to 0.001 in. No machining allowance added.";
  if (lastPayload) {
    resultEl.textContent = formatResult(lastPayload);
  }
}

function setStatus(message, tone = "neutral") {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function isStepFile(file) {
  const name = file.name.toLowerCase();
  return allowedExtensions.some((ext) => name.endsWith(ext));
}

async function analyzeFile(file) {
  if (!file) {
    return;
  }

  if (!isStepFile(file)) {
    setStatus(`"${file.name}" is not a STEP file. Choose a .stp or .step file.`, "error");
    return;
  }

  if (file.size >= 10 * 1024 * 1024) {
    setStatus("File must be smaller than 10 MB.", "error");
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

    lastPayload = payload;
    resultEl.textContent = formatResult(payload);
    setStatus("Analysis complete.", "success");
    metaEl.textContent = currentUnit === "mm"
      ? "Oriented bounding box, rounded up to 0.01 mm. No machining allowance added."
      : "Oriented bounding box, rounded up to 0.001 in. No machining allowance added.";
    detectedMaterialEl.textContent = payload.detected_material
      ? `Material: ${payload.detected_material}`
      : "Material type cannot be detected from this file.";
    materialBetaNoticeEl.hidden = !payload.detected_material;
  } catch (error) {
    resultEl.textContent = "-.--- X -.--- X -.---";
    metaEl.textContent = "No result.";
    detectedMaterialEl.textContent = "";
    materialBetaNoticeEl.hidden = true;
    setStatus(error.message, "error");
  }
}

unitToggle.addEventListener("click", () => {
  setUnit(currentUnit === "in" ? "mm" : "in");
});

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
