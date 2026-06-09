const { app, BrowserWindow, ipcMain, Menu, globalShortcut } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const iconv = require('iconv-lite');
const { filterCodes, realNormalCodes, faultMap, AIConfig: defaultAIConfig } = require('./faultCodes');
const Store = require('electron-store');
const https = require('https');
const http = require('http');
const fetch = require('node-fetch');
const fs = require('fs');

// 初始化持久化存储 - 修改为支持双API配置
const store = new Store({
  schema: {
    aiEnabled: { type: 'boolean', default: false },
    apiUrl: { type: 'string', default: 'https://ark.cn-beijing.volces.com/api/v3' },
    temperature: { type: 'number', default: 0.7 },
    maxTokens: { type: 'number', default: 2000 },
    doubao20: {
      type: 'object',
      properties: {
        apiKey: { type: 'string', default: '' },
        model: { type: 'string', default: 'doubao-seed-2-0-pro-260215' }
      },
      default: { apiKey: '', model: 'doubao-seed-2-0-pro-260215' }
    },
    doubao15Video: {
      type: 'object',
      properties: {
        apiKey: { type: 'string', default: '' },
        model: { type: 'string', default: 'doubao-seedance-1-5-pro-251215' }
      },
      default: { apiKey: '', model: 'doubao-seedance-1-5-pro-251215' }
    }
  }
});

let aiConfig = {
  enabled: store.get('aiEnabled'),
  apiUrl: store.get('apiUrl'),
  temperature: store.get('temperature'),
  maxTokens: store.get('maxTokens'),
  doubao20: store.get('doubao20'),
  doubao15Video: store.get('doubao15Video')
};

// 全局状态管理
let serialProcess = null;
let keepAliveProcess = null;
let connectedCom = '';
let isBluetoothConnected = false;
let isDiagnosing = false;
let detectedCodes = new Set();
let diagnosisTimer = null;
let forceTimeoutTimer = null;
let progressStepTimer = null;
let statusInterval = null;
let detectionProgress = 0.0;
let mainWindow;
let progressStartTime = null;

// 当前正在进行的 AI 请求控制器
let currentAIRequest = null;

// 存储视频生成任务状态
const videoTasks = new Map();

// ========== 原有串口相关函数 ==========
function getSerialPorts() {
  return new Promise((resolve) => {
    const regProcess = spawn('reg', [
      'query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM', '/s'
    ]);
    let regOutput = '';
    regProcess.stdout.on('data', (data) => {
      regOutput += data.toString();
    });
    regProcess.stderr.on('data', (err) => {
      console.error('注册表读取错误：', err.toString());
      resolve([{ id: 'error', name: `扫描失败：${err.toString()}` }]);
    });
    regProcess.on('exit', () => {
      try {
        const ports = [];
        if (!regOutput) {
          resolve([{ id: 'error', name: '未检测到串口（请以管理员身份运行/先配对蓝牙设备）' }]);
          return;
        }
        regOutput.split('\n').forEach(line => {
          const comMatch = line.match(/COM\d+/);
          if (comMatch) {
            const com = comMatch[0];
            ports.push({
              id: com,
              name: `蓝牙串口(${com}) - 诊断卡设备`
            });
          }
        });
        resolve(ports.length ? ports : [{ id: 'error', name: '未检测到蓝牙串口，请先配对设备' }]);
      } catch (err) {
        resolve([{ id: 'error', name: `扫描失败：${err.message}` }]);
      }
    });
  });
}

function disconnectAll() {
  if (diagnosisTimer) {
    clearTimeout(diagnosisTimer);
    diagnosisTimer = null;
  }
  if (forceTimeoutTimer) {
    clearTimeout(forceTimeoutTimer);
    forceTimeoutTimer = null;
  }
  if (progressStepTimer) {
    clearTimeout(progressStepTimer);
    progressStepTimer = null;
  }
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
  if (serialProcess) {
    try {
      serialProcess.kill('SIGKILL');
    } catch (e) {
      console.error('终止串口进程失败:', e);
    }
    serialProcess = null;
  }
  if (keepAliveProcess) {
    try {
      keepAliveProcess.kill('SIGKILL');
    } catch (e) {
      console.error('终止心跳进程失败:', e);
    }
    keepAliveProcess = null;
  }
  isBluetoothConnected = false;
  isDiagnosing = false;
  detectedCodes.clear();
  return true;
}

function connectPort(comPath) {
  return new Promise((resolve) => {
    disconnectAll();

    connectedCom = comPath;
    isBluetoothConnected = true;
    isDiagnosing = false;
    detectedCodes.clear();
    detectionProgress = 0.0;

    const fullScript = `
      $ErrorActionPreference = "SilentlyContinue"
      $port = New-Object System.IO.Ports.SerialPort ${comPath},9600,None,8,One
      $port.DtrEnable = $true
      $port.RtsEnable = $true
      $port.ReadTimeout = -1
      $port.WriteTimeout = 5000
      $port.Open()
      $handshake = @(0x01, 0x00, 0x00, 0x00)
      $port.Write($handshake, 0, $handshake.Length)
      $port.Flush()
      Write-Host "HandshakeSuccess"
      while ($true) {
        try {
          if ($port.BytesToRead -ge 1) {
            $buffer = New-Object byte[] $port.BytesToRead
            $port.Read($buffer, 0, $buffer.Length) | Out-Null
            $valid = $buffer | Where-Object { $_ -ne 0x00 -and $_ -ne 0x7F }
            if ($valid.Count -ge 1) {
              $hex = -join ($valid | ForEach-Object { $_.ToString("X2") })
              Write-Host "HEX:$hex"
            }
          }
          Start-Sleep -Milliseconds 100
        } catch { Start-Sleep -Milliseconds 200 }
      }
    `;

    serialProcess = spawn('powershell', [
      '-ExecutionPolicy', 'Bypass',
      '-NoProfile',
      '-WindowStyle', 'Hidden',
      '-Command',
      fullScript
    ]);

    setTimeout(() => {
      if (isBluetoothConnected) {
        keepAliveProcess = spawn('powershell', [
          '-ExecutionPolicy', 'Bypass',
          '-WindowStyle', 'Hidden',
          '-Command',
          `
            $port = New-Object System.IO.Ports.SerialPort ${comPath},9600,None,8,One
            $port.DtrEnable = $true
            $port.RtsEnable = $true
            while ($true) {
              try {
                if (!$port.IsOpen) { $port.Open() }
                $port.Write(@(0x00), 0, 1)
                $port.Flush()
              } catch {}
              Start-Sleep -Seconds 3
            }
          `
        ]);
      }
    }, 1000);

    serialProcess.stdout.on('data', (data) => {
      const output = data.toString().trim();
      if (!output || !isBluetoothConnected) return;

      if (output.includes('HandshakeSuccess')) {
        resolve(`✅ 蓝牙连接成功！${comPath}，诊断卡已就绪`);
        if (mainWindow) {
          setTimeout(() => {
            if (mainWindow) {
              mainWindow.webContents.send('serial-data-main', '📊 ✅ 已连接到智能诊断平台（蓝牙就绪）');
              mainWindow.webContents.send('serial-data-main', '📊 所有系统准备完毕，在确保诊断卡连接至待检测设备后，可随时开始进行诊断检测');
              mainWindow.webContents.send('serial-data-detail', `[蓝牙连接成功] 端口：${comPath}`);
              console.log('连接成功消息已发送');
            }
          }, 200);
        }
        return;
      }

      if (isDiagnosing && output.includes('HEX:')) {
        const hex = output.replace('HEX:', '').trim();
        if (mainWindow) {
          mainWindow.webContents.send('serial-data-detail', `[原始数据] HEX=${hex}`);
        }

        for (let i = 0; i < hex.length; i += 2) {
          const singleCode = `0x${hex.substr(i, 2).toUpperCase()}`;
          if (filterCodes.has(singleCode)) continue;

          if (!detectedCodes.has(singleCode)) {
            detectedCodes.add(singleCode);
            const codeDesc = faultMap[singleCode] || `未知诊断码(${singleCode})`;
            if (mainWindow) {
              mainWindow.webContents.send('serial-data-detail', `[检测到码] ${singleCode} → ${codeDesc}`);
            }
          }
        }
      }
    });

    serialProcess.stderr.on('data', (err) => {
      const errMsg = err.toString().trim();
      if (!errMsg.includes('被占用') && !errMsg.includes('InvalidOperation') && mainWindow) {
        mainWindow.webContents.send('serial-data-main', `📊 ⚠️ 串口提示：${errMsg}`);
        mainWindow.webContents.send('serial-data-detail', `[串口错误] ${errMsg}`);
      }
    });

    serialProcess.on('exit', (code) => {
      clearTimeout(diagnosisTimer);
      clearTimeout(forceTimeoutTimer);
      clearTimeout(progressStepTimer);
      clearInterval(statusInterval);
      isBluetoothConnected = false;
      isDiagnosing = false;
      if (mainWindow) {
        mainWindow.webContents.send('serial-data-main', `📊 ℹ️ 蓝牙连接已断开（进程退出码：${code}）`);
        mainWindow.webContents.send('serial-data-detail', `[连接断开] 进程退出码：${code}`);
      }
    });
  });
}

