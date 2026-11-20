const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  printReport: () => ipcRenderer.send("desktop:print-report"),
});
