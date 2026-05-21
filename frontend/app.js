const dropZone = document.querySelector("#drop-zone");
const fileInput = document.querySelector("#file-input");
const statusEl = document.querySelector("#status");
const resultEl = document.querySelector("#result");
const metaEl = document.querySelector("#meta");
const unitToggle = document.querySelector("#unit-toggle");
const resultUnitEl = document.querySelector("#result-unit");
const detectedMaterialEl = document.querySelector("#detected-material");
const materialBetaNoticeEl = document.querySelector(".material-beta-notice");
const viewerWorkbenchEl = document.querySelector(".viewer-workbench");
const viewerEl = document.querySelector("#viewer");
const partListEl = document.querySelector("#part-list");
const selectAllPartsButton = document.querySelector("#select-all-parts");

const allowedExtensions = [".stp", ".step"];
const mmToInch = 1.0 / 25.4;
const extensionAsyncResponseError = "A listener indicated an asynchronous response by returning true";

let currentUnit = "in";
let lastPayload = null;
let embeddedViewer = null;
let modelRootNode = null;
let disabledNodeIds = new Set();
let hierarchyEntries = [];
let loadToken = 0;

function ceilTo(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.ceil(value * factor) / factor;
}

function formatResult(payload) {
  if (currentUnit === "mm") {
    if (payload.classification === "cylindrical") {
      const dia = ceilTo(payload.diameter_mm, 2).toFixed(2);
      const len = ceilTo(payload.length_mm, 2).toFixed(2);
      if (payload.inner_diameter_mm) {
        const id = ceilTo(payload.inner_diameter_mm, 2).toFixed(2);
        return `OD ${dia} X ID ${id} X ${len}`;
      }
      return `DIA ${dia} X ${len}`;
    }
    const l = ceilTo(payload.length_mm, 2).toFixed(2);
    const w = ceilTo(payload.width_mm, 2).toFixed(2);
    const h = ceilTo(payload.height_mm, 2).toFixed(2);
    return `${l} X ${w} X ${h}`;
  }
  return payload.format;
}

function setResultMeta(payload) {
  if (payload?.details?.bounding === "Selected visible viewer geometry; excluded hierarchy items are omitted.") {
    metaEl.textContent = currentUnit === "mm"
      ? "Visible selected geometry, rounded up to 0.01 mm. No machining allowance added."
      : "Visible selected geometry, rounded up to 0.001 in. No machining allowance added.";
    return;
  }
  metaEl.textContent = currentUnit === "mm"
    ? "Axis-aligned bounding box, rounded up to 0.01 mm. No machining allowance added."
    : "Axis-aligned bounding box, rounded up to 0.001 in. No machining allowance added.";
}

function formatPrismaticIn(lengthMm, widthMm, heightMm) {
  const length = ceilTo(lengthMm * mmToInch, 3).toFixed(3);
  const width = ceilTo(widthMm * mmToInch, 3).toFixed(3);
  const height = ceilTo(heightMm * mmToInch, 3).toFixed(3);
  return `${length} X ${width} X ${height}`;
}

function setUnit(unit) {
  currentUnit = unit;
  const label = unit === "mm" ? "MM" : "IN";
  unitToggle.textContent = label;
  resultUnitEl.textContent = label;
  if (lastPayload) {
    resultEl.textContent = formatResult(lastPayload);
    setResultMeta(lastPayload);
  } else {
    metaEl.textContent = unit === "mm"
      ? "Rounded up to 0.01 mm. No machining allowance added."
      : "Rounded up to 0.001 in. No machining allowance added.";
  }
}