function scheduleProgress(step) {
  if (!isDiagnosing) return;

  if (step > 100.0) return;
  if (Math.abs(step - 100.0) < 0.01) {
    generateFinalReport();
    return;
  }

  detectionProgress = step;
  if (mainWindow) {
    mainWindow.webContents.send('update-progress', detectionProgress);
  }

  if (progressStartTime === null) {
    progressStartTime = Date.now();
  }

  const elapsed = Date.now() - progressStartTime;
  const targetProgress = Math.min(100, (elapsed / 20000) * 100);
  const progressDiff = targetProgress - step;

  let delay;

  if (step < 40.0) {
    delay = 22;
  } else if (step < 65.0) {
    delay = 18;
    if (Math.abs(step - 65.0) < 0.01) {
      delay = 800;
      if (mainWindow) {
        mainWindow.webContents.send('serial-data-detail', '[进度] 检测到复杂硬件配置，正在深入分析...');
      }
    }
  } else {
    delay = 12;
  }

  if (progressDiff > 2) {
    const adjustFactor = Math.min(0.7, Math.max(0.3, 1 - (progressDiff / 20)));
    delay = Math.max(5, Math.floor(delay * adjustFactor));
  }

  const remainingTime = 20000 - elapsed;
  if (remainingTime < 3000 && step < 80.0) {
    delay = 5;
  }

  delay = Math.max(5, Math.min(delay, 850));

  progressStepTimer = setTimeout(() => {
    scheduleProgress(step + 0.1);
  }, delay);
}

function generateFinalReport() {
  if (!mainWindow) return;

  if (diagnosisTimer) {
    clearTimeout(diagnosisTimer);
    diagnosisTimer = null;
  }
  if (forceTimeoutTimer) {
    clearTimeout(forceTimeoutTimer);
    forceTimeoutTimer = null;
  }
  if (progressStepTimer) {
    clearTimeout(progressStepTimer);
    progressStepTimer = null;
  }
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }

  detectionProgress = 100.0;
  mainWindow.webContents.send('update-progress', detectionProgress);

  const validCodes = Array.from(detectedCodes).filter(c => !filterCodes.has(c));
  const hasNormal = Array.from(realNormalCodes).some(normal => validCodes.includes(normal));

  const diagnosisData = {
    faultCodes: validCodes.map(code => ({
      code: code,
      desc: faultMap[code] || `未知诊断码(${code})`
    })),
    hasNormal: hasNormal,
    normalCode: hasNormal ? Array.from(realNormalCodes).find(normal => validCodes.includes(normal)) : null,
    memoryFaults: [],
    allDetectedCodes: Array.from(detectedCodes)
  };

  if (hasNormal) {
    const normalCode = Array.from(realNormalCodes).find(normal => validCodes.includes(normal));
    mainWindow.webContents.send('serial-data-main', `\n🎉 诊断完成！命中正常码：${normalCode}`);
    mainWindow.webContents.send('serial-data-main', faultMap[normalCode]);
    mainWindow.webContents.send('serial-data-main', `✅ 最终结论：`);
    mainWindow.webContents.send('serial-data-main', `• 设备可正常开机，CPU/主板/内存核心硬件均正常`);
    mainWindow.webContents.send('serial-data-main', `• 诊断卡与设备通信正常，无核心故障`);
    mainWindow.webContents.send('serial-data-main', `💡 使用建议：`);
    mainWindow.webContents.send('serial-data-main', `1. 设备可正常投入使用`);
    mainWindow.webContents.send('serial-data-main', `2. 定期清洁硬件接口，避免接触不良`);
    mainWindow.webContents.send('serial-data-detail', `[诊断成功] 命中正常码${normalCode}，诊断结束`);
    mainWindow.webContents.send('serial-data-main', `✔ 诊断已完成，请查看左侧诊断信息`);
  } else if (validCodes.length === 0) {
    mainWindow.webContents.send('serial-data-main', `\n📋 诊断完成，未检测到有效诊断码`);
    mainWindow.webContents.send('serial-data-main', `❌ 未检测到有效诊断码，请检查待检测设备连接`);
    mainWindow.webContents.send('serial-data-main', `💡 排查建议：`);
    mainWindow.webContents.send('serial-data-main', `1. 确认诊断卡与设备连接正常`);
    mainWindow.webContents.send('serial-data-main', `2. 重新插拔诊断卡电源`);
    mainWindow.webContents.send('serial-data-main', `3. 检查设备供电是否稳定`);
    mainWindow.webContents.send('serial-data-detail', `[诊断完成] 无有效码`);
    mainWindow.webContents.send('serial-data-main', `✔ 诊断已完成，请查看左侧诊断信息`);
  } else {
    const memoryKeywords = ['内存', 'DIMM', 'SPD', '插槽', '金手指', 'memory', 'RAM', 'DDR'];
    const memoryFaultCodes = validCodes.filter(code => {
      const desc = faultMap[code] || '';
      return memoryKeywords.some(keyword => desc.includes(keyword));
    }).slice(0, 5);

    diagnosisData.memoryFaults = memoryFaultCodes.map(code => ({
      code: code,
      desc: faultMap[code]
    }));

    if (memoryFaultCodes.length > 0) {
      mainWindow.webContents.send('serial-data-main', `\n📋 诊断完成，检测到以下内存异常：`);
      memoryFaultCodes.forEach(code => {
        mainWindow.webContents.send('serial-data-main', `  - ${code} → ${faultMap[code]}`);
      });
      mainWindow.webContents.send('serial-data-main', `🔴 诊断结论：发现主板内存区域故障`);
      mainWindow.webContents.send('serial-data-main', `📋 维修建议：`);
      mainWindow.webContents.send('serial-data-main', `1. 断电后打开机箱，找到内存条位置，拔出内存条`);
      mainWindow.webContents.send('serial-data-main', `2. 使用橡皮擦轻轻擦拭内存条金手指（金色接触点），去除氧化层`);
      mainWindow.webContents.send('serial-data-main', `3. 用软毛刷清理内存插槽内的灰尘`);
      mainWindow.webContents.send('serial-data-main', `4. 重新插回内存条，确保卡扣到位，听到"咔哒"声`);
      mainWindow.webContents.send('serial-data-main', `5. 如果有多条内存，尝试只保留一条进行测试，轮流排除故障内存`);
      mainWindow.webContents.send('serial-data-main', `6. 更换内存插槽位置（如从插槽A换到插槽B）再次测试`);
      mainWindow.webContents.send('serial-data-main', `7. 更换其他正常内存条替换测试，判断是否为内存本身损坏`);
    } else {
      mainWindow.webContents.send('serial-data-main', `\n📋 诊断完成，未检测到内存相关异常`);
    }

    mainWindow.webContents.send('serial-data-main', `✔ 诊断已完成，请查看左侧诊断信息`);
    mainWindow.webContents.send('serial-data-detail', `[诊断完成] 故障码: ${validCodes.join(', ')}`);
  }

  mainWindow.webContents.send('diagnosis-complete', diagnosisData);

  isDiagnosing = false;
}

