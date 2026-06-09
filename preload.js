const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ---------- 串口相关 API ----------
  scanPorts: () => ipcRenderer.invoke('scan-ports'),
  connectPort: (com) => ipcRenderer.invoke('connect-port', com),
  disconnectPort: (com) => ipcRenderer.invoke('disconnect-port', com),
  startDetection: (com) => ipcRenderer.invoke('start-detection', com),
  onSerialDataMain: (callback) => ipcRenderer.on('serial-data-main', (event, data) => callback(data)),
  onSerialDataDetail: (callback) => ipcRenderer.on('serial-data-detail', (event, data) => callback(data)),
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (event, progress) => callback(progress)),
  onDiagnosisComplete: (callback) => ipcRenderer.on('diagnosis-complete', (event, data) => callback(data)),
  
  // ---------- AI 诊断分析 API ----------
  saveAIConfig: (config) => ipcRenderer.invoke('save-ai-config', config),
  getAIConfig: () => ipcRenderer.invoke('get-ai-config'),
  analyzeWithAI: (diagnosisData) => ipcRenderer.invoke('analyze-with-ai', diagnosisData), // 添加缺失的方法
  startAIStreamAnalysis: (diagnosisData) => {
    ipcRenderer.send('start-ai-analysis', diagnosisData);
  },
  onAIStreamData: (callback) => {
    ipcRenderer.on('ai-stream-data', (event, chunk) => callback(chunk));
  },
  onAIStreamEnd: (callback) => {
    ipcRenderer.on('ai-stream-end', () => callback());
  },
  onAIStreamError: (callback) => {
    ipcRenderer.on('ai-stream-error', (event, error) => callback(error));
  },
  removeAIStreamListeners: () => {
    ipcRenderer.removeAllListeners('ai-stream-data');
    ipcRenderer.removeAllListeners('ai-stream-end');
    ipcRenderer.removeAllListeners('ai-stream-error');
  },

  // ---------- 通用对话 API ----------
  sendChatMessage: (messages, fileInfo) => ipcRenderer.send('chat-with-ai', messages, fileInfo),
  onChatStreamData: (callback) => ipcRenderer.on('chat-stream-data', (event, chunk) => callback(chunk)),
  onChatStreamEnd: (callback) => ipcRenderer.on('chat-stream-end', () => callback()),
  onChatStreamError: (callback) => ipcRenderer.on('chat-stream-error', (event, error) => callback(error)),
  removeChatStreamListeners: () => {
    ipcRenderer.removeAllListeners('chat-stream-data');
    ipcRenderer.removeAllListeners('chat-stream-end');
    ipcRenderer.removeAllListeners('chat-stream-error');
  },

  // ---------- 图像生成 API ----------
  generateImage: (prompt, options) => ipcRenderer.send('generate-image', prompt, options),
  onImageGenerated: (callback) => ipcRenderer.on('generate-image-success', (event, urls) => callback(urls)),
  onImageGenerationError: (callback) => ipcRenderer.on('generate-image-error', (event, error) => callback(error)),

  // ---------- 视频生成 API ----------
  generateVideo: (prompt, options) => ipcRenderer.send('generate-video', prompt, options),
  onVideoStarted: (callback) => ipcRenderer.on('video-generation-started', (event, data) => callback(data)),
  onVideoTaskCreated: (callback) => ipcRenderer.on('video-task-created', (event, data) => callback(data)),
  onVideoProgress: (callback) => ipcRenderer.on('video-task-progress', (event, data) => callback(data)),
  onVideoCompleted: (callback) => ipcRenderer.on('video-task-completed', (event, data) => callback(data)),
  onVideoFailed: (callback) => ipcRenderer.on('video-task-failed', (event, data) => callback(data)),
  onVideoError: (callback) => ipcRenderer.on('generate-video-error', (event, error) => callback(error)),
  queryVideoTask: (taskId) => ipcRenderer.invoke('query-video-task', taskId),

  // ---------- 图像识别专用 API ----------
  analyzeImage: (imageData, prompt) => {
    const messages = [
      { role: 'user', content: prompt || '请详细描述这张图片的内容' }
    ];
    ipcRenderer.send('chat-with-ai', messages, { data: imageData, type: 'image' });
  },

  // ---------- 移除监听器 ----------
  removeVideoListeners: () => {
    ipcRenderer.removeAllListeners('video-generation-started');
    ipcRenderer.removeAllListeners('video-task-created');
    ipcRenderer.removeAllListeners('video-task-progress');
    ipcRenderer.removeAllListeners('video-task-completed');
    ipcRenderer.removeAllListeners('video-task-failed');
    ipcRenderer.removeAllListeners('generate-video-error');
  },

  // ---------- 原有其他 API ----------
  checkDuplicate: (code, callback) => {
    ipcRenderer.send('check-duplicate', code);
    ipcRenderer.once('duplicate-result', (event, isDuplicate) => callback(isDuplicate));
  }
});

contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    send: (channel, data) => {
      const validChannels = ['check-duplicate'];
      if (validChannels.includes(channel)) {
        ipcRenderer.send(channel, data);
      }
    },
    on: (channel, func) => {
      const validChannels = ['duplicate-result'];
      if (validChannels.includes(channel)) {
        ipcRenderer.on(channel, (event, ...args) => func(...args));
      }
    }
  }
});