function setStatus(message, tone = "neutral") {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function isExtensionAsyncResponseError(error) {
  const message = typeof error === "string" ? error : error?.message;
  return Boolean(message?.includes(extensionAsyncResponseError));
}

function showAnalyzeError(error) {
  resetSelectionUi();
  resultEl.textContent = "-.--- X -.--- X -.---";
  metaEl.textContent = "No result.";
  detectedMaterialEl.textContent = "";
  materialBetaNoticeEl.hidden = true;
  setStatus(error?.message || "Unable to analyze this STEP file.", "error");
}

function isStepFile(file) {
  const name = file.name.toLowerCase();
  return allowedExtensions.some((ext) => name.endsWith(ext));
}

function resetSelectionUi() {
  modelRootNode = null;
  disabledNodeIds = new Set();
  hierarchyEntries = [];
  partListEl.replaceChildren();
  viewerWorkbenchEl.hidden = true;
}

function resetViewer() {
  if (embeddedViewer) {
    embeddedViewer.Destroy();
    embeddedViewer = null;
  }
  viewerEl.replaceChildren();
  resetSelectionUi();
}

function nodeMeshCount(node) {
  let count = node.MeshIndexCount();
  for (const child of node.GetChildNodes()) {
    count += nodeMeshCount(child);
  }
  return count;
}

function setNodeSubtreeDisabled(node, isDisabled) {
  if (isDisabled) {
    disabledNodeIds.add(node.GetId());
  } else {
    disabledNodeIds.delete(node.GetId());
  }
  for (const child of node.GetChildNodes()) {
    setNodeSubtreeDisabled(child, isDisabled);
  }
}

function enableNodeAncestors(node) {
  let current = node.GetParent();
  while (current) {
    disabledNodeIds.delete(current.GetId());
    current = current.GetParent();
  }
}

function nodeHasEnabledMesh(node) {
  if (!disabledNodeIds.has(node.GetId()) && node.MeshIndexCount() > 0) {
    return true;
  }
  for (const child of node.GetChildNodes()) {
    if (nodeHasEnabledMesh(child)) {
      return true;
    }
  }
  return false;
}

function nodeHasDisabledMesh(node) {
  if (disabledNodeIds.has(node.GetId()) && nodeMeshCount(node) > 0) {
    return true;
  }
  for (const child of node.GetChildNodes()) {
    if (nodeHasDisabledMesh(child)) {
      return true;
    }
  }
  return false;
}

function isNodeEffectivelyVisible(node) {
  let current = node;
  while (current) {
    if (disabledNodeIds.has(current.GetId())) {
      return false;
    }
    current = current.GetParent();
  }
  return true;
}

function isMeshInstanceVisible(meshInstance) {
  return isNodeEffectivelyVisible(meshInstance.node);
}

function updateViewerVisibility() {
  if (!embeddedViewer) {
    return;
  }
  embeddedViewer.GetViewer().SetMeshesVisibility((meshUserData) => {
    return isMeshInstanceVisible(meshUserData.originalMeshInstance);
  });
}

function buildHierarchyRows(model, fileName) {
  const root = model.GetRootNode();
  const entries = [];

  function visit(node, depth, fallbackName) {
    const meshCount = nodeMeshCount(node);
    if (meshCount === 0) {
      return;
    }

    const name = node.GetName() || fallbackName;
    entries.push({ node, depth, name, meshCount });

    node.GetChildNodes().forEach((child, index) => {
      visit(child, depth + 1, `Part ${index + 1}`);
    });
  }

  visit(root, 0, fileName);
  return entries;
}

function refreshHierarchyState() {
  for (const entry of hierarchyEntries) {
    const checkbox = partListEl.querySelector(`[data-node-id="${entry.node.GetId()}"]`);
    if (!checkbox) {
      continue;
    }
    const hasEnabled = nodeHasEnabledMesh(entry.node);
    const hasDisabled = nodeHasDisabledMesh(entry.node);
    checkbox.checked = hasEnabled;
    checkbox.indeterminate = hasEnabled && hasDisabled;
  }
}

function renderHierarchy(model, fileName) {
  hierarchyEntries = buildHierarchyRows(model, fileName);
  partListEl.replaceChildren();

  for (const entry of hierarchyEntries) {
    const row = document.createElement("label");
    row.className = "part-row";
    row.style.paddingLeft = `${10 + entry.depth * 16}px`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.nodeId = String(entry.node.GetId());
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        enableNodeAncestors(entry.node);
      }
      setNodeSubtreeDisabled(entry.node, !checkbox.checked);
      refreshHierarchyState();
      updateViewerVisibility();
      updateSelectedBoundingResult();
    });

    const name = document.createElement("span");
    name.className = "part-name";
    name.title = `${entry.name} (${entry.meshCount} mesh${entry.meshCount === 1 ? "" : "es"})`;
    name.textContent = entry.name;

    row.append(checkbox, name);
    partListEl.append(row);
  }

  refreshHierarchyState();
}

function calculateSelectedBoundingBox(model) {
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
  let hasVertex = false;

  model.EnumerateMeshInstances((meshInstance) => {
    if (!isMeshInstanceVisible(meshInstance)) {
      return;
    }
    meshInstance.EnumerateVertices((vertex) => {
      bounds.minX = Math.min(bounds.minX, vertex.x);
      bounds.minY = Math.min(bounds.minY, vertex.y);
      bounds.minZ = Math.min(bounds.minZ, vertex.z);
      bounds.maxX = Math.max(bounds.maxX, vertex.x);
      bounds.maxY = Math.max(bounds.maxY, vertex.y);
      bounds.maxZ = Math.max(bounds.maxZ, vertex.z);
      hasVertex = true;
    });
  });

  if (!hasVertex) {
    return null;
  }

  return bounds;
}

