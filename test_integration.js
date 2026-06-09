const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// 测试函数：直接调用 Python 脚本
function testPythonSDK() {
  const testScript = `
import sys
import json
try:
    from volcenginesdkarkruntime import Ark
    print(json.dumps({"success": True, "message": "SDK导入成功"}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;

  const scriptPath = path.join(__dirname, 'test_sdk_import.py');
  fs.writeFileSync(scriptPath, testScript);

  const pythonProcess = spawn('python', [scriptPath]);
  let output = '';

  pythonProcess.stdout.on('data', (data) => {
    output += data.toString();
  });

  pythonProcess.stderr.on('data', (data) => {
    console.error('Python错误:', data.toString());
  });

  pythonProcess.on('close', (code) => {
    fs.unlinkSync(scriptPath);
    try {
      const result = JSON.parse(output);
      console.log('测试结果:', result);
      if (result.success) {
        console.log('✅ Python SDK 导入成功，可以继续开发');
      } else {
        console.error('❌ Python SDK 导入失败:', result.error);
      }
    } catch (e) {
      console.error('解析输出失败:', output);
    }
  });
}

testPythonSDK();