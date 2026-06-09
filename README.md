# 🔧 主板故障诊断卡桌面客户端

<div align="center">

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/Electron-25.9.8-brightgreen)
![License](https://img.shields.io/badge/license-MIT-green)
![Status](https://img.shields.io/badge/status-stable-orange)

### 🛠️ 技术栈 / Tech Stack

![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)
![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white)

**奇冠 V8 主板诊断卡的非官方桌面客户端 | 技能大赛参赛作品**

</div>

## 📖 项目背景

这个项目的诞生源于一次技能大赛。比赛中需要使用一款**奇冠 V8** 品牌的主板诊断卡，但这张卡有几个问题：

- 🔌 硬件做工粗糙，裸露主板，连外壳都没有
- 📱 配套的手机 APP 还是 Android 4/5 时代的产物
- 🎨 UI 和交互逻辑极其简陋
- 💰 价格还不便宜（大几百块）

比赛需要用到诊断卡的**诊断码读取功能**，但原厂软件的体验实在让人无法接受。于是我在比赛期间逆向分析了诊断卡的通信协议，用 Electron 重构了一个桌面客户端。
<img width="1919" height="1052" alt="image" src="https://github.com/user-attachments/assets/e94f861f-eba3-4e81-9b04-4f5336610556" />
<img width="1915" height="1051" alt="image" src="https://github.com/user-attachments/assets/b0c1c6ce-49e7-416b-91f8-31104dd150a0" />

> ⚠️ **重要说明**：本项目是**非官方**客户端，需要配合**奇冠 V8 蓝牙主板诊断卡**硬件使用。如果您没有这张卡，程序可以运行但无法进行实际诊断（会显示模拟数据）。

## 🎯 项目做了什么

| 原厂软件问题 | 本项目的改进 |
|-------------|-------------|
| Android 4/5 老应用 | Windows 桌面客户端 |
| 界面老旧丑陋 | 现代化 UI + 深色主题 |
| 功能单一 | 添加 AI 分析、对话、视频生成 |
| 无扩展性 | 支持配置大模型 API |
| 蓝牙连接不稳定 | 重构连接逻辑 |

## ✨ 功能特点

### 核心功能（逆向还原）
- 🔌 **蓝牙串口连接** - 连接奇冠 V8 诊断卡，读取故障码
- 📊 **实时诊断** - 显示 POST 诊断码及含义
- 🩺 **故障码解析** - 内置 1000+ 故障码数据库

### 新增功能（本项目的价值）
- 🤖 **AI 诊断分析** - 连接大模型 API，生成诊断报告
- 💬 **智能对话** - 多模态对话，可上传图片识别
- 🎬 **视频生成** - 接入豆包 API 的图生视频功能
- 🎨 **深色/浅色主题** - 一键切换

## 🔧 硬件要求

| 硬件 | 说明 |
|------|------|
| **奇冠 V8 蓝牙主板诊断卡** | 必需，本项目仅对此卡适配 |
| 待检测主板 | 需有 PCI 或 USB 接口 |
| 蓝牙适配器 | 电脑需支持蓝牙 |

## 🚀 快速开始

### 方式一：下载安装包（推荐普通用户）

1. 前往 [Releases](https://github.com/Prunights/computer-diagnostic-platform/releases) 页面
2. 下载最新版本安装程序
3. 安装后运行，连接诊断卡即可使用

### 方式二：从源码构建（推荐开发者）

```bash
# 克隆项目
git clone https://github.com/Prunights/computer-diagnostic-platform.git
cd computer-diagnostic-platform

# 安装依赖
npm install

# 运行开发版本
npm start

# 打包成可执行文件
npm run pack

```

## 🛠️ 构建指南

> 以下内容仅适用于从源码构建的情况

### 环境要求

| 组件 | 版本 |
|------|------|
| Node.js | v16+ |
| Python | v3.8+（serialport 编译需要） |
| VS Build Tools | 2022（C++ 桌面开发） |

### 常见构建问题

| 问题 | 解决方案 |
|------|----------|
| Electron 下载失败 | 删除 `node_modules/electron`，运行 `npm install electron` |
| serialport 编译报错 | 安装 VS Build Tools 后，运行 `npm install --build-from-source` |
| Python 找不到 | `npm config set python python3` |

### 打包产物

打包完成后，产物在 `release/` 目录：

- `主板故障诊断平台 Setup 1.0.0.exe` - 安装程序
- `win-unpacked/` - 免安装版文件夹

## 🤖 AI 功能配置

程序支持配置大模型 API，推荐使用：

- **豆包 2.0**（对话/分析模型）
- **豆包 1.5**（视频生成模型）
- **DeepSeek**（备选）

### 配置步骤

1. 运行程序，进入 **"AI配置"** 面板
2. 填写 API 密钥
3. 选择对应的模型
4. 点击 **"保存配置"**
5. 点击 **"测试连接"** 验证

### 模型参数说明

| 参数 | 说明 | 推荐值 |
|------|------|--------|
| 温度 | 控制创造性，越高越随机 | 0.7 |
| 最大 Token | 单次回复最大长度 | 2000 |

## 📁 项目结构
```
computer-diagnostic-platform/
├── main.js # Electron 主进程
├── preload.js # 预加载脚本（安全桥接）
├── index.html # 主界面
├── faultCodes.js # 故障码数据库（逆向所得，1000+ 条）
├── package.json # 项目配置
├── package-lock.json # 依赖锁定
├── resources/ # 资源文件
│ └── icon_fixed.ico # 应用程序图标
├── release/ # 构建产物（git忽略）
└── node_modules/ # 依赖包（git忽略）
```
## 🤖 AI 生成说明

本项目的大部分代码（包括但不限于 UI 界面、交互逻辑、AI 集成等）均由 **AI 辅助生成**。

- 核心逆向逻辑（故障码读取、串口通信）为手动编写
- 前端界面、样式、动画效果由 AI 生成并调整
- AI 功能集成（豆包 API、DeepSeek 等）由 AI 辅助完成
- 故障码数据库（faultCodes.js）为手动整理
  
## ❓ 常见问题

### Q1: 没有诊断卡能用吗？
**A:** 程序可以运行，但诊断功能会显示模拟数据。真正的诊断码读取需要配合奇冠 V8 诊断卡硬件使用。

### Q2: 支持其他品牌的诊断卡吗？
**A:** 目前仅适配奇冠 V8，因为我是逆向分析它的通信协议实现的。其他品牌没有测试过。

### Q3: 这个诊断卡真的智能吗？
**A:** 硬件本身并不智能，就是读取 POST 诊断码的老式设备。"智能"是比赛时的命题要求，本项目通过添加 AI 分析功能让它变得"智能"一些。

### Q4: 为什么还要用这么老的诊断方式？
**A:** 这是比赛指定的硬件，我也没有选择。现代主板大多有更先进的诊断方式，但这个项目是为了满足比赛需求。

### Q5: 蓝牙串口扫描不到设备？
**A:** 
1. 确保诊断卡已开机并配对
2. 以**管理员身份**运行程序
3. 检查设备管理器中是否有对应 COM 口

### Q6: AI 分析无响应？
**A:** 
1. 检查 API 密钥是否正确
2. 确认已开启"启用AI分析"开关
3. 检查网络连接


## ⚠️ 免责声明

- 本项目是**非官方**客户端，与广州奇冠公司无关
- 奇冠 V8 诊断卡的硬件和原厂软件版权归原厂商所有
- 本项目仅用于学习交流和技术展示
- 技能大赛参赛作品，功能以满足比赛需求为主

## 📄 许可证
本项目采用 MIT 许可证：

```
MIT License

Copyright (c) 2026 Prunight

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 👥 作者
Prunight


## 🙏 致谢
Electron - 跨平台桌面框架

SerialPort - 串口通信库

豆包大模型 - AI 能力支持

Font Awesome - 图标库

## 📞 联系方式
GitHub Issues
 或 email：509958501@qq.com

<div align="center"> Made with ❤️ for a competition project </div>