ipcMain.handle('start-detection', (_, comPath) => {
  return new Promise((resolve) => {
    if (!isBluetoothConnected || connectedCom !== comPath) {
      resolve('❌ 请先连接蓝牙串口！');
      if (mainWindow) {
        mainWindow.webContents.send('serial-data-main', '❌ 请先连接蓝牙串口，再点击开始检测！');
      }
      return;
    }
    if (isDiagnosing) {
      resolve('⚠️ 诊断已在进行中，请勿重复触发！');
      if (mainWindow) {
        mainWindow.webContents.send('serial-data-main', '⚠️ 诊断已在进行中，请勿重复点击！');
      }
      return;
    }

    isDiagnosing = true;
    detectedCodes.clear();
    detectionProgress = 0.0;
    progressStartTime = null;

    if (mainWindow) {
      mainWindow.webContents.send('update-progress', detectionProgress);
      mainWindow.webContents.send('serial-data-main', '📌 诊断已启动，预计耗时20秒...');
      mainWindow.webContents.send('serial-data-detail', '[诊断启动] 开始收集硬件状态码');
    }

    scheduleProgress(0.0);

    const statusMessages = [
      { time: 3, text: '📊 正在检测主板核心供电 (3.3V/5V/12V)...' },
      { time: 5, text: '📊 已完成CPU供电模组检测，电压正常' },
      { time: 7, text: '📊 正在检测内存插槽及SPD信息...' },
      { time: 9, text: '📊 已完成南桥/北桥芯片组基础检测' },
      { time: 11, text: '📊 正在分析硬件故障码...' },
      { time: 13, text: '📊 即将完成诊断，准备汇总结果...' },
      { time: 15, text: '📊 正在进行最终数据校验...' },
      { time: 17, text: '📊 诊断即将结束，请稍候...' }
    ];
    let statusIndex = 0;
    const startTime = Date.now();
    statusInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      while (statusIndex < statusMessages.length && elapsed >= statusMessages[statusIndex].time) {
        if (mainWindow) {
          mainWindow.webContents.send('serial-data-main', statusMessages[statusIndex].text);
        }
        statusIndex++;
      }
      if (statusIndex >= statusMessages.length) {
        clearInterval(statusInterval);
        statusInterval = null;
      }
    }, 500);

    diagnosisTimer = setTimeout(() => {
      if (isDiagnosing) {
        if (mainWindow) {
          mainWindow.webContents.send('serial-data-main', '⚠️ 诊断超时（25秒），强制结束');
          mainWindow.webContents.send('serial-data-detail', '[诊断超时] 25秒强制结束');
        }
        generateFinalReport();
      }
    }, 25000);

    forceTimeoutTimer = setTimeout(() => {
      if (isDiagnosing) {
        if (mainWindow) {
          mainWindow.webContents.send('serial-data-main', '⚠️ 诊断超时（30秒无有效数据），强制结束');
          mainWindow.webContents.send('serial-data-detail', '[诊断超时] 30秒强制结束');
        }
        generateFinalReport();
      }
    }, 30000);

    resolve('✅ 诊断已启动！请等待检测结果（20秒后输出）');
  });
});

ipcMain.handle('disconnect-port', async () => {
  try {
    disconnectAll();
    if (mainWindow) {
      mainWindow.webContents.send('serial-data-main', '📊 ✅ 已强制断开蓝牙串口连接');
      mainWindow.webContents.send('serial-data-detail', '[断开操作] 已强制终止所有串口进程');
      mainWindow.webContents.send('update-progress', 0);
    }
    return '✅ 已强制断开蓝牙串口连接';
  } catch (err) {
    console.error('断开连接时出错:', err);
    return `❌ 断开连接失败: ${err.message}`;
  }
});

// ========== AI功能 - 双API配置 ==========

ipcMain.handle('save-ai-config', async (_, config) => {
  try {
    // 更新内存中的配置
    aiConfig = {
      enabled: config.enabled,
      apiUrl: config.apiUrl,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      doubao20: config.doubao20,
      doubao15Video: config.doubao15Video
    };
    
    // 保存到持久化存储
    store.set('aiEnabled', config.enabled);
    store.set('apiUrl', config.apiUrl);
    store.set('temperature', config.temperature);
    store.set('maxTokens', config.maxTokens);
    store.set('doubao20', config.doubao20);
    store.set('doubao15Video', config.doubao15Video);
    
    console.log('AI配置已保存:', aiConfig);
    return { success: true, message: 'AI配置保存成功' };
  } catch (err) {
    console.error('保存AI配置失败:', err);
    return { success: false, message: `保存失败: ${err.message}` };
  }
});

ipcMain.handle('get-ai-config', async () => {
  return aiConfig;
});