function updateSelectedBoundingResult() {
  if (!embeddedViewer) {
    return;
  }
  const model = embeddedViewer.GetModel();
  const bounds = calculateSelectedBoundingBox(model);
  if (!bounds) {
    lastPayload = null;
    resultEl.textContent = "-.--- X -.--- X -.---";
    metaEl.textContent = "No parts selected.";
    setStatus("Select at least one part to calculate stock size.", "error");
    return;
  }

  const sortedDimensions = [
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
    bounds.maxZ - bounds.minZ,
  ].sort((a, b) => a - b);
  const [lengthMm, widthMm, heightMm] = sortedDimensions;

  lastPayload = {
    classification: "prismatic",
    format: formatPrismaticIn(lengthMm, widthMm, heightMm),
    length_in: ceilTo(lengthMm * mmToInch, 3),
    width_in: ceilTo(widthMm * mmToInch, 3),
    height_in: ceilTo(heightMm * mmToInch, 3),
    length_mm: lengthMm,
    width_mm: widthMm,
    height_mm: heightMm,
    detected_material: null,
    details: {
      bounding: "Selected visible viewer geometry; excluded hierarchy items are omitted.",
    },
  };

  resultEl.textContent = formatResult(lastPayload);
  setResultMeta(lastPayload);
  detectedMaterialEl.textContent = "";
  materialBetaNoticeEl.hidden = true;
  setStatus("Analysis complete.", "success");
}

async function analyzeFileOnServer(file) {
  const form = new FormData();
  form.append("file", file);

  const response = await fetch("/api/analyze", {
    method: "POST",
    body: form,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.detail || "Unable to analyze this STEP file.");
  }
  return payload;
}

async function fallbackAnalyzeFile(file) {
  const payload = await analyzeFileOnServer(file);
  lastPayload = payload;
  resultEl.textContent = formatResult(payload);
  setStatus("Analysis complete.", "success");
  setResultMeta(payload);
  detectedMaterialEl.textContent = payload.detected_material
    ? `Material: ${payload.detected_material}`
    : "Material type cannot be detected from this file.";
  materialBetaNoticeEl.hidden = !payload.detected_material;
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

  const currentLoadToken = loadToken + 1;
  loadToken = currentLoadToken;
  resetViewer();

  setStatus(`Loading ${file.name}...`);
  resultEl.textContent = "Loading model";
  metaEl.textContent = "Preparing viewer selection.";
  detectedMaterialEl.textContent = "";
  materialBetaNoticeEl.hidden = true;

  try {
    if (!window.OV) {
      await fallbackAnalyzeFile(file);
      return;
    }

    viewerWorkbenchEl.hidden = false;
    partListEl.textContent = "Loading hierarchy.";
    embeddedViewer = new OV.EmbeddedViewer(viewerEl, {
      backgroundColor: new OV.RGBAColor(247, 250, 247, 255),
      defaultColor: new OV.RGBColor(194, 204, 198),
      edgeSettings: new OV.EdgeSettings(false, new OV.RGBColor(0, 0, 0), 1),
      onModelLoaded: () => {
        try {
          if (currentLoadToken !== loadToken || !embeddedViewer) {
            return;
          }
          const model = embeddedViewer.GetModel();
          modelRootNode = model.GetRootNode();
          disabledNodeIds = new Set();
          renderHierarchy(model, file.name);
          updateViewerVisibility();
          updateSelectedBoundingResult();
        } catch (error) {
          showAnalyzeError(error);
        }
      },
    });

    embeddedViewer.LoadModelFromFileList([file]);
  } catch (error) {
    showAnalyzeError(error);
  }
}

window.addEventListener("unhandledrejection", (event) => {
  // Chrome extensions can reject during file drag/drop via their injected listeners.
  // This app does not use extension messaging, so ignore only that known browser noise.
  if (isExtensionAsyncResponseError(event.reason)) {
    event.preventDefault();
  }
});

unitToggle.addEventListener("click", () => {
  setUnit(currentUnit === "in" ? "mm" : "in");
});

selectAllPartsButton.addEventListener("click", () => {
  if (!modelRootNode) {
    return;
  }
  setNodeSubtreeDisabled(modelRootNode, false);
  refreshHierarchyState();
  updateViewerVisibility();
  updateSelectedBoundingResult();
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
  analyzeFile(event.dataTransfer.files[0]).catch(showAnalyzeError);
});

fileInput.addEventListener("change", () => {
  analyzeFile(fileInput.files[0]).catch(showAnalyzeError);
});
