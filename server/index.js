// Điều hướng sang server.js
// Đây là wrapper chỉ để tương thích với cấu trúc cũ

const { spawn } = require('child_process');
const path = require('path');

console.log("index.js is deprecated. Starting server.js instead...");

// Khởi chạy server.js
const serverProcess = spawn('node', [path.join(__dirname, 'server.js')], {
  stdio: 'inherit',
  env: process.env
});

// Xử lý khi server.js thoát
serverProcess.on('close', (code) => {
  console.log(`server.js exited with code ${code}`);
  process.exit(code);
});

// Xử lý khi quá trình index.js bị kill
process.on('SIGINT', () => {
  console.log('SIGINT received. Forwarding to server.js');
  serverProcess.kill('SIGINT');
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Forwarding to server.js');
  serverProcess.kill('SIGTERM');
});