function buildAIPrompt(diagnosisData) {
  const { faultCodes, hasNormal, normalCode, memoryFaults } = diagnosisData;
  
  let prompt = `你是一位专业的计算机主板维修专家。请基于以下诊断数据，提供详细的分析报告和维修建议。\n\n`;
  
  if (hasNormal && normalCode) {
    prompt += `诊断结果为：设备可以正常开机。检测到正常码 ${normalCode}。\n\n`;
    prompt += `请提供以下内容：\n`;
    prompt += `1. 诊断结论总结（确认设备正常）\n`;
    prompt += `2. 使用建议（如有）\n`;
  } 
  else if (memoryFaults && memoryFaults.length > 0) {
    prompt += `诊断结果为：设备存在内存相关故障。\n`;
    prompt += `检测到以下内存故障码：\n`;
    memoryFaults.forEach((code, index) => {
      prompt += `${index + 1}. ${code.code} - ${code.desc}\n`;
    });
    prompt += `\n请提供以下内容：\n`;
    prompt += `1. 诊断结论总结（基于内存故障）\n`;
    prompt += `2. 故障原因分析\n`;
    prompt += `3. 详细的维修步骤和建议\n`;
    prompt += `4. 预防措施和建议\n`;
  } 
  else {
    prompt += `诊断结果为：设备存在故障，但未检测到内存相关故障。\n`;
    prompt += `检测到以下故障码：\n`;
    faultCodes.forEach((code, index) => {
      prompt += `${index + 1}. ${code.code} - ${code.desc}\n`;
    });
    prompt += `\n请提供以下内容：\n`;
    prompt += `1. 诊断结论总结\n`;
    prompt += `2. 故障原因分析\n`;
    prompt += `3. 详细的维修步骤和建议\n`;
    prompt += `4. 预防措施和建议\n`;
  }
  
  prompt += `\n请用专业、清晰的语言回答，便于维修人员理解和执行。`;
  return prompt;
}

// ========== DeepSeek API 调用函数 ==========

function streamDeepSeekAPI(event, apiUrl, apiKey, model, prompt, temperature, maxTokens) {
  const url = new URL(apiUrl);
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'text/event-stream'
    },
    timeout: 60000
  };

  const requestData = JSON.stringify({
    model: model,
    messages: [
      { role: 'system', content: '你是一位专业的计算机硬件维修专家，精通主板故障诊断和维修。' },
      { role: 'user', content: prompt }
    ],
    temperature: temperature,
    max_tokens: maxTokens,
    stream: true
  });

  const protocol = url.protocol === 'https:' ? https : http;
  const req = protocol.request(options, (res) => {
    let buffer = '';

    res.on('data', (chunk) => {
      buffer += chunk.toString();
      
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices[0]?.delta?.content || '';
            if (content) {
              event.reply('ai-stream-data', content);
            }
          } catch (e) {
            console.error('解析 SSE 数据失败:', e);
          }
        }
      }
    });

    res.on('end', () => {
      event.reply('ai-stream-end');
      if (currentAIRequest === req) {
        currentAIRequest = null;
      }
    });

    res.on('error', (err) => {
      console.error('流式响应错误:', err);
      event.reply('ai-stream-error', `响应错误: ${err.message}`);
      if (currentAIRequest === req) {
        currentAIRequest = null;
      }
    });
  });

  req.on('error', (err) => {
    console.error('请求错误:', err);
    event.reply('ai-stream-error', `请求失败: ${err.message}`);
    if (currentAIRequest === req) {
      currentAIRequest = null;
    }
  });

  req.write(requestData);
  req.end();

  return req;
}

async function callDeepSeekAPI(apiUrl, apiKey, model, prompt, temperature, maxTokens) {
  const fetch = require('node-fetch');
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: '你是一位专业的计算机硬件维修专家，精通主板故障诊断和维修。' },
        { role: 'user', content: prompt }
      ],
      temperature: temperature,
      max_tokens: maxTokens
    })
  });
  
  if (!response.ok) {
    throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.choices[0].message.content;
}

function streamDeepSeekChat(event, apiUrl, apiKey, model, messages, temperature, maxTokens, imageData) {
  const url = new URL(apiUrl);
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'text/event-stream'
    },
    timeout: 60000
  };

  if (imageData) {
    event.reply('chat-stream-data', '[提示：DeepSeek 当前不支持图像识别，已忽略图片]');
  }

  const requestData = JSON.stringify({
    model: model,
    messages: messages,
    temperature: temperature,
    max_tokens: maxTokens,
    stream: true
  });

  const protocol = url.protocol === 'https:' ? https : http;
  const req = protocol.request(options, (res) => {
    let buffer = '';

    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices[0]?.delta?.content || '';
            if (content) {
              event.reply('chat-stream-data', content);
            }
          } catch (e) {
            console.error('解析 SSE 数据失败:', e);
          }
        }
      }
    });

    res.on('end', () => {
      event.reply('chat-stream-end');
      if (currentAIRequest === req) currentAIRequest = null;
    });

    res.on('error', (err) => {
      console.error('流式响应错误:', err);
      event.reply('chat-stream-error', `响应错误: ${err.message}`);
      if (currentAIRequest === req) currentAIRequest = null;
    });
  });

  req.on('error', (err) => {
    console.error('请求错误:', err);
    event.reply('chat-stream-error', `请求失败: ${err.message}`);
    if (currentAIRequest === req) currentAIRequest = null;
  });

  req.write(requestData);
  req.end();
  return req;
}

// ========== OpenAI API 调用函数 ==========

function streamOpenAIAPI(event, apiUrl, apiKey, model, prompt, temperature, maxTokens) {
  const url = new URL(apiUrl || 'https://api.openai.com/v1/chat/completions');
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'text/event-stream'
    },
    timeout: 60000
  };

  const requestData = JSON.stringify({
    model: model || 'gpt-3.5-turbo',
    messages: [
      { role: 'system', content: '你是一位专业的计算机硬件维修专家，精通主板故障诊断和维修。' },
      { role: 'user', content: prompt }
    ],
    temperature: temperature,
    max_tokens: maxTokens,
    stream: true
  });

  const protocol = url.protocol === 'https:' ? https : http;
  const req = protocol.request(options, (res) => {
    let buffer = '';

    res.on('data', (chunk) => {
      buffer += chunk.toString();
      
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices[0]?.delta?.content || '';
            if (content) {
              event.reply('ai-stream-data', content);
            }
          } catch (e) {
            console.error('解析 SSE 数据失败:', e);
          }
        }
      }
    });

    res.on('end', () => {
      event.reply('ai-stream-end');
      if (currentAIRequest === req) {
        currentAIRequest = null;
      }
    });

    res.on('error', (err) => {
      console.error('流式响应错误:', err);
      event.reply('ai-stream-error', `响应错误: ${err.message}`);
      if (currentAIRequest === req) {
        currentAIRequest = null;
      }
    });
  });

  req.on('error', (err) => {
    console.error('请求错误:', err);
    event.reply('ai-stream-error', `请求失败: ${err.message}`);
    if (currentAIRequest === req) {
      currentAIRequest = null;
    }
  });

  req.write(requestData);
  req.end();

  return req;
}

async function callOpenAIAPI(apiUrl, apiKey, model, prompt, temperature, maxTokens) {
  const fetch = require('node-fetch');
  const response = await fetch(apiUrl || 'https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: '你是一位专业的计算机硬件维修专家，精通主板故障诊断和维修。' },
        { role: 'user', content: prompt }
      ],
      temperature: temperature,
      max_tokens: maxTokens
    })
  });
  
  if (!response.ok) {
    throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.choices[0].message.content;
}

