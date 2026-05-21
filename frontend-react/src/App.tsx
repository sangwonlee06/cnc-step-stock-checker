import { ChangeEvent, DragEvent, useEffect, useRef, useState } from "react";

const allowedExtensions = [".stp", ".step"];
const occtWorkerUrl = "/static/vendor/occt-import-js/occt-import-js-worker.js";
const mmToInch = 1.0 / 25.4;
const extensionAsyncResponseError = "A listener indicated an asynchronous response by returning true";

type Unit = "in" | "mm";
type StatusTone = "neutral" | "success" | "error";

type StepAnalysisPayload = {
  classification: "cylindrical" | "prismatic" | string;
  format: string;
  diameter_mm?: number;
  inner_diameter_mm?: number | null;
  length_mm: number;
  width_mm?: number;
  height_mm?: number;
  length_in?: number;
  width_in?: number;
  height_in?: number;
  detected_material?: string | null;
  details?: {
    bounding?: string;
  };
};

type PartEntry = {
  node: OvNode;
  depth: number;
  name: string;
  meshCount: number;
};

type Bounds = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

let warmedOcctWorker: Worker | null = null;
let occtWarmupPromise: Promise<Worker | null> | null = null;

function ceilTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.ceil(value * factor) / factor;
}

function warmOcctRuntime(): Promise<Worker | null> {
  if (!window.Worker || occtWarmupPromise) {
    return occtWarmupPromise || Promise.resolve(null);
  }

  occtWarmupPromise = new Promise((resolve) => {
    let worker: Worker | null = null;
    const cleanup = () => {
      window.clearTimeout(timeout);
      worker?.removeEventListener("message", handleMessage);
      worker?.removeEventListener("error", handleError);
    };
    const handleMessage = (event: MessageEvent<OcctWarmupMessage>) => {
      if (event.data?.type !== "warmup") {
        return;
      }
      cleanup();
      warmedOcctWorker = worker;
      resolve(worker);
    };
    const handleError = () => {
      cleanup();
      worker?.terminate();
      resolve(null);
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      worker?.terminate();
      resolve(null);
    }, 15000);

    try {
      worker = new Worker(occtWorkerUrl);
    } catch {
      window.clearTimeout(timeout);
      resolve(null);
      return;
    }

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.postMessage({ type: "warmup" });
  });

  return occtWarmupPromise;
}

window.__stepStockTakeWarmedOcctWorker = async () => {
  if (!warmedOcctWorker) {
    await warmOcctRuntime();
  }

  if (!warmedOcctWorker) {
    return new Worker(occtWorkerUrl);
  }

  const worker = warmedOcctWorker;
  warmedOcctWorker = null;
  occtWarmupPromise = null;
  return worker;
};

function isExtensionAsyncResponseError(error: unknown): boolean {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : undefined;
  return Boolean(message?.includes(extensionAsyncResponseError));
}

function isStepFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return allowedExtensions.some((ext) => name.endsWith(ext));
}

function formatPrismaticIn(lengthMm: number, widthMm: number, heightMm: number): string {
  const length = ceilTo(lengthMm * mmToInch, 3).toFixed(3);
  const width = ceilTo(widthMm * mmToInch, 3).toFixed(3);
  const height = ceilTo(heightMm * mmToInch, 3).toFixed(3);
  return `${length} X ${width} X ${height}`;
}

function formatResult(payload: StepAnalysisPayload, unit: Unit): string {
  if (unit === "mm") {
    if (payload.classification === "cylindrical" && payload.diameter_mm !== undefined) {
      const dia = ceilTo(payload.diameter_mm, 2).toFixed(2);
      const len = ceilTo(payload.length_mm, 2).toFixed(2);
      if (payload.inner_diameter_mm) {
        const id = ceilTo(payload.inner_diameter_mm, 2).toFixed(2);
        return `OD ${dia} X ID ${id} X ${len}`;
      }
      return `DIA ${dia} X ${len}`;
    }
    const l = ceilTo(payload.length_mm, 2).toFixed(2);
    const w = ceilTo(payload.width_mm ?? 0, 2).toFixed(2);
    const h = ceilTo(payload.height_mm ?? 0, 2).toFixed(2);
    return `${l} X ${w} X ${h}`;
  }
  return payload.format;
}

