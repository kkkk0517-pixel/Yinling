// Windows 不提供 Unix 信号投递；仅测试中用 IPC 触发实际入口注册的停机处理器。
process.on('message',message=>{if(message?.type==='stop-test-server')process.emit('SIGTERM');});