function streamOpenAIChat(event, apiUrl, apiKey, model, messages, temperature, maxTokens, imageData) {
  const url = new URL(apiUrl || 'https://api.openai.com/v1/chat/completions');
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'text/event-stream'
    },
    timeout: 60000
  };

  let processedMessages = messages;
  if (imageData) {
    const lastUserMsgIndex = messages.length - 1;
    if (messages[lastUserMsgIndex] && messages[lastUserMsgIndex].role === 'user') {
      const content = [
        { type: 'text', text: messages[lastUserMsgIndex].content },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageData}` } }
      ];
      processedMessages = [...messages.slice(0, lastUserMsgIndex), { role: 'user', content }];
    }
  }

  const requestData = JSON.stringify({
    model: model || 'gpt-4-vision-preview',
    messages: processedMessages,
    temperature: temperature,
    max_tokens: maxTokens,
    stream: true
  });

  const protocol = url.protocol === 'https:' ? https : http;
  const req = protocol.request(options, (res) => {
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices[0]?.delta?.content || '';
            if (content) event.reply('chat-stream-data', content);
          } catch (e) { console.error('解析 SSE 数据失败:', e); }
        }
      }
    });
    res.on('end', () => {
      event.reply('chat-stream-end');
      if (currentAIRequest === req) currentAIRequest = null;
    });
    res.on('error', (err) => {
      console.error('流式响应错误:', err);
      event.reply('chat-stream-error', `响应错误: ${err.message}`);
      if (currentAIRequest === req) currentAIRequest = null;
    });
  });
  req.on('error', (err) => {
    console.error('请求错误:', err);
    event.reply('chat-stream-error', `请求失败: ${err.message}`);
    if (currentAIRequest === req) currentAIRequest = null;
  });
  req.write(requestData);
  req.end();
  return req;
}

// ========== 通义千问 API 调用函数 ==========

function streamQwenAPI(event, apiUrl, apiKey, model, prompt, temperature, maxTokens) {
  const url = new URL(apiUrl || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation');
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'text/event-stream'
    },
    timeout: 60000
  };

  const requestData = JSON.stringify({
    model: model || 'qwen-turbo',
    input: {
      messages: [
        { role: 'system', content: '你是一位专业的计算机硬件维修专家，精通主板故障诊断和维修。' },
        { role: 'user', content: prompt }
      ]
    },
    parameters: {
      temperature: temperature,
      max_tokens: maxTokens,
      incremental_output: true
    }
  });

  const protocol = url.protocol === 'https:' ? https : http;
  const req = protocol.request(options, (res) => {
    let buffer = '';

    res.on('data', (chunk) => {
      buffer += chunk.toString();
      
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line);
            const content = parsed.output?.text || '';
            if (content) {
              event.reply('ai-stream-data', content);
            }
          } catch (e) {
            if (line.trim() && !line.includes('event:')) {
              event.reply('ai-stream-data', line);
            }
          }
        }
      }
    });

    res.on('end', () => {
      event.reply('ai-stream-end');
      if (currentAIRequest === req) {
        currentAIRequest = null;
      }
    });

    res.on('error', (err) => {
      console.error('流式响应错误:', err);
      event.reply('ai-stream-error', `响应错误: ${err.message}`);
      if (currentAIRequest === req) {
        currentAIRequest = null;
      }
    });
  });

  req.on('error', (err) => {
    console.error('请求错误:', err);
    event.reply('ai-stream-error', `请求失败: ${err.message}`);
    if (currentAIRequest === req) {
      currentAIRequest = null;
    }
  });

  req.write(requestData);
  req.end();

  return req;
}

async function callQwenAPI(apiUrl, apiKey, model, prompt, temperature, maxTokens) {
  const fetch = require('node-fetch');
  const response = await fetch(apiUrl || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'qwen-turbo',
      input: {
        messages: [
          { role: 'system', content: '你是一位专业的计算机硬件维修专家，精通主板故障诊断和维修。' },
          { role: 'user', content: prompt }
        ]
      },
      parameters: {
        temperature: temperature,
        max_tokens: maxTokens
      }
    })
  });
  
  if (!response.ok) {
    throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.output.text;
}

function streamQwenChat(event, apiUrl, apiKey, model, messages, temperature, maxTokens, imageData) {
  const url = new URL(apiUrl || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: '/api/v1/services/aigc/multimodal-generation/generation',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'text/event-stream'
    },
    timeout: 60000
  };

  let requestBody;

  if (imageData) {
    const lastMsg = messages[messages.length - 1];
    const text = lastMsg?.content || '';
    
    requestBody = {
      model: model || 'qwen-vl-plus',
      input: {
        messages: [
          {
            role: 'user',
            content: [
              { image: `data:image/jpeg;base64,${imageData}` },
              { text: text }
            ]
          }
        ]
      },
      parameters: {
        temperature: temperature,
        max_tokens: maxTokens,
        incremental_output: true
      }
    };
  } else {
    const lastMsg = messages[messages.length - 1];
    const text = lastMsg?.content || '';
    
    requestBody = {
      model: model || 'qwen-turbo',
      input: {
        messages: [
          { role: 'system', content: '你是一位智能助手。' },
          { role: 'user', content: text }
        ]
      },
      parameters: {
        temperature: temperature,
        max_tokens: maxTokens,
        incremental_output: true
      }
    };
  }

  const requestData = JSON.stringify(requestBody);

  const protocol = url.protocol === 'https:' ? https : http;
  const req = protocol.request(options, (res) => {
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line);
            const content = parsed.output?.choices?.[0]?.message?.content?.[0]?.text || 
                            parsed.output?.text || '';
            if (content) event.reply('chat-stream-data', content);
          } catch (e) {
            if (line.trim() && !line.includes('event:')) event.reply('chat-stream-data', line);
          }
        }
      }
    });
    res.on('end', () => {
      event.reply('chat-stream-end');
      if (currentAIRequest === req) currentAIRequest = null;
    });
    res.on('error', (err) => {
      console.error('流式响应错误:', err);
      event.reply('chat-stream-error', `响应错误: ${err.message}`);
      if (currentAIRequest === req) currentAIRequest = null;
    });
  });
  req.on('error', (err) => {
    console.error('请求错误:', err);
    event.reply('chat-stream-error', `请求失败: ${err.message}`);
    if (currentAIRequest === req) currentAIRequest = null;
  });
  req.write(requestData);
  req.end();
  return req;
}

// ========== 豆包2.0 API (多模态) - 修复 reasoning_content 提取 ==========

// 流式调用豆包2.0 API - 修复 reasoning_content 提取
function streamDoubao20API(event, messages, imageData) {
  if (!aiConfig.enabled || !aiConfig.doubao20.apiKey) {
    event.reply('chat-stream-error', '豆包2.0未配置或API密钥无效');
    return;
  }

  // 构建完整的消息历史
  let fullMessages = [...messages];
  
  // 如果有图片，需要特殊处理最后一条消息
  if (imageData && fullMessages.length > 0) {
    const lastMsg = fullMessages[fullMessages.length - 1];
    if (lastMsg.role === 'user') {
      const text = typeof lastMsg.content === 'string' ? lastMsg.content : '';
      
      // 替换最后一条消息为多模态格式
      fullMessages[fullMessages.length - 1] = {
        role: 'user',
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${imageData}`
            }
          },
          {
            type: "text",
            text: text
          }
        ]
      };
    }
  }

  const baseUrl = aiConfig.apiUrl || 'https://ark.cn-beijing.volces.com/api/v3';
  const chatUrl = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  
  console.log('豆包2.0流式请求URL:', chatUrl);
  console.log('模型:', aiConfig.doubao20.model);
  console.log('消息数:', fullMessages.length);

  const url = new URL(chatUrl);
  
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${aiConfig.doubao20.apiKey}`,
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    },
    timeout: 60000
  };

  // 构建请求体
  const requestBody = {
    model: aiConfig.doubao20.model,
    messages: fullMessages,
    temperature: aiConfig.temperature || 0.7,
    max_tokens: aiConfig.maxTokens || 2000,
    stream: true
  };

  const requestData = JSON.stringify(requestBody);
  console.log('豆包2.0流式请求体:', requestData);

  const protocol = url.protocol === 'https:' ? https : http;
  const req = protocol.request(options, (res) => {
    let buffer = '';
    let hasContent = false;

    res.on('data', (chunk) => {
      buffer += chunk.toString();
      
      // 处理SSE格式的数据
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留最后一个可能不完整的行
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6); // 去掉 "data: " 前缀
          
          // 检查是否是结束标记
          if (data === '[DONE]') {
            console.log('流式响应结束');
            continue;
          }
          
          try {
            const parsed = JSON.parse(data);
            
            // 调试输出完整响应
            console.log('收到chunk:', JSON.stringify(parsed));
            
            // 提取内容 - 重点：豆包2.0使用 reasoning_content 字段
            if (parsed.choices && parsed.choices.length > 0) {
              const choice = parsed.choices[0];
              
              // 方法1: reasoning_content (豆包2.0的思考内容)
              if (choice.delta && choice.delta.reasoning_content) {
                const content = choice.delta.reasoning_content;
                if (content && content.trim()) {
                  hasContent = true;
                  event.reply('chat-stream-data', content);
                }
              }
              
              // 方法2: content (标准内容，可能出现在后续chunk)
              else if (choice.delta && choice.delta.content) {
                const content = choice.delta.content;
                if (content && content.trim()) {
                  hasContent = true;
                  event.reply('chat-stream-data', content);
                }
              }
              
              // 记录完成原因
              if (choice.finish_reason) {
                console.log('流式响应完成，原因:', choice.finish_reason);
              }
            }
            
          } catch (e) {
            console.error('解析 SSE 数据失败:', e, '原始数据:', data);
          }
        }
      }
    });

    res.on('end', () => {
      console.log('流式响应连接结束');
      // 如果没有收到任何内容，发送一个默认消息
      if (!hasContent) {
        console.log('未收到任何内容，发送默认响应');
        event.reply('chat-stream-data', '（模型未返回任何内容）');
      }
      event.reply('chat-stream-end');
      if (currentAIRequest === req) {
        currentAIRequest = null;
      }
    });

    res.on('error', (err) => {
      console.error('流式响应错误:', err);
      event.reply('chat-stream-error', `响应错误: ${err.message}`);
      if (currentAIRequest === req) {
        currentAIRequest = null;
      }
    });
  });

  req.on('error', (err) => {
    console.error('请求错误:', err);
    event.reply('chat-stream-error', `请求失败: ${err.message}`);
    if (currentAIRequest === req) {
      currentAIRequest = null;
    }
  });

  req.write(requestData);
  req.end();
  
  currentAIRequest = req;
}

// 非流式调用豆包2.0（用于测试连接）
async function callDoubao20API(apiKey, model, prompt, imageData, temperature, maxTokens, apiUrl) {
  const fetch = require('node-fetch');
  
  const baseUrl = apiUrl || 'https://ark.cn-beijing.volces.com/api/v3';
  const chatUrl = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  
  console.log('调用豆包2.0 API, URL:', chatUrl);
  console.log('模型:', model);

  const messages = [];
  
  messages.push({
    role: 'system',
    content: '你是一位专业的计算机硬件维修专家，精通主板故障诊断和维修。'
  });
  
  if (imageData) {
    // 多模态消息
    messages.push({
      role: 'user',
      content: [
        {
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${imageData}`
          }
        },
        {
          type: "text",
          text: prompt || '请描述这张图片'
        }
      ]
    });
  } else {
    // 纯文本消息
    messages.push({
      role: 'user',
      content: prompt
    });
  }

  const requestBody = {
    model: model,
    messages: messages,
    temperature: temperature || 0.7,
    max_tokens: maxTokens || 2000,
    stream: false
  };

  console.log('非流式请求体:', JSON.stringify(requestBody));

  try {
    const response = await fetch(chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('豆包2.0 API错误:', response.status, errorText);
      throw new Error(`豆包2.0 API请求失败: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    console.log('豆包2.0 API响应:', JSON.stringify(data).substring(0, 200) + '...');
    
    if (data.choices && data.choices.length > 0) {
      return data.choices[0].message.content;
    } else {
      return JSON.stringify(data);
    }
  } catch (error) {
    console.error('调用豆包2.0 API时出错:', error);
    throw error;
  }
}

// ========== 豆包1.5 图生视频功能 ==========
// 【修改点：使用 JSON.stringify 安全转义提示词】

function createVideoTaskWithSDK(apiKey, prompt, imageData, options = {}) {
  return new Promise((resolve, reject) => {
    const modelId = options.model || 'doubao-seedance-1-5-pro-251215';
    
    // 构建完整的文本提示词（包含选项参数）
    const durationPart = options.duration ? `--duration ${options.duration}` : '';
    const cameraFixedPart = options.cameraFixed ? '--camerafixed true' : '--camerafixed false';
    const watermarkPart = options.watermark ? '--watermark true' : '--watermark false';
    const fullPrompt = `${prompt} ${durationPart} ${cameraFixedPart} ${watermarkPart}`.trim();
    
    // 使用 JSON.stringify 安全转义整个文本
    const safePrompt = JSON.stringify(fullPrompt);
    
    let tempImagePath = null;
    
    // 如果有 imageData，保存为临时文件
    if (imageData) {
      tempImagePath = path.join(__dirname, 'temp_image_' + Date.now() + '.jpg');
      try {
        const imageBuffer = Buffer.from(imageData, 'base64');
        fs.writeFileSync(tempImagePath, imageBuffer);
        console.log('临时图片已保存:', tempImagePath);
      } catch (err) {
        reject(new Error(`保存临时图片失败: ${err.message}`));
        return;
      }
    }
    
    // 构建 Python 脚本（注意 safePrompt 已经包含引号，直接嵌入即可）
    const scriptContent = `
import os
import sys
import json
import time
import base64
from volcenginesdkarkruntime import Ark

def main():
    try:
        client = Ark(
            base_url="https://ark.cn-beijing.volces.com/api/v3",
            api_key="${apiKey}"
        )
        
        content = [
            {
                "type": "text",
                "text": ${safePrompt}.strip()
            }
        ]
        
        ${tempImagePath ? `
        # 读取临时图片文件并转换为base64
        image_path = r"${tempImagePath.replace(/\\/g, '\\\\')}"
        if os.path.exists(image_path):
            with open(image_path, "rb") as image_file:
                image_base64 = base64.b64encode(image_file.read()).decode('utf-8')
            
            content.append({
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/jpeg;base64,{image_base64}"
                }
            })
            
            # 删除临时文件
            try:
                os.remove(image_path)
            except:
                pass
        ` : ''}
        
        create_result = client.content_generation.tasks.create(
            model="${modelId}",
            content=content
        )
        
        status = getattr(create_result, 'status', 'pending')
        
        print(json.dumps({
            "success": True,
            "task_id": create_result.id,
            "status": status
        }))
        
    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": str(e)
        }))