function resultMeta(payload: StepAnalysisPayload | null, unit: Unit): string {
  if (payload?.details?.bounding === "Selected visible viewer geometry; excluded hierarchy items are omitted.") {
    return unit === "mm"
      ? "Visible selected geometry, rounded up to 0.01 mm. No machining allowance added."
      : "Visible selected geometry, rounded up to 0.001 in. No machining allowance added.";
  }
  return unit === "mm"
    ? "Axis-aligned bounding box, rounded up to 0.01 mm. No machining allowance added."
    : "Axis-aligned bounding box, rounded up to 0.001 in. No machining allowance added.";
}

function nodeMeshCount(node: OvNode): number {
  let count = node.MeshIndexCount();
  for (const child of node.GetChildNodes()) {
    count += nodeMeshCount(child);
  }
  return count;
}

function buildHierarchyRows(model: OvModel, fileName: string): PartEntry[] {
  const root = model.GetRootNode();
  const entries: PartEntry[] = [];

  function visit(node: OvNode, depth: number, fallbackName: string) {
    const meshCount = nodeMeshCount(node);
    if (meshCount === 0) {
      return;
    }

    entries.push({
      node,
      depth,
      name: node.GetName() || fallbackName,
      meshCount,
    });

    node.GetChildNodes().forEach((child, index) => {
      visit(child, depth + 1, `Part ${index + 1}`);
    });
  }

  visit(root, 0, fileName);
  return entries;
}

function PartRow({
  entry,
  disabledNodeIds,
  onToggle,
}: {
  entry: PartEntry;
  disabledNodeIds: Set<number>;
  onToggle: (entry: PartEntry, checked: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hasEnabled = nodeHasEnabledMesh(entry.node, disabledNodeIds);
  const hasDisabled = nodeHasDisabledMesh(entry.node, disabledNodeIds);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = hasEnabled && hasDisabled;
    }
  }, [hasDisabled, hasEnabled]);

  return (
    <label className="part-row" style={{ paddingLeft: `${10 + entry.depth * 16}px` }}>
      <input
        ref={inputRef}
        type="checkbox"
        checked={hasEnabled}
        data-node-id={entry.node.GetId()}
        onChange={(event) => onToggle(entry, event.currentTarget.checked)}
      />
      <span
        className="part-name"
        title={`${entry.name} (${entry.meshCount} mesh${entry.meshCount === 1 ? "" : "es"})`}
      >
        {entry.name}
      </span>
    </label>
  );
}

function nodeHasEnabledMesh(node: OvNode, disabledNodeIds: Set<number>): boolean {
  if (!disabledNodeIds.has(node.GetId()) && node.MeshIndexCount() > 0) {
    return true;
  }
  for (const child of node.GetChildNodes()) {
    if (nodeHasEnabledMesh(child, disabledNodeIds)) {
      return true;
    }
  }
  return false;
}

function nodeHasDisabledMesh(node: OvNode, disabledNodeIds: Set<number>): boolean {
  if (disabledNodeIds.has(node.GetId()) && nodeMeshCount(node) > 0) {
    return true;
  }
  for (const child of node.GetChildNodes()) {
    if (nodeHasDisabledMesh(child, disabledNodeIds)) {
      return true;
    }
  }
  return false;
}

function setNodeSubtreeDisabled(node: OvNode, isDisabled: boolean, nextDisabledNodeIds: Set<number>) {
  if (isDisabled) {
    nextDisabledNodeIds.add(node.GetId());
  } else {
    nextDisabledNodeIds.delete(node.GetId());
  }
  for (const child of node.GetChildNodes()) {
    setNodeSubtreeDisabled(child, isDisabled, nextDisabledNodeIds);
  }
}

