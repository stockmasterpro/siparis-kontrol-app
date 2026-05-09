import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
  // File operations
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, data) => ipcRenderer.invoke('write-file', filePath, data),

  // External links
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Notifications
  showNotification: (options) => ipcRenderer.invoke('show-notification', options),
  testNotification: () => ipcRenderer.invoke('test-notification'),
  getNotificationSound: () => ipcRenderer.invoke('get-notification-sound'),
  onPlayNotificationSound: (callback) => {
    ipcRenderer.on('play-notification-sound', callback);
  },

  // PDF operations
  savePDF: (pdfBlob, fileName) => ipcRenderer.invoke('save-pdf', pdfBlob, fileName),

  // Folder picker
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // Printer operations
  getPrinters: () => ipcRenderer.invoke('get-printers'),

  // License operations
  validateLicense: (key) => ipcRenderer.invoke('validate-license', key),
  isLicensed: () => ipcRenderer.invoke('is-licensed'),

  // License events
  onLicenseValidated: (callback) => {
    ipcRenderer.on('license-validated', callback);
  },

  // Product Image operations
  saveProductImage: (data) => ipcRenderer.invoke('save-product-image', data),
  deleteProductImage: (filePath) => ipcRenderer.invoke('delete-product-image', filePath),
  openProductImagesFolder: (data) => ipcRenderer.invoke('open-product-images-folder', data),
  getImagesBasePath: () => ipcRenderer.invoke('get-images-base-path'),

  // Window operations
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  isFullScreen: () => ipcRenderer.invoke('is-fullscreen'),
});