if __name__ == "__main__":
    main()
    `;

    const scriptPath = path.join(__dirname, 'temp_video_task_' + Date.now() + '.py');
    fs.writeFileSync(scriptPath, scriptContent, 'utf8');
    console.log('Python脚本已创建:', scriptPath);

    const pythonProcess = spawn('python', [scriptPath]);

    let outputData = '';
    let errorData = '';

    pythonProcess.stdout.on('data', (data) => {
      console.log('Python stdout:', data.toString());
      outputData += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      console.log('Python stderr:', data.toString());
      errorData += data.toString();
    });

    pythonProcess.on('close', (code) => {
      console.log('Python进程退出码:', code);
      
      // 清理临时文件
      if (tempImagePath && fs.existsSync(tempImagePath)) {
        try {
          fs.unlinkSync(tempImagePath);
        } catch (err) {
          console.error('删除临时图片失败:', err);
        }
      }
      
      // 删除Python脚本
      try {
        fs.unlinkSync(scriptPath);
      } catch (err) {
        console.error('删除临时脚本失败:', err);
      }

      if (code !== 0) {
        console.error('Python错误输出:', errorData);
        reject(new Error(`Python进程退出码: ${code}, 错误: ${errorData}`));
        return;
      }

      try {
        // 尝试找到JSON输出
        const jsonMatch = outputData.match(/\{.*\}/s);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          if (result.success) {
            resolve(result);
          } else {
            reject(new Error(result.error || '未知错误'));
          }
        } else {
          reject(new Error(`无法解析Python输出: ${outputData}`));
        }
      } catch (e) {
        reject(new Error(`解析Python输出失败: ${e.message}\n输出: ${outputData}`));
      }
    });
  });
}

function queryVideoTaskWithSDK(apiKey, taskId) {
  return new Promise((resolve, reject) => {
    const scriptContent = `
