/// <reference types="vite/client" />

declare global {
  type OcctWarmupMessage = {
    type: "warmup";
    success: true;
  };

  type OcctWorkerFactory = () => Promise<Worker>;

  type OvColor = unknown;
  type OvNode = {
    GetId(): number;
    GetName(): string;
    GetParent(): OvNode | null;
    MeshIndexCount(): number;
    GetChildNodes(): OvNode[];
  };

  type OvVertex = {
    x: number;
    y: number;
    z: number;
  };

  type OvMeshInstance = {
    node: OvNode;
    EnumerateVertices(callback: (vertex: OvVertex) => void): void;
  };

  type OvModel = {
    GetRootNode(): OvNode;
    EnumerateMeshInstances(callback: (meshInstance: OvMeshInstance) => void): void;
  };

  type OvViewer = {
    SetMeshesVisibility(callback: (meshUserData: { originalMeshInstance: OvMeshInstance }) => boolean): void;
  };

  type OvEmbeddedViewer = {
    Destroy(): void;
    GetViewer(): OvViewer;
    GetModel(): OvModel;
    LoadModelFromFileList(files: File[]): void;
    Resize(): void;
  };

  type OvNamespace = {
    EmbeddedViewer: new (
      element: HTMLElement,
      options: {
        backgroundColor: OvColor;
        defaultColor: OvColor;
        edgeSettings: unknown;
        onModelLoaded: () => void;
      },
    ) => OvEmbeddedViewer;
    RGBAColor: new (r: number, g: number, b: number, a: number) => OvColor;
    RGBColor: new (r: number, g: number, b: number) => OvColor;
    EdgeSettings: new (showEdges: boolean, color: OvColor, threshold: number) => unknown;
  };

  interface Window {
    OV?: OvNamespace;
    __stepStockTakeWarmedOcctWorker?: OcctWorkerFactory;
  }
}

export {};
