const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;

let backendProcess = null;
let mainWindow = null;

function appRoot() {
  if (!app.isPackaged) {
    return path.resolve(__dirname, "..");
  }

  const unpackedAppRoot = path.join(process.resourcesPath, "app");
  return fs.existsSync(unpackedAppRoot) ? unpackedAppRoot : process.resourcesPath;
}

function pythonCandidates(root) {
  if (process.env.PYTHON) {
    return [process.env.PYTHON];
  }

  if (process.platform === "win32") {
    return [
      path.join(root, ".venv", "Scripts", "python.exe"),
      "python",
      "py",
    ];
  }

  return [
    path.join(root, ".venv", "bin", "python"),
    "python3.12",
    "python3",
    "python",
  ];
}

function findAvailablePort(startPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        findAvailablePort(startPort + 1).then(resolve, reject);
        return;
      }

      reject(error);
    });

    server.once("listening", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });

    server.listen(startPort, HOST);
  });
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePython(root) {
  const candidates = pythonCandidates(root);
  const localCandidate = candidates.find(
    (candidate) => path.isAbsolute(candidate) && fileExists(candidate),
  );

  return localCandidate || candidates.find((candidate) => !path.isAbsolute(candidate));
}

function waitForBackend(port, timeoutMs = 30000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    function check() {
      const request = http.get({ host: HOST, port, path: "/", timeout: 1000 }, (response) => {
        response.resume();
        resolve();
      });

      request.on("error", () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error("The local backend did not start in time."));
          return;
        }

        setTimeout(check, 300);
      });

      request.on("timeout", () => {
        request.destroy();
      });
    }

    check();
  });
}

async function startBackend() {
  const root = appRoot();
  const python = resolvePython(root);

  if (!python) {
    throw new Error(
      "Python was not found. Install Python 3.12 and the app requirements first.",
    );
  }

  const port = await findAvailablePort(DEFAULT_PORT);
  const env = {
    ...process.env,
    PORT: String(port),
    HOST,
  };

  backendProcess = spawn(
    python,
    [
      "-m",
      "uvicorn",
      "backend.app.main:app",
      "--host",
      HOST,
      "--port",
      String(port),
    ],
    {
      cwd: root,
      env,
      stdio: app.isPackaged ? "ignore" : "inherit",
      windowsHide: true,
    },
  );

  backendProcess.once("exit", (code) => {
    backendProcess = null;
    if (mainWindow && code !== 0) {
      dialog.showErrorBox(
        "Backend stopped",
        "The local analysis service stopped unexpectedly.",
      );
    }
  });

  await waitForBackend(port);
  return `http://${HOST}:${port}`;
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    title: "CNC STEP Stock Checker",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(url);
}

async function boot() {
  try {
    const url = await startBackend();
    createWindow(url);
  } catch (error) {
    dialog.showErrorBox("Unable to start app", error.message);
    app.quit();
  }
}

app.whenReady().then(boot);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
});
