const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, protocol, session, Tray } = require("electron");
const { lstat, readFile, writeFile } = require("node:fs/promises");
const { basename, dirname, resolve, sep } = require("node:path");
const { pathToFileURL } = require("node:url");

protocol.registerSchemesAsPrivileged([
  { scheme: "aze", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const rendererRoot = resolve(__dirname, "renderer");
const startPage = "aze://desktop/index.html";

const trayColors = { stopped: "#8b95a3", working: "#23b878", paused: "#ffbd3b" };
const trayLabels = { "signed-out": "Anmeldung erforderlich", loading: "Status wird geladen",
  stopped: "Ausgestempelt", working: "Eingestempelt", paused: "In Pause" };

function statusIcon(color) {
  const width = 16;
  const bytes = Buffer.alloc(width * width * 4);
  const [red, green, blue] = color.slice(1).match(/../g).map((value) => parseInt(value,16));
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const radius = Math.hypot(x - 7.5, y - 7.5);
      if (radius > 6.8) continue;
      const offset = (y * width + x) * 4;
      bytes.set(radius > 5.7 ? [45, 38, 29, 255] : [blue, green, red, 255], offset);
    }
  }
  return nativeImage.createFromBitmap(bytes, { width, height: width, scaleFactor: 1 });
}

async function readLocalBranding() {
  const runtime = dirname(process.execPath);
  const location = /^runtime-\d+\.\d+\.\d+-x64$/.test(basename(runtime)) ? dirname(runtime) : runtime;
  const entries = await Promise.all([
    ["container", "nextway-container"], ["logoLight", "nextway-logo-light"], ["logoDark", "nextway-logo-dark"],
  ].map(async ([key, stem]) => {
    for (const extension of ["png", "jpg", "jpeg"]) {
      const path = resolve(location, `${stem}.${extension}`);
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.size > 12 * 1024 * 1024) continue;
        const bytes = await readFile(path);
        const isPng = extension === "png";
        const signature = isPng ? "89504e470d0a1a0a" : "ffd8ff";
        if (bytes.subarray(0, signature.length / 2).toString("hex") !== signature) continue;
        return [key, { path: `/local-branding/${stem}.${extension}`, bytes, mime: isPng ? "image/png" : "image/jpeg" }];
      } catch { /* Try the next filename or use the bundled branding. */ }
    }
    return null;
  }));
  return Object.fromEntries(entries.filter(Boolean));
}

let showExistingWindow;
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showExistingWindow?.());
  app.whenReady().then(start);
}

async function start() {
  const localBranding = await readLocalBranding();
  protocol.handle("aze", (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "desktop" || request.method !== "GET") {
      return new Response(null, { status: 404 });
    }
    const image = Object.values(localBranding).find((entry) => entry.path === url.pathname);
    if (image) return new Response(image.bytes, { headers: { "Content-Type": image.mime } });
    // Only serve the entry point and Vite's hashed bundles.
    if (url.pathname !== "/index.html" && !/^\/assets\/[A-Za-z0-9_-]+\.(js|css|png|jpg|jpeg|webp)$/.test(url.pathname)) {
      return new Response(null, { status: 404 });
    }
    const file = resolve(rendererRoot, "." + url.pathname);
    if (!file.startsWith(rendererRoot + sep)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({
    title: "Nextway · Arbeitszeiterfassung",
    width: 1120,
    height: 760,
    minWidth: 420,
    minHeight: 520,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
      preload: resolve(__dirname, "preload.cjs"),
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const trusted = (event) => event.sender === window.webContents && event.senderFrame?.url === startPage;
  const showWindow = () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  showExistingWindow = showWindow;

  let tray = null;
  let quitting = false;
  let pdfSaving = false;
  let state = { status: "signed-out", canPause: false, busy: false };
  const icons = Object.fromEntries(Object.entries(trayColors).map(([name, color]) => [name, statusIcon(color)]));

  function updateTray() {
    if (!tray) return;
    tray.setImage(icons[state.status] ?? icons.stopped);
    tray.setToolTip("Nextway · Arbeitszeiterfassung: " + trayLabels[state.status]);
    const item = (label, action) => ({ label, enabled: !state.busy, click: () => {
      if (!window.isDestroyed()) window.webContents.send("desktop:tray-action", action);
    } });
    const actions = [];
    if (state.status === "stopped") actions.push(item("Einstempeln", "in"));
    if (state.status === "working" && state.canPause) actions.push(item("Pause starten", "pause"));
    if (state.status === "paused") actions.push(item("Pause beenden", "resume"));
    if (state.status === "working" || state.status === "paused") actions.push(item("Ausstempeln", "out"));
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: trayLabels[state.status], enabled: false }, ...actions, { type: "separator" },
      { label: "Fenster öffnen", click: showWindow },
      { label: "Beenden", click: () => app.quit() },
    ]));
  }

  if (process.platform === "win32") {
    try {
      tray = new Tray(icons.stopped);
      tray.on("double-click", showWindow);
      updateTray();
    } catch (error) {
      tray = null;
      console.error("Infobereich nicht verfügbar", error);
    }
  }

  app.on("before-quit", () => { quitting = true; });
  window.on("query-session-end", () => { quitting = true; });
  window.on("close", (event) => {
    if (pdfSaving && !quitting) { event.preventDefault(); return; }
    if (tray && !quitting && state.status !== "signed-out") {
      event.preventDefault();
      window.hide();
    }
  });
  window.webContents.on("render-process-gone", () => {
    state = { status: "signed-out", canPause: false, busy: false };
    updateTray();
    showWindow();
  });

  ipcMain.on("desktop:tray-state", (event, next) => {
    if (!trusted(event) || !next || !Object.hasOwn(trayLabels, next.status) ||
        typeof next.canPause !== "boolean" || typeof next.busy !== "boolean") return;
    state = next;
    updateTray();
  });
  ipcMain.on("desktop:clock-problem", (event) => { if (trusted(event)) showWindow(); });
  ipcMain.on("desktop:print-report", (event) => {
    if (trusted(event)) window.webContents.print({ landscape: true });
  });
  ipcMain.handle("desktop:branding-assets", (event) => {
    if (!trusted(event)) return {};
    return Object.fromEntries(Object.entries(localBranding).map(([key, value]) => [key, `aze://desktop${value.path}`]));
  });
  ipcMain.handle("desktop:save-monthly-pdf", async (event, month) => {
    if (!trusted(event) || typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || pdfSaving) return false;
    pdfSaving = true;
    try {
      const content = await window.webContents.printToPDF({ pageSize: "A4", preferCSSPageSize: true, printBackground: true });
      const result = await dialog.showSaveDialog(window, {
        defaultPath: `monatsnachweis-${month}.pdf`,
        filters: [{ name: "PDF-Dokument", extensions: ["pdf"] }],
      });
      if (result.canceled || !result.filePath) return false;
      await writeFile(result.filePath, content);
      return true;
    } finally {
      pdfSaving = false;
    }
  });
  session.defaultSession.on("will-download", (event, item, contents) => {
    if (contents !== window.webContents || contents.getURL() !== startPage ||
        !item.getURL().startsWith("blob:") ||
        !/^arbeitszeiterfassung-\d{4}-(0[1-9]|1[0-2])\.csv$/.test(item.getFilename())) {
      event.preventDefault();
      return;
    }
    item.setSaveDialogOptions({
      defaultPath: item.getFilename(),
      filters: [{ name: "CSV-Datei", extensions: ["csv"] }],
    });
  });
  void window.loadURL(startPage);
}

app.on("window-all-closed", () => app.quit());