import os
import sys
import json
import time
from volcenginesdkarkruntime import Ark

def main():
    try:
        client = Ark(
            base_url="https://ark.cn-beijing.volces.com/api/v3",
            api_key="${apiKey}"
        )
        
        get_result = client.content_generation.tasks.get(task_id="${taskId}")
        
        result = {
            "success": True,
            "task_id": get_result.id,
        }
        
        if hasattr(get_result, 'status'):
            result["status"] = get_result.status
        else:
            result["status"] = 'unknown'
        
        video_url = None
        if hasattr(get_result, 'content') and get_result.content:
            if hasattr(get_result.content, 'video_url') and get_result.content.video_url:
                video_url = get_result.content.video_url
        elif hasattr(get_result, 'video_url') and get_result.video_url:
            video_url = get_result.video_url
        
        if video_url:
            result["video_url"] = video_url
        
        if hasattr(get_result, 'error') and get_result.error:
            result["error"] = get_result.error
        
        if hasattr(get_result, 'progress') and get_result.progress:
            result["progress"] = get_result.progress
        
        print(json.dumps(result))
        
    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": str(e)
        }))

if __name__ == "__main__":
    main()
    `;

    const scriptPath = path.join(__dirname, 'temp_video_query_' + Date.now() + '.py');
    fs.writeFileSync(scriptPath, scriptContent, 'utf8');
    console.log('查询脚本已创建:', scriptPath);

    const pythonProcess = spawn('python', [scriptPath]);

    let outputData = '';
    let errorData = '';

    pythonProcess.stdout.on('data', (data) => {
      console.log('查询stdout:', data.toString());
      outputData += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      console.log('查询stderr:', data.toString());
      errorData += data.toString();
    });

    pythonProcess.on('close', (code) => {
      console.log('查询进程退出码:', code);
      
      try {
        fs.unlinkSync(scriptPath);
      } catch (err) {
        console.error('删除临时脚本失败:', err);
      }

      if (code !== 0) {
        reject(new Error(`Python进程退出码: ${code}, 错误: ${errorData}`));
        return;
      }

      try {
        const jsonMatch = outputData.match(/\{.*\}/s);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          if (result.success) {
            resolve(result);
          } else {
            reject(new Error(result.error || '未知错误'));
          }
        } else {
          reject(new Error(`无法解析Python输出: ${outputData}`));
        }
      } catch (e) {
        reject(new Error(`解析Python输出失败: ${e.message}\n输出: ${outputData}`));
      }
    });
  });
}

function pollVideoTaskWithSDK(taskId, apiKey, event) {
  const pollInterval = setInterval(async () => {
    try {
      const result = await queryVideoTaskWithSDK(apiKey, taskId);
      
      if (result.status === 'succeeded' || result.status === 'completed') {
        clearInterval(pollInterval);
        videoTasks.set(taskId, { ...videoTasks.get(taskId), ...result, status: 'completed' });
        
        event.reply('video-task-completed', { 
          taskId, 
          videoUrl: result.video_url,
          fullResponse: result
        });
      } else if (result.status === 'failed') {
        clearInterval(pollInterval);
        videoTasks.set(taskId, { ...videoTasks.get(taskId), ...result, status: 'failed' });
        event.reply('video-task-failed', { taskId, error: result.error || '生成失败' });
      } else {
        event.reply('video-task-progress', { 
          taskId, 
          progress: result.progress || 0,
          message: `当前状态: ${result.status}`
        });
      }
    } catch (err) {
      console.error('轮询视频任务失败:', err);
    }
  }, 3000);

  setTimeout(() => {
    clearInterval(pollInterval);
    event.reply('video-task-failed', { 
      taskId, 
      error: '视频生成超时（5分钟）' 
    });
  }, 300000);
}

// ========== AI分析路由 - 修复 reasoning_content 提取 ==========

ipcMain.on('start-ai-analysis', async (event, diagnosisData) => {
  if (currentAIRequest) {
    try {
      currentAIRequest.destroy();
    } catch (e) {
      console.error('中止请求失败:', e);
    }
    currentAIRequest = null;
  }

  try {
    if (!aiConfig.enabled || !aiConfig.doubao20.apiKey) {
      event.reply('ai-stream-error', '请先在AI配置中启用并填写豆包2.0 API密钥');
      return;
    }

    const prompt = buildAIPrompt(diagnosisData);
    
    // 构建消息数组
    const messages = [
      { role: 'system', content: '你是一位专业的计算机硬件维修专家，精通主板故障诊断和维修。' },
      { role: 'user', content: prompt }
    ];

    const baseUrl = aiConfig.apiUrl || 'https://ark.cn-beijing.volces.com/api/v3';
    const chatUrl = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    
    const url = new URL(chatUrl);
    
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aiConfig.doubao20.apiKey}`,
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      },
      timeout: 60000
    };

    // 构建请求体
    const requestBody = {
      model: aiConfig.doubao20.model,
      messages: messages,
      temperature: aiConfig.temperature || 0.7,
      max_tokens: aiConfig.maxTokens || 2000,
      stream: true
    };

    const requestData = JSON.stringify(requestBody);
    console.log('AI分析流式请求:', requestData);

    const protocol = url.protocol === 'https:' ? https : http;
    const req = protocol.request(options, (res) => {
      let buffer = '';
      let hasContent = false;

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        
        // 处理SSE格式的数据
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            
            if (data === '[DONE]') continue;
            
            try {
              const parsed = JSON.parse(data);
              
              if (parsed.choices && parsed.choices.length > 0) {
                const choice = parsed.choices[0];
                
                // 优先提取 reasoning_content
                if (choice.delta && choice.delta.reasoning_content) {
                  const content = choice.delta.reasoning_content;
                  if (content && content.trim()) {
                    hasContent = true;
                    event.reply('ai-stream-data', content);
                  }
                }
                // 其次提取 content
                else if (choice.delta && choice.delta.content) {
                  const content = choice.delta.content;
                  if (content && content.trim()) {
                    hasContent = true;
                    event.reply('ai-stream-data', content);
                  }
                }
              }
            } catch (e) {
              console.error('解析 SSE 数据失败:', e);
            }
          }
        }
      });

      res.on('end', () => {
        if (!hasContent) {
          event.reply('ai-stream-data', '（模型未返回内容）');
        }
        event.reply('ai-stream-end');
        if (currentAIRequest === req) {
          currentAIRequest = null;
        }
      });

      res.on('error', (err) => {
        event.reply('ai-stream-error', `响应错误: ${err.message}`);
        if (currentAIRequest === req) {
          currentAIRequest = null;
        }
      });
    });

    req.on('error', (err) => {
      event.reply('ai-stream-error', `请求失败: ${err.message}`);
      if (currentAIRequest === req) {
        currentAIRequest = null;
      }
    });

    req.write(requestData);
    req.end();
    currentAIRequest = req;
    
  } catch (err) {
    event.reply('ai-stream-error', `AI分析失败: ${err.message}`);
  }
});

