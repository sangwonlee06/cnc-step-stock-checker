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
  diameter_in?: number;
  diameter_mm?: number;
  inner_diameter_in?: number | null;
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

type AxisKey = "x" | "y" | "z";

type SelectedGeometry = {
  bounds: Bounds;
  vertices: OvVertex[];
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

function waitForElementLayout(element: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const waitForFrame = (remainingFrames: number) => {
      window.requestAnimationFrame(() => {
        const bounds = element.getBoundingClientRect();
        if ((bounds.width > 0 && bounds.height > 0) || remainingFrames <= 0) {
          resolve();
          return;
        }

        waitForFrame(remainingFrames - 1);
      });
    };

    waitForFrame(10);
  });
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

function formatRodIn(diameterMm: number, lengthMm: number): string {
  const diameter = ceilTo(diameterMm * mmToInch, 3).toFixed(3);
  const length = ceilTo(lengthMm * mmToInch, 3).toFixed(3);
  return `DIA ${diameter} X ${length}`;
}

function formatPipeIn(outerDiameterMm: number, innerDiameterMm: number, lengthMm: number): string {
  const outerDiameter = ceilTo(outerDiameterMm * mmToInch, 3).toFixed(3);
  const innerDiameter = ceilTo(innerDiameterMm * mmToInch, 3).toFixed(3);
  const length = ceilTo(lengthMm * mmToInch, 3).toFixed(3);
  return `OD ${outerDiameter} X ID ${innerDiameter} X ${length}`;
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
  isSelected,
  onToggle,
  onSelect,
  registerRow,
}: {
  entry: PartEntry;
  disabledNodeIds: Set<number>;
  isSelected: boolean;
  onToggle: (entry: PartEntry, checked: boolean) => void;
  onSelect: (entry: PartEntry) => void;
  registerRow: (nodeId: number, element: HTMLDivElement | null) => void;
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
    <div
      ref={(element) => registerRow(entry.node.GetId(), element)}
      className="part-row"
      data-selected={isSelected ? "true" : "false"}
      onClick={() => onSelect(entry)}
      style={{ paddingLeft: `${10 + entry.depth * 16}px` }}
    >
      <input
        ref={inputRef}
        type="checkbox"
        aria-label={`Include ${entry.name}`}
        checked={hasEnabled}
        data-node-id={entry.node.GetId()}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          onSelect(entry);
          onToggle(entry, event.currentTarget.checked);
        }}
      />
      <span
        className="part-name"
        title={`${entry.name} (${entry.meshCount} mesh${entry.meshCount === 1 ? "" : "es"})`}
      >
        {entry.name}
      </span>
    </div>
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

function isNodeInSubtree(node: OvNode, root: OvNode): boolean {
  let current: OvNode | null = node;
  while (current) {
    if (current.GetId() === root.GetId()) {
      return true;
    }
    current = current.GetParent();
  }
  return false;
}