function enableNodeAncestors(node: OvNode, nextDisabledNodeIds: Set<number>) {
  let current = node.GetParent();
  while (current) {
    nextDisabledNodeIds.delete(current.GetId());
    current = current.GetParent();
  }
}

function isNodeEffectivelyVisible(node: OvNode, disabledNodeIds: Set<number>): boolean {
  let current: OvNode | null = node;
  while (current) {
    if (disabledNodeIds.has(current.GetId())) {
      return false;
    }
    current = current.GetParent();
  }
  return true;
}

async function analyzeFileOnServer(file: File): Promise<StepAnalysisPayload> {
  const form = new FormData();
  form.append("file", file);

  const response = await fetch("/api/analyze", {
    method: "POST",
    body: form,
  });

  const payload = (await response.json()) as StepAnalysisPayload | { detail?: string };
  if (!response.ok) {
    throw new Error("detail" in payload ? payload.detail || "Unable to analyze this STEP file." : "Unable to analyze this STEP file.");
  }
  return payload as StepAnalysisPayload;
}

function calculateSelectedBoundingBox(model: OvModel, disabledNodeIds: Set<number>): Bounds | null {
  const bounds: Bounds = {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
  let hasVertex = false;

  model.EnumerateMeshInstances((meshInstance) => {
    if (!isNodeEffectivelyVisible(meshInstance.node, disabledNodeIds)) {
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

  return hasVertex ? bounds : null;
}

function selectedBoundingPayload(model: OvModel, disabledNodeIds: Set<number>): StepAnalysisPayload | null {
  const bounds = calculateSelectedBoundingBox(model, disabledNodeIds);
  if (!bounds) {
    return null;
  }

  const sortedDimensions = [
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
    bounds.maxZ - bounds.minZ,
  ].sort((a, b) => a - b);
  const [lengthMm, widthMm, heightMm] = sortedDimensions;

  return {
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
}

export function App() {
  const [unit, setUnit] = useState<Unit>("in");
  const [lastPayload, setLastPayload] = useState<StepAnalysisPayload | null>(null);
  const [status, setStatus] = useState("Ready for a STEP file.");
  const [statusTone, setStatusTone] = useState<StatusTone>("neutral");
  const [activeDrop, setActiveDrop] = useState(false);
  const [viewerVisible, setViewerVisible] = useState(false);
  const [partEntries, setPartEntries] = useState<PartEntry[]>([]);
  const [disabledNodeIds, setDisabledNodeIds] = useState<Set<number>>(() => new Set());
  const [emptySelection, setEmptySelection] = useState(false);
  const viewerElRef = useRef<HTMLDivElement>(null);
  const embeddedViewerRef = useRef<OvEmbeddedViewer | null>(null);
  const modelRootNodeRef = useRef<OvNode | null>(null);
  const loadTokenRef = useRef(0);

  useEffect(() => {
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isExtensionAsyncResponseError(event.reason)) {
        event.preventDefault();
      }
    };

    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    window.setTimeout(() => {
      warmOcctRuntime().catch(() => undefined);
    }, 0);

    return () => {
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
      embeddedViewerRef.current?.Destroy();
    };
  }, []);

  const resetSelectionUi = () => {
    modelRootNodeRef.current = null;
    setDisabledNodeIds(new Set());
    setPartEntries([]);
    setViewerVisible(false);
  };

  const resetViewer = () => {
    if (embeddedViewerRef.current) {
      embeddedViewerRef.current.Destroy();
      embeddedViewerRef.current = null;
    }
    viewerElRef.current?.replaceChildren();
    resetSelectionUi();
  };

  const showAnalyzeError = (error: unknown) => {
    resetSelectionUi();
    setLastPayload(null);
    setEmptySelection(false);
    setStatus(error instanceof Error ? error.message : "Unable to analyze this STEP file.");
    setStatusTone("error");
  };

  const updateViewerVisibility = (nextDisabledNodeIds: Set<number>) => {
    const embeddedViewer = embeddedViewerRef.current;
    if (!embeddedViewer) {
      return;
    }
    embeddedViewer.GetViewer().SetMeshesVisibility((meshUserData) => {
      return isNodeEffectivelyVisible(meshUserData.originalMeshInstance.node, nextDisabledNodeIds);
    });
  };

  const updateSelectedBoundingResult = (nextDisabledNodeIds: Set<number>) => {
    const embeddedViewer = embeddedViewerRef.current;
    if (!embeddedViewer) {
      return;
    }
    const model = embeddedViewer.GetModel();
    const payload = selectedBoundingPayload(model, nextDisabledNodeIds);
    if (!payload) {
      setLastPayload(null);
      setEmptySelection(true);
      setStatus("Select at least one part to calculate stock size.");
      setStatusTone("error");
      return;
    }

    setLastPayload(payload);
    setEmptySelection(false);
    setStatus("Analysis complete.");
    setStatusTone("success");
  };

  const analyzeFile = async (file?: File) => {
    if (!file) {
      return;
    }

    if (!isStepFile(file)) {
      setStatus(`"${file.name}" is not a STEP file. Choose a .stp or .step file.`);
      setStatusTone("error");
      return;
    }

    if (file.size >= 10 * 1024 * 1024) {
      setStatus("File must be smaller than 10 MB.");
      setStatusTone("error");
      return;
    }

    const currentLoadToken = loadTokenRef.current + 1;
    loadTokenRef.current = currentLoadToken;
    resetViewer();

    setStatus(`Loading ${file.name}...`);
    setStatusTone("neutral");
    setLastPayload(null);
    setEmptySelection(false);

    try {
      if (!window.OV || !viewerElRef.current) {
        const payload = await analyzeFileOnServer(file);
        setLastPayload(payload);
        setStatus("Analysis complete.");
        setStatusTone("success");
        return;
      }

      setViewerVisible(true);
      setPartEntries([]);

      const embeddedViewer = new window.OV.EmbeddedViewer(viewerElRef.current, {
        backgroundColor: new window.OV.RGBAColor(247, 250, 247, 255),
        defaultColor: new window.OV.RGBColor(194, 204, 198),
        edgeSettings: new window.OV.EdgeSettings(false, new window.OV.RGBColor(0, 0, 0), 1),
        onModelLoaded: () => {
          try {
            if (currentLoadToken !== loadTokenRef.current || !embeddedViewerRef.current) {
              return;
            }
            const model = embeddedViewerRef.current.GetModel();
            modelRootNodeRef.current = model.GetRootNode();
            const nextDisabledNodeIds = new Set<number>();
            setDisabledNodeIds(nextDisabledNodeIds);
            setPartEntries(buildHierarchyRows(model, file.name));
            updateViewerVisibility(nextDisabledNodeIds);
            updateSelectedBoundingResult(nextDisabledNodeIds);
          } catch (error) {
            showAnalyzeError(error);
          }
        },
      });

      embeddedViewerRef.current = embeddedViewer;
      embeddedViewer.LoadModelFromFileList([file]);
    } catch (error) {
      showAnalyzeError(error);
    }
  };

  const handlePartToggle = (entry: PartEntry, checked: boolean) => {
    const nextDisabledNodeIds = new Set(disabledNodeIds);
    if (checked) {
      enableNodeAncestors(entry.node, nextDisabledNodeIds);
    }
    setNodeSubtreeDisabled(entry.node, !checked, nextDisabledNodeIds);
    setDisabledNodeIds(nextDisabledNodeIds);
    updateViewerVisibility(nextDisabledNodeIds);
    updateSelectedBoundingResult(nextDisabledNodeIds);
  };

  const handleSelectAllParts = () => {
    const root = modelRootNodeRef.current;
    if (!root) {
      return;
    }
    const nextDisabledNodeIds = new Set<number>();
    setNodeSubtreeDisabled(root, false, nextDisabledNodeIds);
    setDisabledNodeIds(nextDisabledNodeIds);
    updateViewerVisibility(nextDisabledNodeIds);
    updateSelectedBoundingResult(nextDisabledNodeIds);
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setActiveDrop(false);
    analyzeFile(event.dataTransfer.files[0]).catch(showAnalyzeError);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    analyzeFile(event.currentTarget.files?.[0]).catch(showAnalyzeError);
  };

  const unitLabel = unit === "mm" ? "MM" : "IN";
  const resultText = emptySelection
    ? "-.--- X -.--- X -.---"
    : lastPayload
      ? formatResult(lastPayload, unit)
      : status.startsWith("Loading ")
        ? "Loading model"
        : "-.--- X -.--- X -.---";
  const metaText = emptySelection
    ? "No parts selected."
    : lastPayload
      ? resultMeta(lastPayload, unit)
      : status.startsWith("Loading ")
        ? "Preparing viewer selection."
        : resultMeta(null, unit);
  const detectedMaterialText = lastPayload?.detected_material
    ? `Material: ${lastPayload.detected_material}`
    : lastPayload && lastPayload.details?.bounding !== "Selected visible viewer geometry; excluded hierarchy items are omitted."
      ? "Material type cannot be detected from this file."
      : "";
  const showMaterialBetaNotice = Boolean(lastPayload?.detected_material);

  return (
    <main className="shell">
      <section className="workspace">
        <div className="panel">
          <div className="title-row">
            <div>
              <p className="eyebrow">STEP to stock size</p>
              <h1>STEP Stock Size Calculator</h1>
            </div>
            <button className="unit" title="Switch unit" onClick={() => setUnit(unit === "in" ? "mm" : "in")}>
              {unitLabel}
            </button>
          </div>

          <label
            id="drop-zone"
            className="drop-zone"
            htmlFor="file-input"
            data-active={activeDrop ? "true" : "false"}
            onDragOver={(event) => {
              event.preventDefault();
              setActiveDrop(true);
            }}
            onDragLeave={() => setActiveDrop(false)}
            onDrop={handleDrop}
          >
            <input id="file-input" type="file" accept=".stp,.step" onChange={handleFileChange} />
            <span className="upload-icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                width="22"
                height="22"
                fill="none"
                stroke="#ffffff"
                strokeWidth="2.75"
                strokeLinecap="round"
                focusable="false"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </span>
            <span className="drop-title">Drop STEP file</span>
            <span className="drop-subtitle">or click to choose .stp / .step (10 MB max)</span>
          </label>

          <div className="viewer-workbench" hidden={!viewerVisible}>
            <div ref={viewerElRef} id="viewer" className="model-viewer" aria-label="3D model viewer" />
            <div className="part-panel" aria-label="Model hierarchy">
              <div className="part-panel-header">
                <p className="eyebrow">Included Parts</p>
                <button className="text-button" type="button" onClick={handleSelectAllParts}>
                  All
                </button>
              </div>
              <div className="part-list">
                {partEntries.length === 0 ? (
                  <span className="part-loading">Loading hierarchy.</span>
                ) : (
                  partEntries.map((entry) => (
                    <PartRow
                      key={entry.node.GetId()}
                      entry={entry}
                      disabledNodeIds={disabledNodeIds}
                      onToggle={handlePartToggle}
                    />
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="upload-meta-row">
            <div className="status" role="status" data-tone={statusTone}>
              {status}
            </div>
          </div>

          <aside className="privacy-note" aria-label="Confidentiality notice">
            <p className="privacy-copy">STEP files are processed for this analysis and not retained afterward.</p>
          </aside>
        </div>

        <div className="result-panel">
          <p className="eyebrow">Result</p>
          <div className="result-header">
            <h2 className="result-title">Bounding Dimensions</h2>
            <span className="result-unit">{unitLabel}</span>
          </div>
          <output className="result">{resultText}</output>
          <div className="meta">{metaText}</div>
          <div className="detected-material">{detectedMaterialText}</div>
          <div className="material-beta-notice" hidden={!showMaterialBetaNotice}>
            Material detection is a beta feature and may not be accurate.
          </div>
        </div>
      </section>
    </main>
  );
}