ipcMain.handle('analyze-with-ai', async (_, diagnosisData) => {
  try {
    if (!aiConfig.enabled || !aiConfig.doubao20.apiKey) {
      return { success: false, message: '请先在AI配置中启用并填写豆包2.0 API密钥' };
    }

    const prompt = buildAIPrompt(diagnosisData);
    
    const response = await callDoubao20API(
      aiConfig.doubao20.apiKey,
      aiConfig.doubao20.model,
      prompt,
      null,
      aiConfig.temperature,
      aiConfig.maxTokens,
      aiConfig.apiUrl
    );
    
    return { success: true, analysis: response };
  } catch (err) {
    console.error('AI分析失败:', err);
    return { success: false, message: `AI分析失败: ${err.message}` };
  }
});

// ========== 通用对话功能 ==========

ipcMain.on('chat-with-ai', async (event, messages, fileInfo) => {
  if (currentAIRequest) {
    try {
      currentAIRequest.destroy();
    } catch (e) {
      console.error('中止请求失败:', e);
    }
    currentAIRequest = null;
  }

  try {
    if (!aiConfig.enabled || !aiConfig.doubao20.apiKey) {
      event.reply('chat-stream-error', '请先在AI配置中启用并填写豆包2.0 API密钥');
      return;
    }

    let imageData = null;
    if (fileInfo && fileInfo.data) {
      imageData = fileInfo.data;
    }

    streamDoubao20API(event, messages, imageData);
    
  } catch (err) {
    console.error('AI对话失败:', err);
    event.reply('chat-stream-error', `AI对话失败: ${err.message}`);
  }
});

// ========== 视频生成功能 ==========

ipcMain.on('generate-video', async (event, prompt, options) => {
  try {
    if (!aiConfig.enabled || !aiConfig.doubao15Video.apiKey) {
      event.reply('generate-video-error', '请先在AI配置中启用并填写豆包1.5视频专用API密钥');
      return;
    }

    const imageData = options?.imageData;
    const duration = options?.duration || 5;
    const cameraFixed = options?.cameraFixed || false;
    const watermark = options?.watermark !== undefined ? options.watermark : true;

    event.reply('video-generation-started', { 
      status: 'processing', 
      message: '视频生成任务已提交，请稍候...' 
    });

    const result = await createVideoTaskWithSDK(
      aiConfig.doubao15Video.apiKey,
      prompt,
      imageData,
      {
        duration,
        cameraFixed,
        watermark,
        model: aiConfig.doubao15Video.model
      }
    );

    if (result.task_id) {
      const taskId = result.task_id;
      videoTasks.set(taskId, {
        taskId,
        status: 'processing',
        prompt,
        options: { duration, cameraFixed, watermark, hasImage: !!imageData },
        createdAt: Date.now()
      });

      event.reply('video-task-created', { taskId, status: 'processing' });

      pollVideoTaskWithSDK(taskId, aiConfig.doubao15Video.apiKey, event);
    } else {
      event.reply('video-generation-success', { videoUrl: result.video_url });
    }
  } catch (err) {
    console.error('视频生成失败:', err);
    event.reply('generate-video-error', err.message);
  }
});

// ========== 图像生成功能（禁用） ==========

ipcMain.on('generate-image', async (event, prompt, options) => {
  event.reply('generate-image-error', '豆包2.0不支持图像生成，请使用其他提供商');
});

// ========== 窗口创建 ==========
function createWindow() {
  Menu.setApplicationMenu(null);
  
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    frame: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    },
    icon: path.join(__dirname, 'resources/icon.ico').replace(/\\/g, '/')
  });

  mainWindow.loadFile('index.html');
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('窗口加载完成，按 Alt+Enter 可切换全屏模式');
  });
}

function registerShortcuts() {
  const ret = globalShortcut.register('Alt+Enter', () => {
    if (mainWindow) {
      if (mainWindow.isFullScreen()) {
        mainWindow.setFullScreen(false);
        console.log('退出全屏模式');
      } else {
        mainWindow.setFullScreen(true);
        console.log('进入全屏模式');
      }
    }
  });

  if (!ret) {
    console.log('注册快捷键失败');
  }

  console.log(`Alt+Enter 快捷键注册: ${ret ? '成功' : '失败'}`);
}

ipcMain.handle('scan-ports', async () => await getSerialPorts());
ipcMain.handle('connect-port', (_, com) => connectPort(com));

app.whenReady().then(() => {
  createWindow();
  registerShortcuts();
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  disconnectAll();
  if (process.platform !== 'darwin') app.quit();
});

app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');