function calculateSelectedGeometry(model: OvModel, disabledNodeIds: Set<number>): SelectedGeometry | null {
  const bounds: Bounds = {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
  const vertices: OvVertex[] = [];
  let hasVertex = false;

  model.EnumerateMeshInstances((meshInstance) => {
    if (!isNodeEffectivelyVisible(meshInstance.node, disabledNodeIds)) {
      return;
    }
    meshInstance.EnumerateVertices((vertex) => {
      vertices.push(vertex);
      bounds.minX = Math.min(bounds.minX, vertex.x);
      bounds.minY = Math.min(bounds.minY, vertex.y);
      bounds.minZ = Math.min(bounds.minZ, vertex.z);
      bounds.maxX = Math.max(bounds.maxX, vertex.x);
      bounds.maxY = Math.max(bounds.maxY, vertex.y);
      bounds.maxZ = Math.max(bounds.maxZ, vertex.z);
      hasVertex = true;
    });
  });

  return hasVertex ? { bounds, vertices } : null;
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

function boundsDimension(bounds: Bounds, axis: AxisKey): number {
  if (axis === "x") {
    return bounds.maxX - bounds.minX;
  }
  if (axis === "y") {
    return bounds.maxY - bounds.minY;
  }
  return bounds.maxZ - bounds.minZ;
}

function boundsCenter(bounds: Bounds, axis: AxisKey): number {
  if (axis === "x") {
    return (bounds.minX + bounds.maxX) / 2.0;
  }
  if (axis === "y") {
    return (bounds.minY + bounds.maxY) / 2.0;
  }
  return (bounds.minZ + bounds.maxZ) / 2.0;
}

function vertexAxisValue(vertex: OvVertex, axis: AxisKey): number {
  return vertex[axis];
}

function angularBinCount(vertices: OvVertex[], axisA: AxisKey, axisB: AxisKey, centerA: number, centerB: number, radius: number) {
  const bins = new Set<number>();
  const radiusTolerance = Math.max(radius * 0.04, 0.02);

  for (const vertex of vertices) {
    const offsetA = vertexAxisValue(vertex, axisA) - centerA;
    const offsetB = vertexAxisValue(vertex, axisB) - centerB;
    const vertexRadius = Math.hypot(offsetA, offsetB);
    if (Math.abs(vertexRadius - radius) > radiusTolerance) {
      continue;
    }
    const angle = Math.atan2(offsetB, offsetA);
    bins.add(Math.floor(((angle + Math.PI) / (Math.PI * 2)) * 16));
  }

  return bins.size;
}

function radialDistance(vertex: OvVertex, axisA: AxisKey, axisB: AxisKey, centerA: number, centerB: number): number {
  return Math.hypot(
    vertexAxisValue(vertex, axisA) - centerA,
    vertexAxisValue(vertex, axisB) - centerB,
  );
}

function axialSpanRatio(vertices: OvVertex[], lengthAxis: AxisKey, lengthMm: number): number {
  if (vertices.length === 0 || lengthMm <= 0) {
    return 0;
  }

  let min = Infinity;
  let max = -Infinity;
  for (const vertex of vertices) {
    const value = vertexAxisValue(vertex, lengthAxis);
    min = Math.min(min, value);
    max = Math.max(max, value);
  }

  return (max - min) / lengthMm;
}

function detectInnerDiameter(
  vertices: OvVertex[],
  lengthAxis: AxisKey,
  axisA: AxisKey,
  axisB: AxisKey,
  centerA: number,
  centerB: number,
  outerRadius: number,
  lengthMm: number,
): number | null {
  const clusterTolerance = Math.max(outerRadius * 0.035, 0.02);
  const clusters: Array<{ radius: number; vertices: OvVertex[] }> = [];

  for (const vertex of vertices) {
    const radius = radialDistance(vertex, axisA, axisB, centerA, centerB);
    if (radius < outerRadius * 0.18 || radius > outerRadius * 0.78) {
      continue;
    }

    const cluster = clusters.find((item) => Math.abs(item.radius - radius) <= clusterTolerance);
    if (cluster) {
      cluster.radius = (cluster.radius * cluster.vertices.length + radius) / (cluster.vertices.length + 1);
      cluster.vertices.push(vertex);
    } else {
      clusters.push({ radius, vertices: [vertex] });
    }
  }

  const candidates = clusters
    .filter((cluster) => cluster.vertices.length >= 16)
    .filter((cluster) => angularBinCount(cluster.vertices, axisA, axisB, centerA, centerB, cluster.radius) >= 12)
    .filter((cluster) => axialSpanRatio(cluster.vertices, lengthAxis, lengthMm) >= 0.75)
    .filter((cluster) => {
      const centerCutoff = cluster.radius * 0.65;
      const centerVertexCount = vertices.filter((vertex) => {
        return radialDistance(vertex, axisA, axisB, centerA, centerB) < centerCutoff;
      }).length;

      return centerVertexCount <= Math.max(2, vertices.length * 0.01);
    })
    .sort((a, b) => a.radius - b.radius);

  return candidates[0] ? candidates[0].radius * 2.0 : null;
}

function selectedCylindricalPayload(geometry: SelectedGeometry): StepAnalysisPayload | null {
  const axes: AxisKey[] = ["x", "y", "z"];

  for (const lengthAxis of axes) {
    const crossAxes = axes.filter((axis) => axis !== lengthAxis);
    const [axisA, axisB] = crossAxes;
    const diameterA = boundsDimension(geometry.bounds, axisA);
    const diameterB = boundsDimension(geometry.bounds, axisB);
    const diameter = Math.max(diameterA, diameterB);
    const lengthMm = boundsDimension(geometry.bounds, lengthAxis);
    const diameterTolerance = Math.max(diameter * 0.015, 0.03);

    if (diameter <= 0 || lengthMm <= 0 || Math.abs(diameterA - diameterB) > diameterTolerance) {
      continue;
    }

    const centerA = boundsCenter(geometry.bounds, axisA);
    const centerB = boundsCenter(geometry.bounds, axisB);
    const outerRadius = diameter / 2.0;
    if (angularBinCount(geometry.vertices, axisA, axisB, centerA, centerB, outerRadius) < 8) {
      continue;
    }

    const innerDiameterMm = detectInnerDiameter(
      geometry.vertices,
      lengthAxis,
      axisA,
      axisB,
      centerA,
      centerB,
      outerRadius,
      lengthMm,
    );
    const lengthIn = ceilTo(lengthMm * mmToInch, 3);
    const diameterIn = ceilTo(diameter * mmToInch, 3);
    const payload: StepAnalysisPayload = {
      classification: "cylindrical",
      diameter_mm: diameter,
      diameter_in: diameterIn,
      length_mm: lengthMm,
      length_in: lengthIn,
      format: formatRodIn(diameter, lengthMm),
      detected_material: null,
      details: {
        bounding: "Selected visible viewer geometry; excluded hierarchy items are omitted.",
      },
    };

    if (innerDiameterMm) {
      payload.inner_diameter_mm = innerDiameterMm;
      payload.inner_diameter_in = ceilTo(innerDiameterMm * mmToInch, 3);
      payload.format = formatPipeIn(diameter, innerDiameterMm, lengthMm);
    }

    return payload;
  }

  return null;
}

function selectedBoundingPayload(model: OvModel, disabledNodeIds: Set<number>): StepAnalysisPayload | null {
  const geometry = calculateSelectedGeometry(model, disabledNodeIds);
  if (!geometry) {
    return null;
  }

  const cylindricalPayload = selectedCylindricalPayload(geometry);
  if (cylindricalPayload) {
    return cylindricalPayload;
  }

  const { bounds } = geometry;
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
  const [selectedPartNodeId, setSelectedPartNodeId] = useState<number | null>(null);
  const [emptySelection, setEmptySelection] = useState(false);
  const viewerElRef = useRef<HTMLDivElement>(null);
  const embeddedViewerRef = useRef<OvEmbeddedViewer | null>(null);
  const modelRootNodeRef = useRef<OvNode | null>(null);
  const fullModelPayloadRef = useRef<StepAnalysisPayload | null>(null);
  const disabledNodeIdsRef = useRef<Set<number>>(new Set());
  const partEntriesRef = useRef<PartEntry[]>([]);
  const selectedPartNodeRef = useRef<OvNode | null>(null);
  const partRowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
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
    disabledNodeIdsRef.current = new Set();
    partEntriesRef.current = [];
    selectedPartNodeRef.current = null;
    partRowRefs.current.clear();
    setDisabledNodeIds(new Set());
    setPartEntries([]);
    setSelectedPartNodeId(null);
    setViewerVisible(false);
  };

  const resetViewer = () => {
    if (embeddedViewerRef.current) {
      embeddedViewerRef.current.Destroy();
      embeddedViewerRef.current = null;
    }
    fullModelPayloadRef.current = null;
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
    updateViewerHighlight();
  };

  const updateViewerHighlight = (selectedNode: OvNode | null = selectedPartNodeRef.current) => {
    const embeddedViewer = embeddedViewerRef.current;
    if (!embeddedViewer || !window.OV) {
      return;
    }

    const highlightColor = new window.OV.RGBColor(224, 132, 54);
    embeddedViewer.GetViewer().SetMeshesHighlight(highlightColor, (meshUserData) => {
      if (!selectedNode) {
        return false;
      }

      const meshNode = meshUserData.originalMeshInstance.node;
      return isNodeEffectivelyVisible(meshNode, disabledNodeIdsRef.current) && isNodeInSubtree(meshNode, selectedNode);
    });
  };

  const registerPartRow = (nodeId: number, element: HTMLDivElement | null) => {
    if (element) {
      partRowRefs.current.set(nodeId, element);
    } else {
      partRowRefs.current.delete(nodeId);
    }
  };

  const scrollPartRowIntoView = (nodeId: number) => {
    window.requestAnimationFrame(() => {
      partRowRefs.current.get(nodeId)?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    });
  };

  const findPartEntryForNode = (node: OvNode): PartEntry | null => {
    let current: OvNode | null = node;
    while (current) {
      const entry = partEntriesRef.current.find((candidate) => candidate.node.GetId() === current?.GetId());
      if (entry) {
        return entry;
      }
      current = current.GetParent();
    }
    return null;
  };

  const selectPartNode = (node: OvNode | null, shouldScroll = false) => {
    const entry = node ? findPartEntryForNode(node) : null;
    const selectedNode = entry?.node ?? null;
    selectedPartNodeRef.current = selectedNode;
    setSelectedPartNodeId(selectedNode?.GetId() ?? null);
    updateViewerHighlight(selectedNode);

    if (selectedNode && shouldScroll) {
      scrollPartRowIntoView(selectedNode.GetId());
    }
  };

  const updateSelectedBoundingResult = (nextDisabledNodeIds: Set<number>) => {
    const embeddedViewer = embeddedViewerRef.current;
    if (!embeddedViewer) {
      return;
    }
    const model = embeddedViewer.GetModel();
    const payload =
      nextDisabledNodeIds.size === 0 && fullModelPayloadRef.current
        ? fullModelPayloadRef.current
        : selectedBoundingPayload(model, nextDisabledNodeIds);
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

      const fullModelAnalysisPromise = analyzeFileOnServer(file).catch(() => null);

      setViewerVisible(true);
      setPartEntries([]);
      const viewerElement = viewerElRef.current;
      if (!viewerElement) {
        throw new Error("Unable to initialize the 3D viewer.");
      }

      await waitForElementLayout(viewerElement);
      if (currentLoadToken !== loadTokenRef.current) {
        return;
      }

      const embeddedViewer = new window.OV.EmbeddedViewer(viewerElement, {
        backgroundColor: new window.OV.RGBAColor(247, 250, 247, 255),
        defaultColor: new window.OV.RGBColor(194, 204, 198),
        edgeSettings: new window.OV.EdgeSettings(false, new window.OV.RGBColor(0, 0, 0), 1),
        onModelLoaded: () => {
          void (async () => {
            if (currentLoadToken !== loadTokenRef.current || !embeddedViewerRef.current) {
              return;
            }
            const model = embeddedViewerRef.current.GetModel();
            modelRootNodeRef.current = model.GetRootNode();
            const nextDisabledNodeIds = new Set<number>();
            const nextPartEntries = buildHierarchyRows(model, file.name);
            disabledNodeIdsRef.current = nextDisabledNodeIds;
            partEntriesRef.current = nextPartEntries;
            setDisabledNodeIds(nextDisabledNodeIds);
            setPartEntries(nextPartEntries);
            updateViewerVisibility(nextDisabledNodeIds);
            selectPartNode(null);
            embeddedViewerRef.current.GetViewer().SetMouseClickHandler((button, mouseCoords) => {
              if (button !== 1 || !embeddedViewerRef.current || !window.OV) {
                return;
              }

              const meshUserData = embeddedViewerRef.current
                .GetViewer()
                .GetMeshUserDataUnderMouse(window.OV.IntersectionMode.MeshOnly, mouseCoords);

              selectPartNode(meshUserData?.originalMeshInstance.node ?? null, true);
            });
            embeddedViewerRef.current.Resize();
            fullModelPayloadRef.current = await fullModelAnalysisPromise;
            if (currentLoadToken !== loadTokenRef.current) {
              return;
            }
            updateSelectedBoundingResult(disabledNodeIdsRef.current);
          })().catch(showAnalyzeError);
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
    disabledNodeIdsRef.current = nextDisabledNodeIds;
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
    disabledNodeIdsRef.current = nextDisabledNodeIds;
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
            <button
              className="unit-switch"
              type="button"
              aria-label={`Display unit: ${unitLabel}. Click to switch to ${unit === "in" ? "MM" : "IN"}.`}
              onClick={() => setUnit(unit === "in" ? "mm" : "in")}
            >
              <span
                className="unit-option"
                aria-pressed={unit === "in"}
              >
                IN
              </span>
              <span
                className="unit-option"
                aria-pressed={unit === "mm"}
              >
                MM
              </span>
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
                      isSelected={selectedPartNodeId === entry.node.GetId()}
                      onToggle={handlePartToggle}
                      onSelect={(selectedEntry) => selectPartNode(selectedEntry.node)}
                      registerRow={registerPartRow}
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
